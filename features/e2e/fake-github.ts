import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { json, refusal, serve, type Answer, type Asked, type Route, type Served } from './fake-http.ts';

const sandboxCheck = 'sandbox';

const ciWaitMs = 900_000;
const gitWaitMs = 60_000;
const kept = 64_000;
const zero = '0'.repeat(40);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const identity = { GIT_AUTHOR_NAME: 'Fake GitHub', GIT_AUTHOR_EMAIL: 'fake-github@example.com', GIT_COMMITTER_NAME: 'Fake GitHub', GIT_COMMITTER_EMAIL: 'fake-github@example.com' };

type Ran = { readonly code: number; readonly out: string; readonly err: string };

type RunOptions = { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly input?: string; readonly timeoutMs: number; readonly signal: AbortSignal };

function runProcess(file: string, args: readonly string[], options: RunOptions): Promise<Ran> {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-kept);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-kept);
    });
    child.on('error', error => {
      resolve({ code: 1, out, err: `${err}${error.message}` });
    });
    child.on('close', code => {
      resolve({ code: code ?? 1, out, err });
    });
    child.stdin.end(options.input ?? '');
  });
}

type CheckRun = {
  readonly id: number;
  readonly sha: string;
  readonly startedAt: string;
  status: 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | null;
  completedAt: string | null;
  log: string;
};

type Status = { readonly state: 'error' | 'failure' | 'pending' | 'success'; readonly context: string; readonly description: string; readonly createdAt: string };

type TimelineEvent = { readonly event: 'ready_for_review' | 'merged'; readonly createdAt: string };

type Pull = {
  readonly number: number;
  readonly nodeId: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  body: string | null;
  draft: boolean;
  merged: { readonly sha: string; readonly head: string; readonly at: string } | null;
  readonly timeline: TimelineEvent[];
};

type State = {
  readonly pulls: Pull[];
  readonly runs: Map<string, CheckRun>;
  readonly statuses: Map<string, Status[]>;
};

export type FakeGitHubSettings = { readonly bare: string; readonly repository: string; readonly token: string };

export type FakeGitHub = Served & { readonly webUrl: string };

const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const validation = (message: string): Answer => json({ message: 'Validation Failed', errors: [{ message }] }, 422);

const graphqlError = (type: string, message: string): Answer => json({ data: null, errors: [{ type, message }] });

const bodies = {
  tree: z.object({ base_tree: sha.optional(), tree: z.array(z.object({ path: z.string().min(1), mode: z.enum(['100644', '100755']), type: z.literal('blob'), content: z.string() })) }),
  commit: z.object({ message: z.string(), tree: sha, parents: z.array(sha) }),
  status: z.object({ state: z.enum(['error', 'failure', 'pending', 'success']), context: z.string().default('default'), description: z.string().default('') }),
  ref: z.object({ ref: z.string().regex(/^refs\/heads\/.+/), sha }),
  move: z.object({ sha, force: z.boolean().default(false) }),
  open: z.object({ title: z.string().min(1), head: z.string().min(1), base: z.string().min(1), body: z.string().nullish(), draft: z.boolean().default(false) }),
  edit: z.object({ title: z.string().optional(), body: z.string().optional() }),
  merge: z.object({ sha: sha.optional(), merge_method: z.literal('merge').default('merge'), commit_title: z.string().optional() }),
  update: z.object({ expected_head_sha: sha.optional() }),
  graphql: z.object({ query: z.string().min(1), variables: z.record(z.string(), z.unknown()).default({}) }),
};

const facts = z.object({ owner: z.string(), name: z.string(), number: z.int(), first: z.int().positive(), answered: z.string().optional(), withAnswered: z.boolean().default(false) });
const contextsAsked = z.object({ owner: z.string(), name: z.string(), oid: sha, first: z.int().positive(), after: z.string().optional() });
const pullAsked = z.object({ id: z.string().min(1) });

