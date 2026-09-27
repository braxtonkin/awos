import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { github } from '../../shared/repository-settings.ts';
import { everyMinutes, words } from '../../shared/routine-draft.ts';
import { fail, info, pass, type Check, type Line, type Scenario } from '../../tools/verify/check.ts';
import { agents, buildDashboard, dashboardAnswers, loginUrl, startDashboard, type Agent } from '../../tools/verify/dashboard.ts';
import { docker } from '../../tools/verify/docker.ts';
import { engineHandlesSigtermFrom } from '../../tools/verify/engine.ts';
import { adminClient, withPostgres } from '../../tools/verify/postgres.ts';
import { closeStore, driverSettings, inJobNamespace, openStore, setUpAutoWorker, supervise, until, type Plan, type Store, type Supervised } from './autoworker.ts';
import { openWorld } from './open-world.ts';
import { sandboxCommands, sandboxSeed } from './sandbox-seed.ts';
import { worldNames, type WorldName } from './world.ts';

const engineReadyMs = 60_000;
const engineStopGraceMs = 150_000;
const engineStopped = 'The engine stopped.';

type Hold = { readonly world: WorldName; readonly agent: Agent; readonly repository: string; readonly base: string; readonly jql: string; readonly everyMinutes: number; readonly commands: Plan['commands']; readonly port: number };

const defaults: Readonly<Record<WorldName, { readonly agent: Agent; readonly repository: string | undefined; readonly commands: Plan['commands'] }>> = {
  sandbox: { agent: 'real', repository: undefined, commands: { fastTest: undefined, setup: undefined } },
  local: { agent: 'stand-in', repository: 'example/sandbox', commands: sandboxCommands },
};

const holdOptions = {
  world: { type: 'string', default: 'sandbox' },
  agent: { type: 'string' },
  repository: { type: 'string' },
  base: { type: 'string', default: 'main' },
  jql: { type: 'string' },
  every: { type: 'string', default: '1' },
  'fast-test': { type: 'string' },
  setup: { type: 'string' },
  port: { type: 'string', default: '4860' },
} as const;

const refusals = (error: z.ZodError): string => error.issues.map(issue => issue.message).join('; ');

function holdFrom(args: readonly string[]): Hold | Check {
  const { values } = parseArgs({ args: [...args], options: holdOptions, strict: true });
  const world = worldNames.find(name => name === values.world);
  if (world === undefined) return fail('world named', `--world must be one of ${worldNames.join(', ')}`);
  const agent = agents.find(name => name === (values.agent ?? defaults[world].agent));
  if (agent === undefined) return fail('agent named', `--agent must be one of ${agents.join(', ')}`);
  if (world === 'sandbox' && agent === 'stand-in') return fail('agent fits the world', 'the stand-in solves only the sandbox catalog, so --agent stand-in runs only with --world local');
  const named = values.repository ?? defaults[world].repository;
  if (named === undefined) return fail('repository named', '--world sandbox needs --repository owner/name, the repository whose base branch the routine works on');
  const repository = github.safeParse(named);
  if (!repository.success) return fail('repository named', `--repository ${refusals(repository.error)}`);
  const base = words.safeParse(values.base);
  if (!base.success) return fail('base named', `--base ${refusals(base.error)}`);
  if (values.jql === undefined) return fail('jql given', '--jql names the Jira search the routine runs, and the hold needs one');
  const jql = words.safeParse(values.jql);
  if (!jql.success) return fail('jql given', `--jql ${refusals(jql.error)}`);
  const every = everyMinutes.safeParse(Number(values.every));
  if (!every.success) return fail('every given', `--every ${refusals(every.error)}`);
  const blank = (['fast-test', 'setup'] as const).find(flag => values[flag]?.trim() === '');
  if (blank !== undefined) return fail('command given', `--${blank} must not be blank`);
  const commands = { fastTest: values['fast-test']?.trim() ?? defaults[world].commands.fastTest, setup: values.setup?.trim() ?? defaults[world].commands.setup };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return fail('port given', '--port takes a whole number from 1 to 65535, the port the dashboard listens on inside this container');
  return { world, agent, repository: repository.data, base: base.data, jql: jql.data, everyMinutes: every.data, commands, port };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

type Told = 'SIGTERM' | 'SIGINT' | 'a stop line on standard input';

type Stop = { readonly signal: AbortSignal; readonly told: () => Told | undefined };

type Listening = Stop & { readonly close: () => void };

function listenForStop(): Listening {
  const stopping = new AbortController();
  let told: Told | undefined;
  const tell = (why: Told): void => {
    told ??= why;
    stopping.abort();
  };
  const terminated = (): void => {
    tell('SIGTERM');
  };
  const interrupted = (): void => {
    tell('SIGINT');
  };
  const typed = createInterface({ input: process.stdin });
  typed.on('line', text => {
    if (text.trim() === 'stop') tell('a stop line on standard input');
    else if (text.trim() !== '') out('The hold reads only a stop line on its standard input, so it ignored that line.');
  });
  process.on('SIGTERM', terminated).on('SIGINT', interrupted);
  return {
    signal: stopping.signal,
    told: () => told,
    close: () => {
      process.off('SIGTERM', terminated).off('SIGINT', interrupted);
      typed.close();
    },
  };
}

type Routine = Awaited<ReturnType<typeof readRoutine>>;

async function readRoutine(db: Database) {
  const routine = await db
    .selectFrom('routine')
    .innerJoin('routine_version as version', 'version.routine_id', 'routine.id')
    .leftJoin('repository', 'repository.id', 'version.repository_id')
    .select([
      'routine.id',
      'version.version',
      'version.name',
      sql<string | null>`version.source ->> 'jql'`.as('jql'),
      sql<number>`(extract(epoch from version.every) / 60)::float8`.as('everyMinutes'),
      'repository.github',
      'repository.branch',
      'repository.fast_test_command',
      'repository.setup_command',
    ])
    .orderBy('version.version', 'desc')
    .executeTakeFirst();
  if (routine === undefined) throw new Error('setup passed, but Postgres holds no routine');
  return routine;
}

const described = (routine: Routine): string =>
  `routine ${routine.id} version ${String(routine.version)}, ${routine.name}, searches Jira with ${routine.jql ?? 'no JQL'} every ${String(routine.everyMinutes)} min and works on ${routine.github ?? 'no repository'} branch ${routine.branch ?? 'none'}, with the fast test command ${routine.fast_test_command ?? "unset, so Verify runs the repository's CI checks"} and the setup command ${routine.setup_command ?? 'unset'}`;

const inspected = z.object({
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }),
  HostConfig: z.object({ PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()).nullable() }),
});

