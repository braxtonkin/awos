import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { checkModel, codexHomePrefix, probeCodex, type CodexProbe } from './codex-check.ts';
import { githubApi, githubCheck } from './github-check.ts';
import { codexLogin, refreshable, type Checked, type Verdict } from './kinds.ts';
import { fakeGithubToken } from './world.ts';

type Answer = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly expect: Verdict; readonly expiresAt: Date | null };

const verdict = z.enum(['valid', 'invalid', 'unknown']);

const count = z.coerce.number().int().positive();

const githubToken = z.object({ GITHUB_TOKEN: z.string().min(1, { error: 'set GITHUB_TOKEN to run the live GitHub check' }) });

const rawLogin = z.string().transform((text, context): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    context.issues.push({ code: 'custom', message: 'must be JSON', input: undefined });
    return z.NEVER;
  }
}).pipe(z.looseObject({ tokens: z.looseObject({ access_token: z.string() }) }));

const codexTimeoutMs = 60_000;
const githubTimeoutMs = 10_000;
const budget = { wallMs: 30_000, inputTokens: 15_000 };

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

const expiryText = (expiresAt: Date | null): string => expiresAt?.toISOString() ?? 'none';

const describe = (checked: Checked): string => `verdict ${checked.verdict}; cause: ${checked.cause}; expires ${expiryText(checked.expiresAt)}`;

function breakSignature(login: string): string {
  const parsed = rawLogin.parse(login);
  const [header, payload, signature] = parsed.tokens.access_token.split('.');
  const broken = [header, payload, `${(signature ?? '').slice(1)}${(signature ?? '').slice(0, 1)}`].join('.');
  return `${JSON.stringify({ ...parsed, tokens: { ...parsed.tokens, access_token: broken } }, null, 2)}\n`;
}

const leftoverHomes = async (): Promise<readonly string[]> => (await readdir(tmpdir())).filter(name => name.startsWith(codexHomePrefix));

async function codexScenario(args: readonly string[]): Promise<readonly Check[]> {
  const { values } = parseArgs({
    args: [...args],
    options: { login: { type: 'string', default: '/codex/auth.json' }, expect: { type: 'string', default: 'valid' }, 'break-signature': { type: 'boolean', default: false }, runs: { type: 'string' } },
  });
  const expected = verdict.parse(values.expect);
  const runs = values.runs === undefined ? 1 : count.parse(values.runs);
  const text = await readFile(values.login, 'utf8').catch(() => null);
  if (text === null) return [fail('login is readable', `${values.login} could not be read, so no check ran. Mount the access-only login there or pass --login <path>.`)];
  if (!codexLogin.safeParse(text).success) return [fail('login is a Codex auth.json', `${values.login} is not a Codex auth.json, so no check ran`)];
  if (refreshable(text)) {
    return [fail('login is access-only', `${values.login} still holds a refresh token, so the check refused to run Codex, which could rotate a real login. Mount a copy whose tokens.refresh_token is blank.`)];
  }
  const login = values['break-signature'] ? breakSignature(text) : text;
  const probes: CodexProbe[] = [];
  for (let run = 1; run <= runs; run += 1) probes.push(await probeCodex({ timeoutMs: codexTimeoutMs }, login));
  const leftovers = await leftoverHomes();
  const models = [...new Set(probes.flatMap(probe => probe.models))];
  const perRun = probes.map((probe, index) => {
    const detail = `run ${String(index + 1)}: ${describe(probe.checked)}; ${(probe.wallMs / 1000).toFixed(1)} s; ${probe.inputTokens === null ? 'no usage reported' : `${String(probe.inputTokens)} input tokens`}`;
    return probe.checked.verdict === expected ? pass(`verdict is ${expected}`, detail) : fail(`verdict is ${expected}`, detail);
  });
  const unchanged = probes.every(probe => probe.checked.refresh.kind !== 'rotated');
  const checks = [
    pass('login is access-only', `${values.login} holds no refresh token`),
    ...perRun,
    unchanged ? pass('Codex left the login unchanged', 'no run rewrote auth.json') : fail('Codex left the login unchanged', 'a run rewrote auth.json'),
    leftovers.length === 0 ? pass('no temporary Codex home is left', `no ${codexHomePrefix}* entry in ${tmpdir()}`) : fail('no temporary Codex home is left', leftovers.join(', ')),
    models.every(model => model === checkModel) ? pass(`every event names ${checkModel} only`, models.length === 0 ? `no event names a model, and every run passed --model ${checkModel}` : `models named: ${models.join(', ')}`) : fail(`every event names ${checkModel} only`, `models named: ${models.join(', ')}`),
  ];
  if (values.runs === undefined) return checks;
  const wall = median(probes.map(probe => probe.wallMs));
  const tokens = median(probes.map(probe => probe.inputTokens ?? Number.POSITIVE_INFINITY));
  return [
    ...checks,
    wall <= budget.wallMs ? pass('median wall time within 30 s', `${(wall / 1000).toFixed(1)} s over ${String(runs)} runs`) : fail('median wall time within 30 s', `${(wall / 1000).toFixed(1)} s over ${String(runs)} runs`),
    tokens <= budget.inputTokens ? pass('median input tokens within 15,000', `${String(tokens)} over ${String(runs)} runs`) : fail('median input tokens within 15,000', `${String(tokens)} over ${String(runs)} runs`),
  ];
}