const operationOf = (query: string): string | undefined => /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? /^\s*(?:query|mutation)?\s*(?:\([^)]*\))?\s*\{\s*(\w+)/.exec(query)?.[1];

function parsed<T>(schema: z.ZodType<T>, body: unknown, where: string): { readonly ok: T } | { readonly answer: Answer } {
  const read = schema.safeParse(body);
  return read.success ? { ok: read.data } : { answer: validation(`${where}: ${z.prettifyError(read.error)}`) };
}

function page<T>(items: readonly T[], first: number, after: string | undefined) {
  const start = after === undefined || after === '' ? 0 : Number.parseInt(after, 10);
  const end = start + first;
  return { pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? String(end) : null }, nodes: items.slice(start, end) };
}

export async function startFakeGitHub(settings: FakeGitHubSettings): Promise<FakeGitHub> {
  const { bare, repository, token } = settings;
  const [owner = '', name = ''] = repository.split('/');
  const state: State = { pulls: [], runs: new Map(), statuses: new Map() };
  const scratch = await mkdtemp(join(tmpdir(), 'fake-github-'));
  const npmHome = join(scratch, 'home');
  let serial = 0;
  const stopping = new AbortController();
  const testing = new Set<Promise<void>>();
  const holder: { web: string } = { web: '' };

  const git = (args: readonly string[], input?: string, env: Readonly<Record<string, string>> = {}): Promise<Ran> =>
    runProcess('git', [`--git-dir=${bare}`, ...args], { cwd: scratch, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: scratch, ...identity, ...env }, timeoutMs: gitWaitMs, signal: stopping.signal, ...(input === undefined ? {} : { input }) });

  const gitOut = async (args: readonly string[], input?: string, env?: Readonly<Record<string, string>>): Promise<string> => {
    const ran = await git(args, input, env);
    if (ran.code !== 0) throw new Error(`git ${args.join(' ')} exited ${String(ran.code)}: ${ran.err.trim()}`);
    return ran.out.trim();
  };

  const headOf = async (branch: string): Promise<string | undefined> => {
    const ran = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return ran.code === 0 ? ran.out.trim() : undefined;
  };

  const commitOf = async (ref: string): Promise<string | undefined> => {
    const ran = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return ran.code === 0 ? ran.out.trim() : undefined;
  };

  const isAncestor = async (older: string, newer: string): Promise<boolean> => (await git(['merge-base', '--is-ancestor', older, newer])).code === 0;

  const mergedTree = async (ours: string, theirs: string): Promise<string | undefined> => {
    const ran = await git(['merge-tree', '--write-tree', ours, theirs]);
    return ran.code === 0 ? ran.out.split('\n')[0]?.trim() : undefined;
  };

  const runLink = (run: CheckRun): string => `${holder.web}/actions/runs/${String(run.id)}`;

  async function test(run: CheckRun): Promise<void> {
    const folder = await mkdtemp(join(scratch, 'ci-'));
    const archive = join(scratch, `ci-${String(run.id)}.tar`);
    try {
      await gitOut(['archive', '--format=tar', `--output=${archive}`, run.sha]);
      const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: npmHome, CI: 'true', LANG: 'C.UTF-8' };
      const untar = await runProcess('tar', ['-xf', archive, '-C', folder], { cwd: scratch, env, timeoutMs: gitWaitMs, signal: stopping.signal });
      const ran = untar.code === 0 ? await runProcess('sh', ['-c', 'npm ci --no-audit --no-fund && npm test'], { cwd: folder, env, timeoutMs: ciWaitMs, signal: stopping.signal }) : untar;
      run.log = `${ran.out}${ran.err}`;
      run.conclusion = ran.code === 0 ? 'success' : 'failure';
    } catch (error) {
      run.log = error instanceof Error ? error.message : String(error);
      run.conclusion = 'failure';
    } finally {
      run.status = 'completed';
      run.completedAt = now();
      await rm(folder, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  }

  const runOf = (commit: string): CheckRun => {
    const found = state.runs.get(commit);
    if (found !== undefined) return found;
    serial += 1;
    const run: CheckRun = { id: serial, sha: commit, startedAt: now(), status: 'in_progress', conclusion: null, completedAt: null, log: '' };
    state.runs.set(commit, run);
    const tested = test(run).finally(() => testing.delete(tested));
    testing.add(tested);
    return run;
  };

  const sandboxOf = (commit: string): 'pending' | 'green' | 'red' => {
    const run = runOf(commit);
    if (run.status !== 'completed') return 'pending';
    return run.conclusion === 'success' ? 'green' : 'red';
  };

  const pullHead = async (pull: Pull): Promise<string> => pull.merged?.head ?? (await headOf(pull.head)) ?? zero;

  const restPull = async (pull: Pull) => {
    const head = await pullHead(pull);
    return {
      number: pull.number,
      node_id: pull.nodeId,
      html_url: `${holder.web}/pull/${String(pull.number)}`,
      title: pull.title,
      body: pull.body,
      state: pull.merged === null ? 'open' : 'closed',
      draft: pull.draft,
      merged_at: pull.merged?.at ?? null,
      merge_commit_sha: pull.merged?.sha ?? null,
      head: { ref: pull.head, sha: head, label: `${owner}:${pull.head}` },
      base: { ref: pull.base, sha: (await headOf(pull.base)) ?? zero },
    };
  };

  const pullNumbered = (text: string | undefined): Pull | undefined => state.pulls.find(pull => String(pull.number) === text);

  const conflicting = async (pull: Pull, head: string): Promise<boolean> => {
    if (pull.merged !== null) return false;
    const base = await headOf(pull.base);
    return base === undefined || (await mergedTree(base, head)) === undefined;
  };

  const mergeStatus = async (pull: Pull, head: string): Promise<string> => {
    if (pull.merged !== null) return 'CLEAN';
    if (pull.draft) return 'DRAFT';
    if (await conflicting(pull, head)) return 'DIRTY';
    return sandboxOf(head) === 'green' ? 'CLEAN' : 'BLOCKED';
  };

  const contextsAt = (commit: string) => {
    const run = runOf(commit);
    return [
      { __typename: 'CheckRun', name: sandboxCheck, status: run.status === 'completed' ? 'COMPLETED' : 'IN_PROGRESS', conclusion: run.conclusion?.toUpperCase() ?? null, startedAt: run.startedAt },
      ...(state.statuses.get(commit) ?? []).map(status => ({ __typename: 'StatusContext', context: status.context, state: status.state.toUpperCase(), createdAt: status.createdAt })),
    ];
  };

  async function pullFacts(variables: unknown): Promise<Answer> {
    const asked = facts.safeParse(variables);
    if (!asked.success) return graphqlError('INVALID_VARIABLES', z.prettifyError(asked.error));
    if (asked.data.owner !== owner || asked.data.name !== name) return graphqlError('NOT_FOUND', `Could not resolve to a Repository with the name '${asked.data.owner}/${asked.data.name}'.`);
    const pull = state.pulls.find(entry => entry.number === asked.data.number);
    if (pull === undefined) return graphqlError('NOT_FOUND', `Could not resolve to a PullRequest with the number of ${String(asked.data.number)}.`);
    const head = await pullHead(pull);
    const first = asked.data.first;
    return json({
      data: {
        repository: {
          pullRequest: {
            id: pull.nodeId,
            number: pull.number,
            url: `${holder.web}/pull/${String(pull.number)}`,
            state: pull.merged === null ? 'OPEN' : 'MERGED',
            isDraft: pull.draft,
            mergeable: (await conflicting(pull, head)) ? 'CONFLICTING' : 'MERGEABLE',
            mergeStateStatus: await mergeStatus(pull, head),
            reviewDecision: null,
            isInMergeQueue: false,
            mergeQueueEntry: null,
            headRefOid: head,
            baseRef: { rules: { nodes: [{ type: 'REQUIRED_STATUS_CHECKS', parameters: { requiredStatusChecks: [{ context: sandboxCheck }] } }] }, branchProtectionRule: null },
            commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: page(contextsAt(head), first, undefined) } } }] },
            latestOpinionatedReviews: page([], first, undefined),
            timelineItems: { nodes: [] },
          },
        },
        ...(asked.data.withAnswered ? { answered: null } : {}),
      },
    });
  }

  function contexts(variables: unknown): Answer {
    const asked = contextsAsked.safeParse(variables);
    if (!asked.success) return graphqlError('INVALID_VARIABLES', z.prettifyError(asked.error));
    return json({ data: { repository: { object: { statusCheckRollup: { contexts: page(contextsAt(asked.data.oid), asked.data.first, asked.data.after) } } } } });
  }

  function ready(variables: unknown): Answer {
    const asked = pullAsked.safeParse(variables);
    const pull = state.pulls.find(entry => entry.nodeId === asked.data?.id);
    if (pull === undefined) return graphqlError('NOT_FOUND', `Could not resolve to a node with the global id of '${asked.data?.id ?? ''}'.`);
    if (pull.merged !== null) return graphqlError('UNPROCESSABLE', 'Pull request is closed.');
    if (pull.draft) {
      pull.draft = false;
      pull.timeline.push({ event: 'ready_for_review', createdAt: now() });
    }
    return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  }

  const operations: Readonly<Record<string, (variables: unknown) => Answer | Promise<Answer>>> = {
    Facts: pullFacts,
    Contexts: contexts,
    Reviews: () => json({ data: { repository: { pullRequest: { latestOpinionatedReviews: page([], 1, undefined) } } } }),
    Comments: () => json({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message: 'The fake GitHub holds no reviews.' }] }),
    Ready: ready,
    markPullRequestReadyForReview: ready,
    Enqueue: () => graphqlError('UNPROCESSABLE', 'The base branch does not use a merge queue.'),
  };

  async function graphql(asked: Asked): Promise<Answer> {
    const body = parsed(bodies.graphql, asked.body, 'POST /graphql');
    if ('answer' in body) return body.answer;
    const operation = operationOf(body.ok.query);
    const answer = operation === undefined ? undefined : operations[operation];
    if (answer === undefined) return refusal(404, `The fake GitHub has no GraphQL operation ${operation ?? 'without a name'}`);
    return answer(body.ok.variables);
  }

  async function writeTree(asked: Asked): Promise<Answer> {
    const body = parsed(bodies.tree, asked.body, 'POST git/trees');
    if ('answer' in body) return body.answer;
    const index = join(scratch, `index-${String((serial += 1))}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (body.ok.base_tree !== undefined) await gitOut(['read-tree', body.ok.base_tree], undefined, env);
      for (const entry of body.ok.tree) {
        const blob = await gitOut(['hash-object', '-w', '--stdin'], entry.content);
        await gitOut(['update-index', '--add', '--cacheinfo', `${entry.mode},${blob},${entry.path}`], undefined, env);
      }
      const tree = await gitOut(['write-tree'], undefined, env);
      return json({ sha: tree }, 201);
    } finally {
      await rm(index, { force: true });
    }
  }

  async function writeCommit(asked: Asked): Promise<Answer> {
    const body = parsed(bodies.commit, asked.body, 'POST git/commits');
    if ('answer' in body) return body.answer;
    const commit = await gitOut(['commit-tree', body.ok.tree, ...body.ok.parents.flatMap(parent => ['-p', parent])], body.ok.message);
    return json({ sha: commit, tree: { sha: body.ok.tree }, parents: body.ok.parents.map(parent => ({ sha: parent })) }, 201);
  }

  async function writeStatus(asked: Asked, commit: string): Promise<Answer> {
    const body = parsed(bodies.status, asked.body, 'POST statuses');
    if ('answer' in body) return body.answer;
    if ((await commitOf(commit)) === undefined) return validation(`No commit found for SHA: ${commit}`);
    const status: Status = { ...body.ok, createdAt: now() };
    state.statuses.set(commit, [...(state.statuses.get(commit) ?? []), status]);
    return json({ state: status.state, context: status.context, description: status.description, created_at: status.createdAt }, 201);
  }

  const refJson = (branch: string, commit: string) => ({ ref: `refs/heads/${branch}`, object: { sha: commit, type: 'commit' } });

  async function readRef(branch: string): Promise<Answer> {
    const head = await headOf(branch);
    return head === undefined ? refusal(404, 'Not Found') : json(refJson(branch, head));
  }

  async function matchingRefs(prefix: string): Promise<Answer> {
    const listed = await gitOut(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']);
    const found = listed
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split(' '))
      .map(([ref = '', commit = '']) => [ref.slice('refs/heads/'.length), commit] as const)
      .flatMap(([branch, commit]) => (branch.startsWith(prefix) ? [refJson(branch, commit)] : []));
    return json(found);
  }

  async function createRef(asked: Asked): Promise<Answer> {
    const body = parsed(bodies.ref, asked.body, 'POST git/refs');
    if ('answer' in body) return body.answer;
    if ((await commitOf(body.ok.sha)) === undefined) return validation('Object does not exist');
    const made = await git(['update-ref', body.ok.ref, body.ok.sha, zero]);
    if (made.code !== 0) return validation('Reference already exists');
    return json(refJson(body.ok.ref.slice('refs/heads/'.length), body.ok.sha), 201);
  }

  async function moveRef(asked: Asked, branch: string): Promise<Answer> {
    const body = parsed(bodies.move, asked.body, 'PATCH git/refs');
    if ('answer' in body) return body.answer;
    const holds = await headOf(branch);
    if (holds === undefined) return validation('Reference does not exist');
    if ((await commitOf(body.ok.sha)) === undefined) return validation('Object does not exist');
    if (!body.ok.force && !(await isAncestor(holds, body.ok.sha))) return validation('Update is not a fast forward');
    const moved = await git(['update-ref', `refs/heads/${branch}`, body.ok.sha, holds]);
    return moved.code === 0 ? json(refJson(branch, body.ok.sha)) : validation('Reference update failed');
  }

  async function deleteRef(branch: string): Promise<Answer> {
    const holds = await headOf(branch);
    if (holds === undefined) return validation('Reference does not exist');
    await gitOut(['update-ref', '-d', `refs/heads/${branch}`, holds]);
    return { status: 204 };
  }

  async function readCommit(ref: string): Promise<Answer> {
    const commit = await commitOf(ref);
    if (commit === undefined) return validation(`No commit found for SHA: ${ref}`);
    const [, ...parents] = (await gitOut(['rev-list', '--parents', '-n', '1', commit])).split(' ');
    return json({ sha: commit, html_url: `${holder.web}/commit/${commit}`, parents: parents.map(parent => ({ sha: parent })) });
  }

  function checkRuns(asked: Asked, commit: string): Answer {
    const wanted = asked.query.get('check_name');
    const runs = wanted === null || wanted === sandboxCheck ? [runOf(commit)] : [];
    return json({
      total_count: runs.length,
      check_runs: runs.map(run => ({ id: run.id, name: sandboxCheck, head_sha: run.sha, status: run.status, conclusion: run.conclusion, started_at: run.startedAt, completed_at: run.completedAt, html_url: runLink(run) })),
    });
  }

  async function listPulls(asked: Asked): Promise<Answer> {
    const wanted = asked.query.get('state') ?? 'open';
    const head = asked.query.get('head')?.replace(/^[^:]+:/, '');
    const base = asked.query.get('base');
    const perPage = Number.parseInt(asked.query.get('per_page') ?? '30', 10);
    const pageNumber = Number.parseInt(asked.query.get('page') ?? '1', 10);
    const found = state.pulls
      .filter(pull => (head === undefined || pull.head === head) && (base === null || pull.base === base))
      .filter(pull => wanted === 'all' || (wanted === 'open') === (pull.merged === null))
      .toSorted((one, other) => other.number - one.number)
      .slice((pageNumber - 1) * perPage, pageNumber * perPage);
    return json(await Promise.all(found.map(restPull)));
  }

  async function openPull(asked: Asked): Promise<Answer> {
    const body = parsed(bodies.open, asked.body, 'POST pulls');
    if ('answer' in body) return body.answer;
    const head = body.ok.head.replace(/^[^:]+:/, '');
    const headCommit = await headOf(head);
    const baseCommit = await headOf(body.ok.base);
    if (headCommit === undefined) return validation(`head ${head} does not exist`);
    if (baseCommit === undefined) return validation(`base ${body.ok.base} does not exist`);
    if (state.pulls.some(pull => pull.head === head && pull.base === body.ok.base && pull.merged === null)) return validation(`A pull request already exists for ${owner}:${head}.`);
    if (await isAncestor(headCommit, baseCommit)) return validation(`No commits between ${body.ok.base} and ${head}`);
    const number = state.pulls.length + 1;
    const pull: Pull = { number, nodeId: `PR_fake${String(number)}`, head, base: body.ok.base, title: body.ok.title, body: body.ok.body ?? null, draft: body.ok.draft, merged: null, timeline: [] };
    state.pulls.push(pull);
    return json(await restPull(pull), 201);
  }

  async function editPull(asked: Asked, pull: Pull): Promise<Answer> {
    const body = parsed(bodies.edit, asked.body, 'PATCH pulls');
    if ('answer' in body) return body.answer;
    if (body.ok.body !== undefined) pull.body = body.ok.body;
    return json(await restPull(pull));
  }

  async function updateBranch(asked: Asked, pull: Pull): Promise<Answer> {
    const body = parsed(bodies.update, asked.body ?? {}, 'PUT update-branch');
    if ('answer' in body) return body.answer;
    const head = await headOf(pull.head);
    const base = await headOf(pull.base);
    if (head === undefined || base === undefined || pull.merged !== null) return validation('The pull request cannot be updated.');
    if (body.ok.expected_head_sha !== undefined && body.ok.expected_head_sha !== head) return validation("expected head sha didn't match current head ref.");
    if (await isAncestor(base, head)) return validation('There are no new commits on the base branch.');
    const tree = await mergedTree(head, base);
    if (tree === undefined) return validation('merge conflict between base and head');
    const commit = await gitOut(['commit-tree', tree, '-p', head, '-p', base], `Merge branch '${pull.base}' into ${pull.head}`);
    const moved = await git(['update-ref', `refs/heads/${pull.head}`, commit, head]);
    if (moved.code !== 0) return validation("expected head sha didn't match current head ref.");
    return json({ message: 'Updating pull request branch.', url: `${holder.web}/pull/${String(pull.number)}` }, 202);
  }

  async function mergePull(asked: Asked, pull: Pull): Promise<Answer> {
    const body = parsed(bodies.merge, asked.body ?? {}, 'PUT merge');
    if ('answer' in body) return body.answer;
    if (pull.merged !== null) return refusal(405, 'Pull Request is not mergeable');
    const head = await headOf(pull.head);
    const base = await headOf(pull.base);
    if (head === undefined || base === undefined) return refusal(405, 'Pull Request is not mergeable');
    if (body.ok.sha !== undefined && body.ok.sha !== head) return refusal(409, 'Head branch was modified. Review and try the merge again.');
    if (pull.draft) return refusal(405, 'Pull Request is still a draft');
    const sandbox = sandboxOf(head);
    if (sandbox !== 'green') return refusal(405, `Required status check "${sandboxCheck}" is ${sandbox === 'pending' ? 'expected' : 'failing'}.`);
    const tree = await mergedTree(base, head);
    if (tree === undefined) return refusal(405, 'Pull Request is not mergeable');
    const message = body.ok.commit_title ?? `Merge pull request #${String(pull.number)} from ${owner}/${pull.head}`;
    const commit = await gitOut(['commit-tree', tree, '-p', base, '-p', head], message);
    const moved = await git(['update-ref', `refs/heads/${pull.base}`, commit, base]);
    if (moved.code !== 0) return refusal(409, 'Base branch was modified. Review and try the merge again.');
    const at = now();
    pull.merged = { sha: commit, head, at };
    pull.timeline.push({ event: 'merged', createdAt: at });
    return json({ sha: commit, merged: true, message: 'Pull Request successfully merged' });
  }

  const withPull = (answer: (asked: Asked, pull: Pull) => Promise<Answer>) => (asked: Asked, match: readonly string[]) => {
    const pull = pullNumbered(match[0]);
    return pull === undefined ? refusal(404, 'Not Found') : answer(asked, pull);
  };

  const repo = `/repos/${owner}/${name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const web = `/${owner}/${name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = (path: string): RegExp => new RegExp(`^${repo}${path}$`);

  const routes: readonly Route[] = [
    { method: 'GET', path: /^\/user$/, answer: () => json({ login: 'fake-owner', id: 1, type: 'User' }) },
    { method: 'POST', path: /^\/graphql$/, answer: graphql },
    { method: 'POST', path: at('/git/trees'), answer: writeTree },
    { method: 'POST', path: at('/git/commits'), answer: writeCommit },
    { method: 'POST', path: at('/statuses/([0-9a-f]{40})'), answer: (asked, [commit = '']) => writeStatus(asked, commit) },
    { method: 'GET', path: at('/git/ref/heads/(.+)'), answer: (_asked, [branch = '']) => readRef(branch) },
    { method: 'GET', path: at('/git/matching-refs/heads/(.*)'), answer: (_asked, [prefix = '']) => matchingRefs(prefix) },
    { method: 'POST', path: at('/git/refs'), answer: createRef },
    { method: 'PATCH', path: at('/git/refs/heads/(.+)'), answer: (asked, [branch = '']) => moveRef(asked, branch) },
    { method: 'DELETE', path: at('/git/refs/heads/(.+)'), answer: (_asked, [branch = '']) => deleteRef(branch) },
    { method: 'GET', path: at('/commits/([0-9a-f]{40})/check-runs'), answer: (asked, [commit = '']) => checkRuns(asked, commit) },
    { method: 'GET', path: at('/commits/([^/]+)'), answer: (_asked, [ref = '']) => readCommit(ref) },
    { method: 'GET', path: at('/pulls'), answer: listPulls },
    { method: 'POST', path: at('/pulls'), answer: openPull },
    { method: 'GET', path: at('/pulls/(\\d+)'), answer: withPull((_asked, pull) => restPull(pull).then(found => json(found))) },
    { method: 'PATCH', path: at('/pulls/(\\d+)'), answer: withPull(editPull) },
    { method: 'PUT', path: at('/pulls/(\\d+)/update-branch'), answer: withPull(updateBranch) },
    { method: 'PUT', path: at('/pulls/(\\d+)/merge'), answer: withPull(mergePull) },
    {
      method: 'GET',
      path: at('/issues/(\\d+)/timeline'),
      answer: withPull((_asked, pull) => Promise.resolve(json(pull.timeline.map(event => ({ event: event.event, created_at: event.createdAt }))))),
    },
    {
      method: 'GET',
      path: new RegExp(`^${web}/actions/runs/(\\d+)$`),
      open: true,
      answer: (_asked, [id = '']) => {
        const run = [...state.runs.values()].find(entry => String(entry.id) === id);
        return run === undefined ? refusal(404, 'Not Found') : { status: 200, text: `${run.sha} ${run.status} ${run.conclusion ?? ''}\n${run.log}` };
      },
    },
  ];

  const admits = (headers: IncomingHttpHeaders): boolean => {
    const given = headers.authorization ?? '';
    return given === `token ${token}` || given === `Bearer ${token}`;
  };

  const served = await serve({ name: 'GitHub', routes, admits });
  holder.web = `${served.url}/${owner}/${name}`;
  return {
    url: served.url,
    webUrl: holder.web,
    stop: async () => {
      stopping.abort();
      await Promise.allSettled([...testing]);
      await served.stop();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
