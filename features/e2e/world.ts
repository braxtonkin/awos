import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { kindAddress } from '../../tools/verify/cluster.ts';
import { kind } from '../../tools/verify/kind.ts';
import type { GitHub } from './github.ts';
import { createRunBranch } from './harness.ts';
import { localLogins, startLocalWorld, type LocalWorld } from './local-world.ts';
import { baseEnvironment, succeed, type Command } from './process.ts';

const repository = 'world/sandbox';
const project = 'WORLD';
const label = 'e2e-world';
const ciWaitMs = 600_000;
const worldFile = { path: 'src/world.ts', content: "export const world = 'local';\n" };
const plantedFile = { path: 'test/planted.test.ts', content: "import { expect, test } from 'vitest';\n\ntest('planted failure', () => {\n  expect(1).toBe(2);\n});\n" };

const engineFactsQuery = `query Facts($owner: String!, $name: String!, $number: Int!, $first: Int!, $answered: ID!, $withAnswered: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number url state isDraft mergeable mergeStateStatus reviewDecision isInMergeQueue
      mergeQueueEntry { headCommit { oid } }
      headRefOid
      baseRef {
        rules(first: 100) { nodes { type parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } }
        branchProtectionRule { requiredStatusCheckContexts }
      }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: $first) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename ... on CheckRun { name status conclusion startedAt } ... on StatusContext { context state createdAt } }
      } } } } }
      latestOpinionatedReviews(first: $first, writersOnly: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id state submittedAt body author { login } comments(first: $first) { pageInfo { hasNextPage endCursor } nodes { path line body } } }
      }
      timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { id reason createdAt beforeCommit { oid } } } }
    }
  }
  answered: node(id: $answered) @include(if: $withAnswered) { ... on PullRequestReview { submittedAt } }
}`;

const factsReply = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        state: z.string(),
        isDraft: z.boolean(),
        mergeable: z.string(),
        mergeStateStatus: z.string(),
        headRefOid: z.string(),
        baseRef: z.object({ rules: z.object({ nodes: z.array(z.object({ parameters: z.object({ requiredStatusChecks: z.array(z.object({ context: z.string() })) }) })) }) }),
        commits: z.object({
          nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(z.looseObject({ __typename: z.string() })) }) }) }) })),
        }),
      }),
    }),
  }),
});

const searchReply = z.object({ issues: z.array(z.object({ key: z.string(), fields: z.object({ assignee: z.object({ accountId: z.string() }).nullable() }) })), isLast: z.boolean() });

const commentsReply = z.object({ comments: z.array(z.object({ author: z.object({ accountId: z.string() }), properties: z.array(z.object({ key: z.string(), value: z.unknown() })) })) });

const ticketReply = z.object({ fields: z.object({ status: z.object({ name: z.string() }) }) });

const transitionsReply = z.object({ transitions: z.array(z.object({ id: z.string(), to: z.object({ name: z.string() }) })) });

type Reply = { readonly status: number; readonly body: unknown };

const basic = (email: string, token: string): string => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

