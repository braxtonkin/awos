import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { connect, refusal } from '../../shared/db/client.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { liveScenario } from './live.ts';
import { imageReference } from './settings.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const jobMain = join(root, 'services', 'job', 'main.ts');

function typeErrors(planted: string): readonly string[] {
  const file = join(root, 'features', 'jobs', 'planted.ts');
  const parsed = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (parsed === undefined) throw new Error('tsconfig.json did not parse');
  const host = ts.createCompilerHost(parsed.options);
  const readFileFromHost = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = path => (resolve(path) === file ? planted : readFileFromHost(path));
  host.fileExists = path => resolve(path) === file || fileExists(path);
  const program = ts.createProgram([file], parsed.options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

const launchWith = (login: string, guard = 'true'): string =>
  [
    "import { accessOnly } from '../../shared/codex-login.ts';",
    "import { manifests } from './launch.ts';",
    "import { imageReference } from './settings.ts';",
    "const image = imageReference.parse('example.com/job@sha256:' + '0'.repeat(64));",
    "const settings = { image, namespace: 'default', serviceAccount: 'autoworker-job', deadlineSeconds: 60 };",
    "const copy = accessOnly('{}');",
    `export const planted = ${guard} ? manifests({ attempt: '1', taskKey: 'K-1', number: 1, step: 'specify', image, repositoryUrl: 'https://example.com/r.git', startCommit: '', afterTurn: { kind: 'push' }, attemptToken: '', engineUrl: '', runAs: { name: 'n', email: 'e@example.com', githubToken: 't', codexLogin: ${login} } }, settings) : copy;`,
  ].join('\n');

const typePlants = [
  { what: 'a raw Codex login given to the launcher', source: launchWith(`'{"tokens": {"refresh_token": "rt"}}'`), rejectedWith: `'string & $brand<"AccessOnlyLogin">'` },
  { what: 'a login that accessOnly made, given to the launcher', source: launchWith('copy.login', "'login' in copy"), rejectedWith: undefined },
  {
    what: 'a mutable tag given as the Job image',
    source: "import type { ImageReference } from './settings.ts';\nexport const planted: ImageReference = 'node:24-bookworm-slim';\n",
    rejectedWith: `'string & $brand<"ImageReference">'`,
  },
] as const;

function typeGuards(): Check {
  const problems = typePlants.flatMap(({ what, source, rejectedWith }) => {
    const errors = typeErrors(source);
    if (rejectedWith === undefined) return errors.length === 0 ? [] : [`tsc rejected ${what}: ${errors.join('; ')}`];
    return errors.some(error => error.includes(rejectedWith)) ? [] : [`tsc did not reject ${what} with ${rejectedWith}; it said ${errors.join('; ') || 'nothing'}`];
  });
  const name = 'tsc rejects a raw login and a mutable tag where the launcher needs AccessOnlyLogin and an ImageReference';
  return problems.length === 0 ? pass(name, typePlants.map(plant => `${plant.what}: ${plant.rejectedWith === undefined ? 'accepted' : 'rejected'}`).join('; ')) : fail(name, problems.join('; '));
}

async function boundaries(plant: string | undefined): Promise<{ readonly status: number; readonly output: string }> {
  const copy = await mkdtemp(join(tmpdir(), 'jobs-boundaries-'));
  try {
    for (const entry of ['features', 'services', 'shared', 'tools', 'package.json', 'tsconfig.json', '.dependency-cruiser.json']) {
      await cp(join(root, entry), join(copy, entry), { recursive: true, filter: source => !source.includes('node_modules') });
    }
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    if (plant !== undefined) {
      const file = join(copy, 'features', 'jobs', 'workspace.ts');
      await writeFile(file, `${plant}\n${await readFile(file, 'utf8')}`);
    }
    try {
      const { stdout, stderr } = await run('npm', ['run', '--silent', 'boundaries'], { cwd: copy, maxBuffer: 16 * 1024 * 1024 });
      return { status: 0, output: `${stdout}${stderr}` };
    } catch (error) {
      const output = typeof error === 'object' && error !== null && 'stdout' in error ? `${String(error.stdout)}${'stderr' in error ? String(error.stderr) : ''}` : String(error);
      return { status: 1, output };
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

async function boundaryPlants(): Promise<readonly Check[]> {
  const plants = [
    { what: 'a Postgres import', source: "import pg from 'pg';\nexport const planted = pg;", rule: 'job-has-no-database' },
    { what: 'a Kubernetes client import', source: "import { KubeConfig } from '@kubernetes/client-node';\nexport const planted = KubeConfig;", rule: 'job-has-no-kubernetes-api' },
  ];
  const clean = await boundaries(undefined);
  const checks = [clean.status === 0 ? pass('npm run boundaries accepts the unplanted copy', 'exit 0') : fail('npm run boundaries accepts the unplanted copy', clean.output.slice(-400))];
  for (const { what, source, rule } of plants) {
    const planted = await boundaries(source);
    const name = `npm run boundaries rejects ${what} in features/jobs/workspace.ts through services/job/main.ts`;
    const line = planted.output.split('\n').find(entry => entry.includes(rule) && entry.includes('services/job/main.ts'));
    checks.push(planted.status !== 0 && line !== undefined ? pass(name, line.trim()) : fail(name, planted.output.slice(-400)));
  }
  return checks;
}

const samples = [
  { image: 'node:24-bookworm-slim', digest: false },
  { image: 'ghcr.io/example/autoworker-job:latest', digest: false },
  { image: `ghcr.io/example/autoworker-job@sha256:${'a'.repeat(64)}`, digest: true },
  { image: `127.0.0.1:5001/autoworker-job:verify@sha256:${'b'.repeat(64)}`, digest: true },
  { image: `ghcr.io/example/autoworker-job@sha256:${'c'.repeat(63)}`, digest: false },
  { image: `ghcr.io/example/autoworker-job@sha512:${'d'.repeat(64)}`, digest: false },
] as const;

async function imageColumn(): Promise<Check> {
  return withPostgres(async postgres => {
    const scratch = await postgres.scratch();
    const db = connect(scratch.stableUrl, 1);
    try {
      const person = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada' }).returning('id').executeTakeFirstOrThrow();
      const repository = await db
        .with('saved', query => query.insertInto('human_action').values({ id: randomUUID(), at: new Date(), person_id: person.id, kind: 'add_repository', repository_id: 1 }).returning('id'))
        .insertInto('repository')
        .columns(['github', 'branch', 'saved_by'])
        .expression(eb => eb.selectFrom('saved').select([eb.val('example/sandbox').as('github'), eb.val('main').as('branch'), 'saved.id']))
        .returning('id')
        .executeTakeFirstOrThrow();
      const problems: string[] = [];
      const seen: string[] = [];
      for (const { image, digest } of samples) {
        let column = 'accepted';
        try {
          await db.updateTable('repository').set({ job_image: image }).where('id', '=', repository.id).execute();
        } catch (error) {
          const found = refusal(error);
          column = found !== undefined && 'name' in found ? found.name : String(error);
        }
        const parsed = imageReference.safeParse(image).success;
        seen.push(`${image.slice(0, 48)}: column ${column}, settings ${parsed ? 'accepted' : 'refused'}`);
        if ((column === 'accepted') !== digest || parsed !== digest || (!digest && column !== 'job_image_named_by_digest')) problems.push(seen.at(-1) ?? image);
      }
      const name = 'the repository column and the settings parse accept only an image named by digest, and agree on every sample';
      return problems.length === 0 ? pass(name, seen.join('; ')) : fail(name, problems.join('; '));
    } finally {
      await db.destroy();
      await scratch.drop();
    }
  });
}

const fakeAccessToken = `e30.${Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url')}.sig`;

function refreshTokenRefused(): Check {
  const planted = 'rt-planted-refresh-token-value';
  const env = {
    PATH: process.env['PATH'] ?? '',
    ATTEMPT_ID: '7',
    ATTEMPT_TOKEN: 'a'.repeat(48),
    ENGINE_URL: 'http://engine.example:8080',
    REPO_URL: 'https://example.com/repo.git',
    START_COMMIT: 'f'.repeat(40),
    ATTEMPT_BRANCH: 'autoworker/K-1-attempt-1',
    GITHUB_TOKEN: 'planted-github-token',
    CODEX_AUTH_JSON: JSON.stringify({ tokens: { access_token: fakeAccessToken, refresh_token: planted } }),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
  };
  const started = spawnSync(process.execPath, [jobMain], { env, encoding: 'utf8', timeout: 30_000 });
  const said = `${started.stdout}${started.stderr}`;
  const name = "the Job's entry point refuses a login that holds a refresh token, names the key, and prints no value";
  const leaked = [planted, fakeAccessToken, 'planted-github-token', 'a'.repeat(48)].some(value => said.includes(value));
  return started.status === 1 && said.includes('CODEX_AUTH_JSON must be an access-only Codex auth.json') && !leaked ? pass(name, said.trim().replaceAll('\n', ' | ')) : fail(name, `exit ${String(started.status)}, leaked ${String(leaked)}`);
}

async function pins(): Promise<Check> {
  const job = await readFile(join(root, 'services', 'job', 'Dockerfile'), 'utf8');
  const tools = await readFile(join(root, 'tools', 'verify', 'Dockerfile'), 'utf8');
  const base = (text: string): string | undefined => /^ARG NODE_IMAGE=(node:[^\s@]+@sha256:[0-9a-f]{64})$/m.exec(text)?.[1];
  const codex = (text: string): string | undefined => /@openai\/codex@(\d+\.\d+\.\d+)\b/.exec(text)?.[1];
  const name = 'the attempt image pins the same base digest and Codex CLI as the verify image';
  const same = base(job) !== undefined && base(job) === base(tools) && codex(job) !== undefined && codex(job) === codex(tools);
  return same ? pass(name, `${base(job) ?? ''}, @openai/codex@${codex(job) ?? ''}`) : fail(name, `job ${base(job) ?? 'none'} ${codex(job) ?? 'none'}, verify ${base(tools) ?? 'none'} ${codex(tools) ?? 'none'}`);
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'jobs',
    summary: "proves the launcher's invariants without a cluster: the AccessOnlyLogin input, the digest-only image column, the boundaries of services/job, and the pins",
    run: async () => [typeGuards(), ...(await boundaryPlants()), await imageColumn(), refreshTokenRefused(), await pins()],
  },
  liveScenario,
];