type Reach = { readonly listen: string; readonly host: string | undefined };

async function reach(port: number): Promise<Reach> {
  const reply = await docker('GET', `/containers/${hostname()}/json`);
  const parsed = inspected.safeParse(reply.body);
  if (reply.status !== 200 || !parsed.success) throw new Error(`the Docker API answered ${String(reply.status)} to an inspect of this container, without the networks and port bindings the hold reads`);
  const networks = Object.entries(parsed.data.NetworkSettings.Networks);
  const others = networks.filter(([name]) => name !== 'kind');
  const [only] = others;
  if (others.length !== 1 || only === undefined || only[1].IPAddress === '') {
    const found = networks.map(([name, network]) => `${name} ${network.IPAddress === '' ? 'without an address' : network.IPAddress}`).join(', ');
    throw new Error(`the dashboard listens on this container's one network besides kind, but the container is on ${found || 'no network'}`);
  }
  const binding = parsed.data.HostConfig.PortBindings?.[`${String(port)}/tcp`]?.[0];
  return { listen: only[1].IPAddress, host: binding === undefined ? undefined : `http://${binding.HostIp === '' || binding.HostIp === '0.0.0.0' ? '127.0.0.1' : binding.HostIp}:${binding.HostPort}` };
}

async function dashboardLogin(url: string): Promise<string> {
  const admin = adminClient(url);
  try {
    return await loginUrl(admin, url);
  } finally {
    await admin.destroy();
  }
}

async function listedCheck(origin: string, routine: Routine): Promise<Check> {
  const name = 'the dashboard lists the routine';
  const link = `href="/routines/${routine.id}"`;
  const answer = await fetch(`${origin}/routines`);
  const page = await answer.text();
  return page.includes(link) && page.includes(routine.name) ? pass(name, `${origin}/routines links /routines/${routine.id} as ${routine.name}`) : fail(name, `${origin}/routines answered ${String(answer.status)} without both ${link} and ${routine.name}`);
}

const lastLines = (said: string): string =>
  said
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-5)
    .join(' | ');

async function bridgeCheck(engine: Supervised, stop: Stop): Promise<Check | undefined> {
  const name = 'the engine serves the bridge';
  const served = (): string | undefined => engine.said().split('\n').find(line => line.includes(engineHandlesSigtermFrom));
  await until(engineReadyMs, () => Promise.resolve(served() !== undefined || stop.told() !== undefined ? true : undefined));
  const line = served();
  if (line !== undefined) return pass(name, line.trim());
  return stop.told() === undefined ? fail(name, `no "${engineHandlesSigtermFrom}" line within ${String(engineReadyMs / 1000)} s; the engine said last: ${lastLines(engine.said())}`) : undefined;
}

const stoppedCheck = (said: string): Check => {
  const name = 'the engine finished its pass and stopped';
  const last = said
    .split('\n')
    .filter(line => line.trim() !== '')
    .at(-1)
    ?.trim();
  return last === engineStopped ? pass(name, engineStopped) : fail(name, `the engine said last: ${lastLines(said)}`);
};