const answers: readonly Answer[] = [
  { status: 200, headers: { 'github-authentication-token-expiration': '2026-10-01 12:00:00 UTC' }, expect: 'valid', expiresAt: new Date('2026-10-01T12:00:00Z') },
  { status: 401, headers: {}, expect: 'invalid', expiresAt: null },
  { status: 200, headers: {}, expect: 'valid', expiresAt: null },
  { status: 503, headers: {}, expect: 'unknown', expiresAt: null },
];

function fakeGithub(): Promise<{ readonly server: Server; readonly url: string; readonly seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const answer = answers[seen.length];
    seen.push(`${request.method ?? '?'} ${request.url ?? '?'} ${request.headers.authorization === undefined ? 'without' : 'with'} a token`);
    const status = answer?.status ?? 500;
    response.writeHead(status, { 'content-type': 'application/json', ...answer?.headers });
    response.end(JSON.stringify(status === 200 ? { login: 'ada' } : { message: status === 401 ? 'Bad credentials' : 'Service unavailable' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}`, seen });
    });
  });
}

async function githubScenario(args: readonly string[]): Promise<readonly Check[]> {
  const { values } = parseArgs({ args: [...args], options: { live: { type: 'boolean', default: false } } });
  if (values.live) {
    const { GITHUB_TOKEN: token } = githubToken.parse(process.env);
    const checked = await githubCheck({ baseUrl: githubApi, timeoutMs: githubTimeoutMs }).run(token, new Date());
    return [checked.verdict === 'valid' ? pass('the real API says valid', describe(checked)) : fail('the real API says valid', describe(checked))];
  }
  const fake = await fakeGithub();
  try {
    const check = githubCheck({ baseUrl: fake.url, timeoutMs: githubTimeoutMs });
    const checks: Check[] = [];
    for (const answer of answers) {
      const checked = await check.run(fakeGithubToken(), new Date());
      const name = `a ${String(answer.status)} is ${answer.expect} with expiry ${expiryText(answer.expiresAt)}`;
      const matches = checked.verdict === answer.expect && expiryText(checked.expiresAt) === expiryText(answer.expiresAt);
      checks.push(matches ? pass(name, describe(checked)) : fail(name, describe(checked)));
    }
    const allUser = fake.seen.length === answers.length && fake.seen.every(line => line === 'GET /user with a token');
    checks.push(allUser ? pass('every request was GET /user with a token', fake.seen.join('; ')) : fail('every request was GET /user with a token', fake.seen.join('; ')));
    return checks;
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
  }
}

export const liveScenarios: readonly Scenario[] = [
  { name: 'codex-check', summary: 'run the Codex check on an access-only login mounted read-only, with --expect, --break-signature, and --runs for the perf probe', run: codexScenario },
  { name: 'github-check', summary: 'run the GitHub check against a local fake that answers 200 with an expiry, then 401, or against the real API with --live', run: githubScenario },
];
