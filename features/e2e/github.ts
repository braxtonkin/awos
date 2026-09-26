import { z } from 'zod';
import { parsePayload } from './payload.ts';

const answerWait = 30_000;
const api = 'https://api.github.com';

const GitHubKeys = z.object({ GITHUB_TOKEN: z.string().regex(/^\S+$/) });

const Pull = z.object({
  number: z.number(),
  node_id: z.string().min(1),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

const CheckRun = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  completed_at: z.string().nullable(),
  html_url: z.url(),
});

export const githubPayloads = {
  ref: z.object({ ref: z.string(), object: z.object({ sha: z.string().min(1) }) }),
  refs: z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string().min(1) }) })),
  sha: z.object({ sha: z.string().min(1) }),
  commit: z.object({ sha: z.string().min(1), tree: z.object({ sha: z.string().min(1) }), parents: z.array(z.object({ sha: z.string().min(1) })) }),
  tree: z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string().min(1) })), truncated: z.boolean() }),
  status: z.object({ state: z.string(), context: z.string() }),
  pull: Pull,
  pulls: z.array(Pull),
  timeline: z.array(z.object({ event: z.string().optional() })),
  checkRuns: z.object({ total_count: z.number(), check_runs: z.array(CheckRun) }),
  merged: z.object({ sha: z.string().min(1), merged: z.boolean() }),
  readyForReview: z.object({ data: z.object({ markPullRequestReadyForReview: z.object({ pullRequest: z.object({ isDraft: z.boolean() }) }) }) }),
};

export type Pull = z.infer<typeof Pull>;
type CheckRun = z.infer<typeof CheckRun>;
export type SeedFile = { readonly path: string; readonly content: string };
type Commit = { readonly sha: string; readonly tree: string; readonly parents: readonly string[] };

