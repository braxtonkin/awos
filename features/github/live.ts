import { parseArgs } from 'node:util';
import { Octokit } from '@octokit/core';
import { sql } from 'kysely';
import { z } from 'zod';
import { marker, type Owed } from '../../shared/actions.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import type { MergeRead } from '../../shared/merge-state.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { githubClient, type ClientFor } from './client.ts';
import { mergeStateReader } from './merge-state.ts';
import { githubPerformers, type GithubKind } from './performers.ts';

const api = 'https://api.github.com';

const environment = z.object({ GITHUB_TOKEN: z.string().regex(/^\S+$/) });

const flags = {
  repository: { type: 'string', default: 'braxtonkdev/autoworker-oss' },
  merged: { type: 'string', default: '29' },
  open: { type: 'string' },
  wait: { type: 'string', default: '1500' },
  base: { type: 'string' },
  writes: { type: 'boolean', default: false },
} as const;

const options = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  merged: z.coerce.number().int().positive(),
  open: z.coerce.number().int().positive().optional(),
  wait: z.coerce.number().int().positive(),
  base: z.string().min(1).optional(),
  writes: z.boolean(),
});

type Options = z.infer<typeof options>;

type Counted = { readonly fetch: typeof fetch; readonly calls: () => number };

function counting(): Counted {
  let calls = 0;
  return {
    fetch: (input, init) => {
      calls += 1;
      return fetch(input, init);
    },
    calls: () => calls,
  };
}

const actor = '1';

async function repositoryRow(db: Database, github: string, ignorable: readonly string[]): Promise<string> {
  await sql`insert into person (email, name) values ('probe@example.com', 'Probe')`.execute(db);
  const row = await sql<{ id: string }>`
    with saved as (
      insert into human_action (id, at, person_id, kind, repository_id) values (gen_random_uuid(), now(), ${actor}, 'add_repository', 1) returning id)
    insert into repository (github, branch, saved_by, ignorable_checks, ignored_reviewers) select ${github}, 'main', id, ${[...ignorable]}, '{}' from saved returning id`.execute(db);
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('The probe repository row was not written.');
  return id;
}

const describe = (read: MergeRead): string => ('failed' in read ? `failed: ${read.failed}` : `${read.state.value.kind} at ${read.state.head.slice(0, 12)}${read.state.value.kind === 'red' ? ` naming ${read.state.value.failing.join(', ')}` : ''}`);

const median = (values: readonly number[]): number => values.toSorted((one, other) => one - other)[Math.floor(values.length / 2)] ?? 0;

const noAnswers = { ejection: null, review: null } as const;