async function ask(base: string, method: string, path: string, authorization: string, body?: unknown): Promise<Reply> {
  const answer = await fetch(new URL(path, base), {
    method,
    headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await answer.text();
  return { status: answer.status, body: text === '' ? null : JSON.parse(text) };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Steps = { readonly checks: Check[]; readonly expect: (name: string, actual: unknown, expected: unknown) => void };

function steps(): Steps {
  const checks: Check[] = [];
  return {
    checks,
    expect: (name, actual, expected) => {
      const shown = JSON.stringify(actual);
      checks.push(isDeepStrictEqual(actual, expected) ? pass(name, shown) : fail(name, `expected ${JSON.stringify(expected)}, got ${shown}`));
    },
  };
}

async function finishedCheck(github: GitHub, commit: string): Promise<{ readonly status: string; readonly conclusion: string | null; readonly html_url: string } | undefined> {
  const deadline = Date.now() + ciWaitMs;
  while (Date.now() < deadline) {
    const done = (await github.checkRuns(commit, 'sandbox')).find(run => run.status === 'completed');
    if (done !== undefined) return done;
    await wait(2_000);
  }
  return undefined;
}

async function readFacts(world: LocalWorld, number: number) {
  const reply = await ask(world.engine.settings.GITHUB_API_URL, 'POST', '/graphql', `token ${localLogins.githubToken}`, {
    query: engineFactsQuery,
    variables: { owner: 'world', name: 'sandbox', number, first: 100, answered: 'none', withAnswered: false },
  });
  const pull = factsReply.parse(reply.body).data.repository.pullRequest;
  return {
    state: pull.state,
    isDraft: pull.isDraft,
    mergeable: pull.mergeable,
    mergeStateStatus: pull.mergeStateStatus,
    headRefOid: pull.headRefOid,
    required: pull.baseRef.rules.nodes.flatMap(rule => rule.parameters.requiredStatusChecks.map(check => check.context)),
    contexts: pull.commits.nodes.flatMap(node => node.commit.statusCheckRollup.contexts.nodes).map(context => ({ ...context, startedAt: undefined })),
  };
}

async function pushBranch(git: Command, branch: string, file: { readonly path: string; readonly content: string }, message: string): Promise<string> {
  await writeFile(join(git.cwd, file.path), file.content);
  await succeed('git', ['add', file.path], git);
  await succeed('git', ['commit', '--quiet', '-m', message], git);
  await succeed('git', ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], git);
  return (await succeed('git', ['rev-parse', 'HEAD'], git)).trim();
}

async function githubSteps(world: LocalWorld, { expect }: Steps, folder: string): Promise<void> {
  const { github } = world;
  const api = world.engine.settings.GITHUB_API_URL;
  const token = `token ${localLogins.githubToken}`;
  expect('GET /user admits the token', (await ask(api, 'GET', '/user', token)).body, { login: 'fake-owner', id: 1, type: 'User' });
  expect('GET /user refuses another token', (await ask(api, 'GET', '/user', 'token wrong')).status, 401);
  expect('an unknown route names itself', await ask(api, 'GET', `/repos/${repository}/nothing`, token), { status: 404, body: { message: `The fake GitHub has no route for GET /repos/${repository}/nothing`, errorMessages: [`The fake GitHub has no route for GET /repos/${repository}/nothing`] } });

  const run = await createRunBranch(github);
  expect('the run branch holds the seed', await github.branchHead(run.branch), run.seed);
  expect('the seed has no parent', (await ask(api, 'GET', `/repos/${repository}/commits/${run.seed}`, token)).body, { sha: run.seed, html_url: `${api}/${repository}/commit/${run.seed}`, parents: [] });

  const env = { ...baseEnvironment(folder), GIT_AUTHOR_NAME: 'World', GIT_AUTHOR_EMAIL: 'world@example.com', GIT_COMMITTER_NAME: 'World', GIT_COMMITTER_EMAIL: 'world@example.com' };
  const clone: Command = { cwd: folder, env, timeoutMs: 120_000, signal: AbortSignal.timeout(ciWaitMs * 2) };
  await succeed('git', ['clone', '--quiet', '--branch', run.branch, '--single-branch', github.cloneUrl, 'work'], clone);
  const git: Command = { ...clone, cwd: join(folder, 'work') };
  const work = `${run.branch}-work/${project}-1`;
  const planted = `${run.branch}-work/${project}-2`;
  const pushed = await pushBranch(git, work, worldFile, 'Add the world file');
  expect('the work branch holds the pushed commit', await github.branchHead(work), pushed);
  await succeed('git', ['reset', '--quiet', '--hard', run.seed], git);
  const plantedHead = await pushBranch(git, planted, plantedFile, 'Plant a failing test');
  expect('the planted branch holds its commit', await github.branchHead(planted), plantedHead);
  expect('matching refs list both work branches', await github.branchesStartingWith(`${run.branch}-work/`), [planted, work].toSorted());

  const opened = await github.openDraft({ head: work, base: run.branch, title: `${project}-1 Add the world file`, body: 'Made by e2e-world.' });
  expect('the draft opens', { number: opened.number, draft: opened.draft, state: opened.state, head: opened.head, base: opened.base.ref }, { number: 1, draft: true, state: 'open', head: { ref: work, sha: pushed }, base: run.branch });
  expect('pulls by base find the draft', (await github.pulls(run.branch)).map(pull => pull.number), [1]);
  const plantedPull = await github.openDraft({ head: planted, base: run.branch, title: `${project}-2 Plant a failing test`, body: 'The negative control.' });
  expect('the planted draft opens', plantedPull.number, 2);

  expect('Facts on the draft', await readFacts(world, 1), {
    state: 'OPEN',
    isDraft: true,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'DRAFT',
    headRefOid: pushed,
    required: ['sandbox'],
    contexts: [{ __typename: 'CheckRun', name: 'sandbox', status: 'IN_PROGRESS', conclusion: null, startedAt: undefined }],
  });
  const plantedStarted = await github.checkRuns(plantedHead, 'sandbox');
  expect('reading the planted checks starts sandbox', plantedStarted.map(check => check.status), ['in_progress']);

  await github.markReady(opened);
  const readied = await github.pull(1);
  expect('the ready mutation leaves draft', { draft: readied.draft, wasDraft: await github.wasDraft(readied) }, { draft: false, wasDraft: true });

  const green = await finishedCheck(github, pushed);
  expect('sandbox passes on the pull request head', { status: green?.status, conclusion: green?.conclusion }, { status: 'completed', conclusion: 'success' });
  const log = green === undefined ? '' : await (await fetch(green.html_url)).text();
  expect('the check run link shows its log', log.startsWith(`${pushed} completed success\n`), true);
  expect('Facts once sandbox passed', await readFacts(world, 1), {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: pushed,
    required: ['sandbox'],
    contexts: [{ __typename: 'CheckRun', name: 'sandbox', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: undefined }],
  });

  const merged = await github.merge(readied);
  const after = await github.pull(1);
  expect('the pull request merged', { state: after.state, merged: after.merged_at !== null, mergeCommit: after.merge_commit_sha, runHead: await github.branchHead(run.branch) }, { state: 'closed', merged: true, mergeCommit: merged, runHead: merged });
  expect('Facts after the merge', (await readFacts(world, 1)).state, 'MERGED');

  await succeed('git', ['clone', '--quiet', '--branch', run.branch, '--single-branch', github.cloneUrl, 'fresh'], clone);
  const fresh: Command = { ...clone, cwd: join(folder, 'fresh') };
  expect('a fresh clone reads the merge commit', (await succeed('git', ['log', '-1', '--format=%H %P'], fresh)).trim(), `${merged} ${run.seed} ${pushed}`);
  expect('the merge carries the pushed file', await readFile(join(fresh.cwd, worldFile.path), 'utf8'), worldFile.content);
  const onBranch = await finishedCheck(github, merged);
  expect('sandbox passes on the merge commit', { status: onBranch?.status, conclusion: onBranch?.conclusion }, { status: 'completed', conclusion: 'success' });

  await github.deleteBranch(work);
  expect('the work branch is deleted', await github.branchHead(work), undefined);

  const red = await finishedCheck(github, plantedHead);
  expect('sandbox fails on the planted test', { status: red?.status, conclusion: red?.conclusion }, { status: 'completed', conclusion: 'failure' });
  const redLog = red === undefined ? '' : await (await fetch(red.html_url)).text();
  expect('the failing run names the planted test', { planted: redLog.includes('planted failure'), oneFailed: redLog.includes('1 failed') }, { planted: true, oneFailed: true });
  await github.markReady(plantedPull);
  const refused = await github.merge(await github.pull(2)).then(
    sha => `merged as ${sha}`,
    (error: unknown) => messageOf(error),
  );
  expect('the planted pull request does not merge', refused.startsWith(`GitHub PUT /repos/${repository}/pulls/2/merge answered 405`), true);
  expect('Facts on the planted pull request', (await readFacts(world, 2)).mergeStateStatus, 'BLOCKED');
}

async function jiraSteps(world: LocalWorld, { expect }: Steps): Promise<void> {
  const { jira } = world;
  const site = world.engine.settings.JIRA_SITE;
  const login = basic(localLogins.jiraEmail, localLogins.jiraToken);
  expect('GET myself admits the login', (await ask(site, 'GET', '/rest/api/3/myself', login)).status, 200);
  expect('GET myself refuses another token', (await ask(site, 'GET', '/rest/api/3/myself', basic(localLogins.jiraEmail, 'wrong'))).status, 401);
  expect('an unknown Jira route names itself', (await ask(site, 'GET', '/rest/api/3/nothing', login)).body, { message: 'The fake Jira has no route for GET /rest/api/3/nothing', errorMessages: ['The fake Jira has no route for GET /rest/api/3/nothing'] });

  const account = await jira.accountId();
  expect('the account is the token owner', account, localLogins.jiraAccountId);
  const key = await jira.fileTicket({ project, summary: 'Add the world file', description: 'Line one.\n\nLine two.', label, assignee: account });
  expect('the ticket is filed', key, `${project}-1`);
  const unassigned = await ask(site, 'POST', '/rest/api/2/issue', login, { fields: { project: { key: project }, issuetype: { name: 'Task' }, summary: 'Nobody holds this', labels: [label], assignee: null } });
  expect('an unassigned ticket is filed', unassigned.status, 201);
  const issue = await jira.issue(key);
  expect('the ticket reads back through v2', { description: issue.fields.description, labels: issue.fields.labels, assignee: issue.fields.assignee }, { description: 'Line one.\n\nLine two.', labels: [label], assignee: { accountId: account } });

  const search = async (jql: string) =>
    searchReply.parse((await ask(site, 'POST', '/rest/api/3/search/jql', login, { jql, maxResults: 50, fields: ['summary', 'assignee'] })).body).issues.map(found => [found.key, found.fields.assignee?.accountId ?? null]);
  expect('v3 search by project and label', await search(`project = ${project} AND labels = ${label}`), [
    [`${project}-1`, account],
    [`${project}-2`, null],
  ]);
  expect('v3 search for tickets nobody holds', await search(`project = ${project} AND assignee is EMPTY`), [[`${project}-2`, null]]);
  expect('v3 search refuses a clause it does not know', (await ask(site, 'POST', '/rest/api/3/search/jql', login, { jql: 'summary ~ world' })).status, 400);

  const adf = {
    version: 1,
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Plan ready.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'https://example.com/pull/1', marks: [{ type: 'link', attrs: { href: 'https://example.com/pull/1' } }] }] },
    ],
  };
  const posted = await ask(site, 'POST', `/rest/api/3/issue/${key}/comment`, login, { body: adf, properties: [{ key: 'autoworker', value: { marker: 'm-1' } }] });
  expect('a v3 ADF comment posts', posted.status, 201);
  expect('the comment reads back through v2 as text', (await jira.comments(key)).map(comment => comment.body), ['Plan ready.\n\nline one\nline two\n\nhttps://example.com/pull/1']);
  const properties = commentsReply.parse((await ask(site, 'GET', `/rest/api/3/issue/${key}/comment?startAt=0&maxResults=100&orderBy=created&expand=properties`, login)).body);
  expect('the comment keeps its author and property', properties.comments, [{ author: { accountId: account }, properties: [{ key: 'autoworker', value: { marker: 'm-1' } }] }]);

  const status = async () => ticketReply.parse((await ask(site, 'GET', `/rest/api/3/issue/${key}?fields=summary,assignee,status`, login)).body).fields.status.name;
  const moveTo = async (name: string) => {
    const moves = transitionsReply.parse((await ask(site, 'GET', `/rest/api/3/issue/${key}/transitions`, login)).body).transitions;
    const move = moves.find(candidate => candidate.to.name === name);
    return move === undefined ? 0 : (await ask(site, 'POST', `/rest/api/3/issue/${key}/transitions`, login, { transition: { id: move.id } })).status;
  };
  expect('a new ticket is To Do', await status(), 'To Do');
  expect('To Do leads to every other status', transitionsReply.parse((await ask(site, 'GET', `/rest/api/3/issue/${key}/transitions`, login)).body).transitions.map(move => move.to.name), ['In Progress', 'Done']);
  expect('the ticket moves to In Progress', [await moveTo('In Progress'), await status()], [204, 'In Progress']);
  expect('the ticket moves to Done', [await moveTo('Done'), await status()], [204, 'Done']);
}

export const worldScenario: Scenario = {
  name: 'e2e-world',
  summary: 'starts the local world of a fake GitHub, a fake Jira, and the git daemon, then drives a run branch to a merge and a ticket to Done through them, with a planted failing test that sandbox must fail',
  run: async () => {
    const cluster = await kind.run(['up']);
    if (!cluster.every(check => check.passed)) return cluster;
    const world = await startLocalWorld(await kindAddress(), repository);
    const folder = await mkdtemp(join(tmpdir(), 'e2e-world-'));
    const found = steps();
    found.checks.push(...cluster);
    try {
      await githubSteps(world, found, folder);
      await jiraSteps(world, found);
    } catch (error) {
      found.checks.push(fail('every step ran', messageOf(error)));
    } finally {
      await world.stop();
      await rm(folder, { recursive: true, force: true });
    }
    return found.checks;
  },
};