export type GitHub = {
  readonly repository: string;
  readonly branchHead: (branch: string) => Promise<string | undefined>;
  readonly branchesStartingWith: (prefix: string) => Promise<readonly string[]>;
  readonly seedBranch: (branch: string, files: readonly SeedFile[], message: string) => Promise<string>;
  readonly advanceBranch: (branch: string, files: readonly SeedFile[], message: string) => Promise<string>;
  readonly commit: (sha: string) => Promise<Commit>;
  readonly blobs: (tree: string) => Promise<ReadonlyMap<string, string>>;
  readonly pulls: (base: string) => Promise<readonly Pull[]>;
  readonly pull: (number: number) => Promise<Pull>;
  readonly wasDraft: (pull: Pull) => Promise<boolean>;
  readonly checkRuns: (sha: string, name: string) => Promise<readonly CheckRun[]>;
  readonly openDraft: (pull: { readonly head: string; readonly base: string; readonly title: string; readonly body: string }) => Promise<Pull>;
  readonly markReady: (pull: Pull) => Promise<void>;
  readonly merge: (pull: Pull) => Promise<string>;
  readonly deleteBranch: (branch: string) => Promise<void>;
  readonly commitLink: (sha: string) => string;
  readonly cloneUrl: string;
  readonly pushEnvironment: Readonly<Record<string, string>>;
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const needs = (answer: Response): string => {
  const accepted = answer.headers.get('x-accepted-github-permissions');
  return answer.status === 403 && accepted !== null ? `, and the token needs ${accepted}` : '';
};

const refPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

export type GitHubSettings = {
  readonly apiUrl: string;
  readonly token: string;
  readonly repository: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
  readonly pushEnvironment: Readonly<Record<string, string>>;
};

export function githubTokenFromEnvironment(env: NodeJS.ProcessEnv): string {
  const keys = GitHubKeys.safeParse(env);
  if (!keys.success) throw new Error('GITHUB_TOKEN is not usable');
  return keys.data.GITHUB_TOKEN;
}

export function githubFromEnvironment(env: NodeJS.ProcessEnv, repository: string): GitHub {
  return githubWithToken(githubTokenFromEnvironment(env), repository);
}

export function githubWithToken(token: string, repository: string): GitHub {
  return githubAt({
    apiUrl: api,
    token,
    repository,
    webUrl: `https://github.com/${repository}`,
    cloneUrl: `https://github.com/${repository}.git`,
    pushEnvironment: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
  });
}

export function githubAt(settings: GitHubSettings): GitHub {
  const { apiUrl, token, repository } = settings;

  const send = async (method: Method, path: string, body?: unknown): Promise<Response> =>
    fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'autoworker-e2e',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(answerWait),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const call = async <Schema extends z.ZodType>(method: Method, path: string, schema: Schema, body?: unknown): Promise<z.output<Schema>> => {
    const answer = await send(method, path, body);
    const text = await answer.text();
    const route = path.split('?')[0] ?? path;
    if (!answer.ok) throw new Error(`GitHub ${method} ${route} answered ${String(answer.status)}${needs(answer)}: ${text.slice(0, 500)}`);
    return parsePayload(`GitHub ${method} ${route}`, schema, JSON.parse(text));
  };

  const repo = `/repos/${repository}`;

  const branchHead = async (branch: string): Promise<string | undefined> => {
    const answer = await send('GET', `${repo}/git/ref/heads/${refPath(branch)}`);
    if (answer.status === 404) return undefined;
    if (!answer.ok) throw new Error(`GitHub GET ref answered ${String(answer.status)}`);
    return parsePayload('GitHub GET ref', githubPayloads.ref, await answer.json()).object.sha;
  };

  const commit = async (sha: string): Promise<Commit> => {
    const found = await call('GET', `${repo}/git/commits/${sha}`, githubPayloads.commit);
    return { sha: found.sha, tree: found.tree.sha, parents: found.parents.map(parent => parent.sha) };
  };

  const writeCommit = async (files: readonly SeedFile[], message: string, parent: Commit | undefined): Promise<string> => {
    const tree = await call('POST', `${repo}/git/trees`, githubPayloads.sha, {
      ...(parent === undefined ? {} : { base_tree: parent.tree }),
      tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
    });
    const written = await call('POST', `${repo}/git/commits`, githubPayloads.sha, { message, tree: tree.sha, parents: parent === undefined ? [] : [parent.sha] });
    await call('POST', `${repo}/statuses/${written.sha}`, githubPayloads.status, {
      state: 'success',
      context: 'sandbox',
      description: 'Written by the end-to-end harness. The sandbox workflow tests it once the branch holds it.',
    });
    return written.sha;
  };

  return {
    repository,
    branchHead,
    branchesStartingWith: async prefix =>
      (await call('GET', `${repo}/git/matching-refs/heads/${refPath(prefix)}`, githubPayloads.refs)).map(found => found.ref.slice('refs/heads/'.length)),
    seedBranch: async (branch, files, message) => {
      const seed = await writeCommit(files, message, undefined);
      await call('POST', `${repo}/git/refs`, githubPayloads.ref, { ref: `refs/heads/${branch}`, sha: seed });
      return seed;
    },
    advanceBranch: async (branch, files, message) => {
      const head = await branchHead(branch);
      if (head === undefined) throw new Error(`${branch} does not exist, so it cannot move forward`);
      const advanced = await writeCommit(files, message, await commit(head));
      await call('PATCH', `${repo}/git/refs/heads/${refPath(branch)}`, githubPayloads.ref, { sha: advanced, force: false });
      return advanced;
    },
    commit,
    blobs: async tree => {
      const listed = await call('GET', `${repo}/git/trees/${tree}?recursive=1`, githubPayloads.tree);
      if (listed.truncated) throw new Error(`GitHub truncated its listing of tree ${tree}`);
      return new Map(listed.tree.flatMap(entry => (entry.type === 'blob' ? [[entry.path, entry.sha] as const] : [])));
    },
    pulls: base => call('GET', `${repo}/pulls?state=all&per_page=100&base=${encodeURIComponent(base)}`, githubPayloads.pulls),
    pull: number => call('GET', `${repo}/pulls/${String(number)}`, githubPayloads.pull),
    wasDraft: async pull => pull.draft || (await call('GET', `${repo}/issues/${String(pull.number)}/timeline?per_page=100`, githubPayloads.timeline)).some(item => item.event === 'ready_for_review'),
    checkRuns: async (sha, name) => (await call('GET', `${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`, githubPayloads.checkRuns)).check_runs,
    openDraft: pull => call('POST', `${repo}/pulls`, githubPayloads.pull, { ...pull, draft: true }),
    markReady: async pull => {
      const reply = await call('POST', '/graphql', githubPayloads.readyForReview, {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
        variables: { id: pull.node_id },
      });
      if (reply.data.markPullRequestReadyForReview.pullRequest.isDraft) throw new Error(`pull request ${String(pull.number)} is still a draft`);
    },
    merge: async pull => {
      const merged = await call('PUT', `${repo}/pulls/${String(pull.number)}/merge`, githubPayloads.merged, { merge_method: 'merge', sha: pull.head.sha });
      if (!merged.merged) throw new Error(`GitHub did not merge pull request ${String(pull.number)}`);
      return merged.sha;
    },
    deleteBranch: async branch => {
      const answer = await send('DELETE', `${repo}/git/refs/heads/${refPath(branch)}`);
      if (!answer.ok && answer.status !== 422) throw new Error(`GitHub DELETE ref answered ${String(answer.status)}`);
    },
    commitLink: sha => `${settings.webUrl}/commit/${sha}`,
    cloneUrl: settings.cloneUrl,
    pushEnvironment: settings.pushEnvironment,
  };
}
