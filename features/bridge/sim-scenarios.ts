import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect } from '../../shared/db/client.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { issueToken, nulStandIn, numberCommand, pollCommands, receive, rules, sendCommand, type BridgeEngine } from './engine.ts';
import { provePlants, world, worldStartsAt } from './invariants.ts';
import { attemptId, bridgeRequestIds, commandRequestId, protocolVersion, type Caller, type EventsPost } from './protocol.ts';
import { droppedBy, mutantName, mutants, noMutantYet, simulate, type MutantName, type Plan, type Run } from './simulate.ts';

const flags = { seeds: { type: 'string' }, seed: { type: 'string' }, steps: { type: 'string' }, mutant: { type: 'string' }, trace: { type: 'string' } } as const;

const whole = z.coerce.number().int().positive();

const simulationOptions = z.object({
  seeds: whole.default(200),
  seed: whole.optional(),
  steps: whole.default(300),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
  trace: z.string().min(1).optional(),
});

type Options = z.infer<typeof simulationOptions>;

const mutantSeeds = 20;

const seedList = (options: Options, count: number): readonly number[] => (options.seed === undefined ? Array.from({ length: count }, (_, index) => index + 1) : [options.seed]);

const replayOf = (run: Run): string =>
  `npm run verify -- bridge-sim --seed ${String(run.seed)} --steps ${String(run.plan.steps)}${run.plan.mutant === undefined ? '' : ` --mutant ${run.plan.mutant}`}`;

const brokenNames = (run: Run): string => [...new Set(run.failure?.broken.map(found => found.property) ?? [])].join(', ');

const failureOf = (run: Run): string =>
  run.failure === undefined
    ? ''
    : `seed ${String(run.seed)} broke ${brokenNames(run)} at step ${String(run.failure.step)} after ${run.failure.move} "${run.failure.said}" (${JSON.stringify(run.failure.broken[0]?.row)}); replay with ${replayOf(run)}; last moves: ${run.log.slice(-4).join(' | ')}`;

const tracer =
  (options: Options) =>
  (run: Run): void => {
    if (options.trace === undefined || (run.failure === undefined && run.ended > 0)) return;
    mkdirSync(options.trace, { recursive: true });
    const file = join(options.trace, `bridge-sim-seed-${String(run.seed)}${run.plan.mutant === undefined ? '' : `-${run.plan.mutant}`}.log`);
    writeFileSync(file, `${[...run.log, `failure: ${JSON.stringify(run.failure)}`].join('\n')}\n`);
  };

const sum = (runs: readonly Run[], what: string): number => runs.reduce((total, run) => total + (run.counts[what] ?? 0), 0);

async function cleanSeeds(postgres: TestPostgres, options: Options): Promise<readonly Check[]> {
  const plan: Plan = { seeds: seedList(options, options.seeds), steps: options.steps };
  const started = performance.now();
  const runs = await simulate(postgres, [plan], tracer(options));
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const idle = runs.filter(run => run.ended === 0);
  const erred = runs.filter(run => run.errors.length > 0);
  const tallies = ['engine crashes', 'duplicated posts', 'unanswered posts', 'dropped posts', 'late posts delivered', 'posts that skip a number', 'broken streams', 'bridge hangs', 'bridge crashes', 'steers', 'stops', 'reaps', 'attempts pass', 'attempts lost', 'attempts stopped', 'attempts live'];
  const name = `${String(runs.length)} seeds, ${String(failed.length)} violations`;
  return [
    failed.length === 0
      ? pass(name, `${String(options.steps)} steps a seed, 2 attempts a seed, in ${seconds.toFixed(1)} s: ${tallies.map(what => `${String(sum(runs, what))} ${what}`).join(', ')}`)
      : fail(name, failed.slice(0, 3).map(failureOf).join('; ')),
    idle.length === 0
      ? pass('every seed finished an attempt through its end line', `attempts finished through their end line: ${String(runs.reduce((total, run) => total + run.ended, 0))} of ${String(runs.length * 2)}`)
      : fail('every seed finished an attempt through its end line', `seeds ${idle.map(run => String(run.seed)).join(', ')} finished none`),
    erred.length === 0
      ? pass('the engine answered every call without an unexpected error', `${String(runs.length)} seeds`)
      : fail('the engine answered every call without an unexpected error', erred.slice(0, 3).map(run => `seed ${String(run.seed)}: ${run.errors[0] ?? ''}`).join('; ')),
  ];
}