async function timedReads(read: () => Promise<MergeRead>, counted: Counted, times: number): Promise<{ readonly calls: readonly number[]; readonly ms: readonly number[]; readonly last: MergeRead }> {
  const calls: number[] = [];
  const ms: number[] = [];
  let last: MergeRead = { failed: 'not read' };
  for (let index = 0; index < times; index += 1) {
    const before = counted.calls();
    const started = performance.now();
    last = await read();
    ms.push(performance.now() - started);
    calls.push(counted.calls() - before);
  }
  return { calls, ms, last };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function readLanes(db: Database, given: Options, token: string): Promise<readonly Check[]> {
  const counted = counting();
  const clientFor: ClientFor = () => Promise.resolve(githubClient({ token, baseUrl: api, pageSize: 100, fetch: counted.fetch }));
  const reader = mergeStateReader(db, clientFor);
  const repositoryId = await repositoryRow(db, given.repository, []);
  const read = (number: number) => () => reader({ repositoryId, number, actsAs: actor }, noAnswers, AbortSignal.timeout(30_000));
  const checks: Check[] = [];
  const merged = await timedReads(read(given.merged), counted, 3);
  const mergedName = `live: merged pull request ${String(given.merged)} reads as merged`;
  checks.push('state' in merged.last && merged.last.state.value.kind === 'merged' ? pass(mergedName, describe(merged.last)) : fail(mergedName, describe(merged.last)));
  const perf = [merged];
  if (given.open === undefined) {
    checks.push(fail('live: an open pull request reads as waiting while its checks run, then as settled', 'pass --open <number> to name an open pull request with running checks'));
  } else {
    const open = await timedReads(read(given.open), counted, 3);
    perf.push(open);
    const first = open.last;
    const waitingName = `live: open pull request ${String(given.open)} reads as waiting-for-checks while its checks run`;
    checks.push('state' in first && first.state.value.kind === 'waiting-for-checks' ? pass(waitingName, describe(first)) : fail(waitingName, describe(first)));
    let later = first;
    const deadline = Date.now() + given.wait * 1000;
    while ('state' in later && later.state.value.kind === 'waiting-for-checks' && Date.now() < deadline) {
      await sleep(30_000);
      later = await read(given.open)();
    }
    const settledName = `live: open pull request ${String(given.open)} reads past waiting once its checks finish`;
    checks.push('state' in later && later.state.value.kind !== 'waiting-for-checks' ? pass(settledName, describe(later)) : fail(settledName, `after ${String(given.wait)} s: ${describe(later)}`));
  }
  const calls = perf.flatMap(entry => entry.calls);
  const ms = perf.flatMap(entry => entry.ms);
  const perfName = 'perf: a merge-state read takes at most 4 GitHub calls and 2 s at the median';
  const perfDetail = `calls per read ${calls.join(', ')}; ms per read ${ms.map(value => value.toFixed(0)).join(', ')}; median ${median(ms).toFixed(0)} ms`;
  checks.push(Math.max(...calls) <= 4 && median(ms) <= 2000 ? pass(perfName, perfDetail) : fail(perfName, perfDetail));
  return checks;
}

const writeLaneNames = [
  'lane 1: open, ready, merge, advance, and delete a probe pull request into the run branch',
  'lane 2: owing pr.open-draft twice for one head opens one pull request',
  'lane 5: a merge owed before the head moved is refused, naming the expected commit',
  'lane 8: an open whose reply was lost finds the pull request on the next try',
] as const;

type Probe = { readonly branch: string; readonly head: string };

const probeCommit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), tree: z.object({ sha: z.string() }) });