async function serve(port: number, store: Store, routine: Routine, settings: Readonly<Record<string, string>>, namespace: string, stop: Stop): Promise<readonly Line[]> {
  const where = await reach(port);
  const dashboard = startDashboard(await dashboardLogin(store.url), { CREDENTIAL_KEY: store.key, CREDENTIAL_KEY_VERSION: '1' }, where.listen, port, out);
  const lines: Line[] = [];
  let engine: Supervised | undefined;
  try {
    await dashboardAnswers(dashboard);
    lines.push(pass('the dashboard answers', dashboard.origin), await listedCheck(dashboard.origin, routine));
    const address = where.host ?? `${dashboard.origin}, which only this container reaches, because port ${String(port)} is not published; -p 127.0.0.1:${String(port)}:${String(port)} on docker compose run publishes it`;
    const page = where.host === undefined ? undefined : `${where.host}/routines/${routine.id}`;
    out(`dashboard at ${address}`);
    if (page !== undefined) out(`routine at ${page}`);
    lines.push(info('the dashboard address', 'passed', address), info('the routine', 'passed', page === undefined ? described(routine) : `${described(routine)}, at ${page}`));
    if (stop.told() === undefined) {
      engine = supervise(store, settings, stop.signal, out, out);
      const bridge = await bridgeCheck(engine, stop);
      if (bridge !== undefined) lines.push(bridge);
      if (bridge?.passed === true && stop.told() === undefined) {
        out(`JOB_NAMESPACE=${namespace}`);
        out(`DATABASE_URL=${store.url}`);
        out(`The hold runs until SIGTERM or a stop line on its standard input. From the host, docker stop -t 200 ${hostname()} sends SIGTERM, which reaches the hold only when node, not npm, is the container's command.`);
        await once(stop.signal, 'abort');
      }
    }
  } finally {
    await dashboard.stop();
    await engine?.stop(engineStopGraceMs);
  }
  return engine === undefined ? lines : [...lines, info('engine starts', 'passed', String(engine.starts())), stoppedCheck(engine.said())];
}

async function holdAutoWorker(hold: Hold, stop: Stop): Promise<readonly Line[]> {
  const built = await buildDashboard(false, line => {
    out(`next build: ${line}`);
  });
  out(`next build: ${built.seconds === undefined ? built.output : `${built.seconds.toFixed(1)} s`}`);
  if (stop.told() !== undefined) return [];
  const world = await openWorld(hold.world, hold.repository, hold.agent);
  try {
    out(`world ${world.name}: ${Object.entries(world.engine.settings).map(([setting, value]) => `${setting}=${value}`).join(' ')}`);
    if (hold.world === 'local') await world.github.seedBranch(hold.base, await sandboxSeed(), 'Seed the local sandbox');
    if (stop.told() !== undefined) return [];
    const namespace = `hold-${randomBytes(4).toString('hex')}`;
    return await inJobNamespace(world.engine, namespace, out, cluster =>
      withPostgres(async postgres => {
        const scratch = await postgres.scratch();
        const store = await openStore(scratch.url);
        try {
          const plan: Plan = {
            owner: world.jira.email.toLowerCase(),
            accountId: await world.jira.accountId(),
            repository: hold.repository,
            branch: hold.base,
            commands: hold.commands,
            routine: { name: `e2e-hold for ${hold.repository}`, goal: `Take each ticket the search finds to a pull request merged into ${hold.base}.`, jql: hold.jql, everyMinutes: hold.everyMinutes, runAs: 'owner' },
          };
          out(`setup: ${await setUpAutoWorker(store, world.engine, plan)}`);
          const routine = await readRoutine(store.db);
          out(described(routine));
          return stop.told() === undefined ? await serve(hold.port, store, routine, driverSettings(world.engine.settings, cluster.image, namespace, cluster.address), namespace, stop) : [];
        } finally {
          await closeStore(store);
          await scratch.drop();
        }
      }),
    );
  } finally {
    await world.stop();
  }
}

export const holdScenario: Scenario = {
  name: 'e2e-hold',
  summary: [
    'holds AutoWorker against the --base branch, default main, of --repository until SIGTERM or a stop line on its standard input,',
    "with the engine's Jobs on kind and the dashboard on --port, default 4860, at this container's compose-network address, which -p 127.0.0.1:4860:4860 on docker compose run publishes to the host,",
    "and one routine that runs as the Jira login's owner and searches Jira with --jql every --every minutes, default 1;",
    "--fast-test and --setup set the repository's commands, --world sandbox, the default, needs --repository and runs real Codex,",
    'and --world local runs offline against fakes, with the sandbox seeded on --base and the Codex stand-in unless --agent real',
  ].join(' '),
  run: async args => {
    const hold = holdFrom(args);
    if ('passed' in hold) return [hold];
    const listening = listenForStop();
    try {
      const lines = await holdAutoWorker(hold, listening);
      const told = listening.told();
      return told === undefined ? lines : [...lines, pass('the hold stopped when told', told)];
    } finally {
      listening.close();
    }
  },
};