async function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: Options): Promise<Check> {
  const { breaks: expected, shape } = mutants[mutant];
  const runs = await simulate(postgres, [{ seeds: seedList(options, Math.min(options.seeds, mutantSeeds)), steps: options.steps, mutant }], tracer(options));
  const breaking = runs.filter(run => run.failure !== undefined && run.failure.broken.some(found => expected.includes(found.property)) && (shape?.holds(run.failure) ?? true));
  const name = `${expected.join(' or ')} fails under the ${mutant} mutant${shape === undefined ? '' : `, ${shape.label}`}`;
  const first = breaking[0];
  return first === undefined
    ? fail(name, `no seed of ${String(runs.length)} broke it; ${runs.filter(run => run.failure !== undefined).slice(0, 2).map(failureOf).join('; ')}`)
    : pass(name, `${String(breaking.length)} of ${String(runs.length)} seeds; first: ${failureOf(first)}`);
}

async function plantChecks(postgres: TestPostgres): Promise<Check> {
  const proofs = await provePlants(postgres);
  const wrong = proofs.filter(proof => proof.atStart.length > 0 || !proof.reported.includes(proof.property));
  const name = 'each property reports its planted violation, and nothing before it';
  return wrong.length === 0 ? pass(name, `${String(proofs.length)} plants: ${proofs.map(proof => proof.property).join(', ')}`) : fail(name, JSON.stringify(wrong));
}

async function catalogCheck(postgres: TestPostgres): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    const { rows: scoped } = await sql<{ name: string }>`
      select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid left join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.conrelid in ('attempt_event'::regclass, 'attempt_command'::regclass)
        and not (c.contype = 'p' and c.conname = t.relname || '_pkey') and not (c.contype = 'n' and c.conname = t.relname || '_' || a.attname || '_not_null')
      union all
      select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
      where x.indrelid in ('attempt_event'::regclass, 'attempt_command'::regclass) and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
      union all
      select tgname from pg_trigger where tgrelid in ('attempt_event'::regclass, 'attempt_command'::regclass) and not tgisinternal`.execute(db);
    const { rows: everywhere } = await sql<{ name: string }>`
      select conname as name from pg_constraint union select tgname from pg_trigger where not tgisinternal union select relname from pg_class where relkind = 'i'`.execute(db);
    const guards = scoped.map(row => row.name);
    const known = new Set(everywhere.map(row => row.name));
    const listed = [...mutantName.options.flatMap(droppedBy), ...Object.values(noMutantYet).flat()];
    const problems = [
      ...guards.filter(guard => !listed.includes(guard)).map(guard => `${guard} is in neither list`),
      ...listed.filter(listedName => !known.has(listedName)).map(listedName => `${listedName} is listed, but the schema has no such guard`),
    ];
    const name = 'every named constraint, index, and trigger on attempt_event and attempt_command has a mutant or a reason in noMutantYet';
    return problems.length === 0 ? pass(name, guards.join(', ')) : fail(name, problems.join('; '));
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const engine: BridgeEngine = {
  leaseMs: 30_000,
  finish: () => Promise.reject(new Error('no refusal check posts an end line')),
  now: () => new Date(worldStartsAt),
  rules,
};

const lineOf = (seq: number): EventsPost['lines'][number] => ({ kind: 'app', seq, text: JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }) });