async function probeBranch(octokit: Octokit, repository: string, base: string, name: string): Promise<Probe> {
  const [owner = '', repo = ''] = repository.split('/');
  const baseRef = z.object({ object: z.object({ sha: z.string() }) }).parse((await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${base}` })).data);
  const baseCommit = probeCommit.parse((await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { owner, repo, commit_sha: baseRef.object.sha })).data);
  const made = probeCommit.parse((await octokit.request('POST /repos/{owner}/{repo}/git/commits', { owner, repo, message: `Probe ${name}`, tree: baseCommit.tree.sha, parents: [baseCommit.sha] })).data);
  const branch = `autoworker/probe-${name}-${String(Date.now())}`;
  return { branch, head: made.sha };
}

const readyNumber = z.object({ done: z.object({ number: z.int() }) });

async function writeLanes(given: Options, token: string): Promise<readonly Check[]> {
  if (!given.writes || given.base === undefined) {
    return writeLaneNames.map(name => fail(name, 'PARKED: gate 1. The sandbox token is read-only. After the regrant, rerun with --writes --base <run branch from npm run verify -- e2e-branch>.'));
  }
  const base = given.base;
  const octokit = new Octokit({ auth: token, baseUrl: api });
  const client = githubClient({ token, baseUrl: api, pageSize: 100 });
  const probeRules = { ignorableChecks: new Set<string>(), ignoredReviewers: new Set<string>(), draftLeaves: 'when-green' } as const;
  const performers = githubPerformers({ clientFor: () => Promise.resolve(client), mergeRowOf: () => Promise.resolve({ owedAt: new Date(), rules: probeRules }) });
  let rows = 0;
  const perform = async (kind: GithubKind, payload: unknown): Promise<string> => {
    rows += 1;
    const owed: Owed<unknown> = { row: String(rows), task: 'probe', kind, payload, marker: marker.parse(`live-probe-marker-${String(Date.now())}-${String(rows)}`), actsAs: actor };
    return JSON.stringify(await performers[kind].call(owed, { deadline: new Date(Date.now() + 60_000), signal: AbortSignal.timeout(60_000) }));
  };
  const checks: Check[] = [];
  const first = await probeBranch(octokit, given.repository, base, 'land');
  const created = await perform('branch.advance', { repository: given.repository, branch: first.branch, from: null, to: first.head });
  const opening = { repository: given.repository, head: first.branch, base, title: 'Probe pull request', body: 'Opened by github-live.' };
  const openedTwice = [await perform('pr.open-draft', opening), await perform('pr.open-draft', opening)];
  checks.push(openedTwice[0] === openedTwice[1] && openedTwice[0]?.includes('"done"') === true ? pass(writeLaneNames[1], openedTwice.join(' then ')) : fail(writeLaneNames[1], openedTwice.join(' then ')));
  checks.push(openedTwice[1]?.includes('"done"') === true ? pass(writeLaneNames[3], `the repeated open found ${openedTwice[1]}`) : fail(writeLaneNames[3], openedTwice.join(' then ')));
  const ready = await perform('pr.mark-ready', { repository: given.repository, head: first.branch, evidence: 'Probe evidence from github-live.' });
  const number = readyNumber.safeParse(JSON.parse(ready)).data?.done.number ?? 0;
  const deadline = Date.now() + given.wait * 1000;
  let status = 'UNKNOWN';
  while (!['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(status) && Date.now() < deadline) {
    await sleep(20_000);
    const facts = await client.pullFacts(given.repository, number, null, AbortSignal.timeout(30_000));
    status = 'ok' in facts ? facts.ok.mergeStateStatus : status;
  }
  const steps = [
    created,
    ready,
    `GitHub reported ${status}`,
    await perform('pr.merge', { repository: given.repository, number, commit: first.head }),
    await perform('branch.delete', { repository: given.repository, branch: first.branch }),
  ];
  checks.push(steps.every(step => step.includes('"done"') || step.startsWith('GitHub reported')) ? pass(writeLaneNames[0], steps.join(' | ')) : fail(writeLaneNames[0], steps.join(' | ')));
  const moved = await probeBranch(octokit, given.repository, base, 'moved');
  await perform('branch.advance', { repository: given.repository, branch: moved.branch, from: null, to: moved.head });
  await perform('pr.open-draft', { ...opening, head: moved.branch });
  const movedReady = await perform('pr.mark-ready', { repository: given.repository, head: moved.branch, evidence: 'Probe evidence from github-live.' });
  const movedNumber = readyNumber.safeParse(JSON.parse(movedReady)).data?.done.number ?? 0;
  const stale = await perform('pr.merge', { repository: given.repository, number: movedNumber, commit: 'f'.repeat(40) });
  checks.push(stale.includes('"refused"') && stale.includes('f'.repeat(40)) ? pass(writeLaneNames[2], stale) : fail(writeLaneNames[2], stale));
  await perform('branch.delete', { repository: given.repository, branch: moved.branch });
  return checks;
}

function noSecrets(checks: readonly Check[]): Check {
  const leaked = checks.filter(check => /github_pat_|ghp_/.test(`${check.name} ${check.detail}`));
  const name = 'live: no lane output holds a GitHub token';
  return leaked.length === 0 ? pass(name, `searched ${String(checks.length)} lane lines`) : fail(name, `${String(leaked.length)} lines`);
}

export const liveScenario: Scenario = {
  name: 'github-live',
  summary:
    'reads real pull requests through the merge-state reader and a real repository row, times each read, and runs the write lanes with --writes --base <run branch> once gate 1 grants the sandbox token write access',
  run: async args => {
    const parsed = options.safeParse(parseArgs({ args: [...args], options: flags, strict: true, allowPositionals: false }).values);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    const token = environment.safeParse(process.env);
    if (!token.success) return [fail('live: GITHUB_TOKEN is set', 'run inside the live service: docker compose run --rm live npm run verify -- github-live')];
    const reads = await withPostgres(async postgres => {
      const scratch = await postgres.scratch();
      const db = connect(scratch.url, 2);
      try {
        return await readLanes(db, parsed.data, token.data.GITHUB_TOKEN);
      } finally {
        await db.destroy();
        await scratch.drop();
      }
    });
    const lanes = [...reads, ...(await writeLanes(parsed.data, token.data.GITHUB_TOKEN))];
    return [...lanes, noSecrets(lanes)];
  },
};