async function refusalChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    for (const statement of world) await statement.execute(db);
    const first = attemptId.parse('1');
    const second = attemptId.parse('2');
    const firstToken = await issueToken(db, first);
    const secondToken = await issueToken(db, second);
    if (firstToken === undefined || secondToken === undefined) throw new Error('the world attempts took no token');
    const bound: Caller = { attempt: first, token: firstToken, protocol: protocolVersion, pid: 7001, image: 'autoworker-job:current' };
    const stored = async (attempt: string): Promise<number> =>
      Number((await db.selectFrom('attempt_event').select(eb => eb.fn.countAll<string>().as('rows')).where('attempt_id', '=', attempt).executeTakeFirstOrThrow()).rows);
    const accepted = await receive(db, engine, bound, { received: 0, lines: [lineOf(1)] });
    const token = await receive(db, engine, { ...bound, attempt: second }, { received: 0, lines: [lineOf(1)] });
    const secondProcess = await receive(db, engine, { ...bound, pid: 7002 }, { received: 0, lines: [lineOf(2)] });
    const oldImage = 'autoworker-job:before-protocol-2';
    const protocol = await receive(db, engine, { ...bound, protocol: protocolVersion + 1, image: oldImage }, { received: 0, lines: [lineOf(2)] });
    const counts = { first: await stored(first), second: await stored(second) };
    const tokenName = "a post that carries another attempt's token is refused as token and stores nothing";
    const processName = 'a post from a second bridge process after the first bound the attempt is refused as process and stores nothing';
    const protocolName = 'a post that speaks another protocol number is refused as protocol, names the image, and stores nothing';
    const said = (answer: unknown): string => JSON.stringify(answer);
    return [
      'stored' in accepted && accepted.stored === 1 && 'refused' in token && token.refused === 'token' && counts.second === 0
        ? pass(tokenName, `${said(token)}; attempt 2 holds ${String(counts.second)} lines`)
        : fail(tokenName, `first post ${said(accepted)}, planted post ${said(token)}, attempt 2 holds ${String(counts.second)} lines`),
      'refused' in secondProcess && secondProcess.refused === 'process' && counts.first === 1
        ? pass(processName, `${said(secondProcess)}; attempt 1 holds ${String(counts.first)} line`)
        : fail(processName, `${said(secondProcess)}; attempt 1 holds ${String(counts.first)} lines`),
      'refused' in protocol && protocol.refused === 'protocol' && protocol.reason.includes(oldImage) && counts.first === 1
        ? pass(protocolName, said(protocol))
        : fail(protocolName, `${said(protocol)}; attempt 1 holds ${String(counts.first)} lines`),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const afterEndName = 'once an attempt has ended, its command stream carries only the turn.stop frames that directly follow what the bridge applied';

async function afterEndCheck(postgres: TestPostgres): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    for (const statement of world) await statement.execute(db);
    const attempt = attemptId.parse('1');
    const token = await issueToken(db, attempt);
    if (token === undefined) throw new Error('the world attempt took no token');
    const caller: Caller = { attempt, token, protocol: protocolVersion, pid: 7001, image: 'autoworker-job:current' };
    const now = new Date(worldStartsAt);
    await sendCommand(db, attempt, { kind: 'turn.start', prompt: 'Do the work.', outputSchema: null }, now);
    const answers = [JSON.stringify({ id: bridgeRequestIds.threadStart, result: { thread: { id: 'thread-1' } } }), JSON.stringify({ id: commandRequestId(1), result: { turn: { id: 'turn-1' } } })];
    await receive(db, engine, caller, { received: 1, lines: answers.map((text, index) => ({ kind: 'app', seq: index + 1, text })) });
    await sendCommand(db, attempt, { kind: 'turn.steer', message: 'Also check the edge case.' }, now);
    await db.transaction().execute(async writer => {
      await numberCommand(writer, attempt, { kind: 'turn.stop' }, now);
      await writer.updateTable('attempt').set({ finished_at: now, verdict: 'stopped' }).where('id', '=', attempt).execute();
    });
    const seqs = async (after: number): Promise<string> => {
      const polled = await pollCommands(db, attempt, after);
      return `${polled.frames.map(frame => `${String(frame.seq)} ${frame.request.method}`).join(', ') || 'nothing'}${polled.ended ? ', then the end' : ''}`;
    };
    const afterStart = await seqs(1);
    const afterSteer = await seqs(2);
    const said = `after the start the stream sends ${afterStart}; after the steer it sends ${afterSteer}`;
    return afterStart === 'nothing, then the end' && afterSteer === '3 turn/interrupt, then the end' ? pass(afterEndName, said) : fail(afterEndName, said);
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const nulName ='a line whose text carries NUL is stored with U+FFFD in its place, in app lines, lines that are not JSON, and reproduced lines';

async function nulCheck(postgres: TestPostgres): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    for (const statement of world) await statement.execute(db);
    const attempt = attemptId.parse('1');
    const token = await issueToken(db, attempt);
    if (token === undefined) throw new Error('the world attempt took no token');
    const caller: Caller = { attempt, token, protocol: protocolVersion, pid: 7001, image: 'autoworker-job:current' };
    const lines: EventsPost['lines'] = [
      { kind: 'app', seq: 1, text: JSON.stringify({ method: 'item/commandExecution/outputDelta', params: { itemId: 'item-\u0000-1', delta: 'binary \u0000 output', ['key\u0000']: true } }) },
      { kind: 'app', seq: 2, text: 'not json \u0000 at all' },
      { kind: 'reproduced', seq: 3, reproduction: { state: 'no_script', reason: 'the log held \u0000' } },
    ];
    const answer = await receive(db, engine, caller, { received: 0, lines });
    const rows = await db.selectFrom('attempt_event').select(['seq', 'item_id', sql<string>`body::text`.as('body')]).where('attempt_id', '=', attempt).orderBy('seq').execute();
    const standIns = rows.filter(row => row.body.includes(nulStandIn) && !row.body.includes('\\u0000')).length;
    const said = `answer ${JSON.stringify(answer)}; ${String(rows.length)} rows, ${String(standIns)} with U+FFFD; item id ${JSON.stringify(rows[0]?.item_id ?? null)}`;
    return 'stored' in answer && answer.stored === 3 && rows.length === 3 && standIns === 3 && rows[0]?.item_id === `item-${nulStandIn}-1` ? pass(nulName, said) : fail(nulName, said);
  } catch (error) {
    return fail(nulName, error instanceof Error ? error.message : String(error));
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const textBlock = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'body'],
  properties: { kind: { type: 'string', enum: ['text'] }, title: { type: ['string', 'null'] }, body: { type: 'string' } },
};

const declaredSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'blocks'],
  properties: { outcome: { type: 'string', enum: ['done', 'needs_input', 'blocked'] }, blocks: { type: 'array', items: { anyOf: [textBlock] } } },
};

const deliveredSchema = z.object({ request: z.object({ params: z.object({ outputSchema: z.json() }) }) });

async function schemaOrderCheck(postgres: TestPostgres): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    for (const statement of world) await statement.execute(db);
    const attempt = attemptId.parse('1');
    const token = await issueToken(db, attempt);
    if (token === undefined) throw new Error('the world attempt took no token');
    const caller: Caller = { attempt, token, protocol: protocolVersion, pid: 7001, image: 'autoworker-job:current' };
    const threadStarted = JSON.stringify({ id: bridgeRequestIds.threadStart, result: { thread: { id: 'thread-1' } } });
    await receive(db, engine, caller, { received: 0, lines: [{ kind: 'app', seq: 1, text: threadStarted }] });
    await sendCommand(db, attempt, { kind: 'turn.start', prompt: 'Plan the change.', outputSchema: declaredSchema }, new Date(worldStartsAt));
    const frame = deliveredSchema.safeParse((await pollCommands(db, attempt, 0)).frames[0]);
    const sent = JSON.stringify(declaredSchema);
    const delivered = frame.success ? JSON.stringify(frame.data.request.params.outputSchema) : 'no turn/start frame';
    const name = "a turn's output schema reaches the app server with its keys in the order the step declared them, so every block kind still starts with kind";
    return delivered === sent ? pass(name, delivered) : fail(name, `sent ${sent}; delivered ${delivered}`);
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function simulationChecks(postgres: TestPostgres, options: Options): Promise<readonly Check[]> {
  if (options.mutant === 'all') {
    const checks: Check[] = [await plantChecks(postgres), await catalogCheck(postgres), ...(await refusalChecks(postgres)), await schemaOrderCheck(postgres), await nulCheck(postgres), await afterEndCheck(postgres)];
    for (const mutant of mutantName.options) checks.push(await mutantCheck(postgres, mutant, options));
    return checks;
  }
  if (options.mutant !== undefined) return [await mutantCheck(postgres, options.mutant, options)];
  return [...(await cleanSeeds(postgres, options)), await plantChecks(postgres), ...(await refusalChecks(postgres)), await schemaOrderCheck(postgres), await nulCheck(postgres), await afterEndCheck(postgres)];
}

function parseOptions(args: readonly string[]): Options {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: flags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

export const simScenarios: readonly Scenario[] = [
  {
    name: 'bridge-sim',
    summary:
      "runs the engine's bridge endpoint and the Job's outbox and applier against real Postgres and a fake app server, with dropped, duplicated, unanswered, late, and gapped posts, engine and bridge crashes, hangs, reaps, steers, and stops, and checks every property of the Bridge model; --mutant all proves each guard can fail",
    run: args => {
      const options = parseOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
  },
];
