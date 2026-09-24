import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { FragmentMethod } from '../../shared/items.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { finalMessageOf, issueToken, numberCommand, openCommands, pollCommands, receive, rules, sendCommand, type BridgeEngine, type Finish, type Rules } from './engine.ts';
import { simulatorSchema, violations, world, worldLeaseMs, worldStartsAt, type PropertyName, type Violation } from './invariants.ts';
import { applier, outbox, threadStart, type Applier, type Outbox } from './job.ts';
import {
  appMessage,
  attemptId,
  bridgeRequestIds,
  commandFrame,
  commandRequest,
  eventsPost,
  protocolVersion,
  turnCompleted,
  type AttemptId,
  type Caller,
  type CommandFrame,
  type EventsAnswer,
  type Line,
  type Refused,
} from './protocol.ts';

type Drop = { readonly kind: 'trigger' | 'constraint'; readonly table: 'attempt' | 'attempt_event' | 'attempt_command'; readonly name: string };

type SimBreak = 'ack-inside-commit' | 'drop-failed-batch' | 'replay-every-command' | 'no-lease-grace' | 'engine-stays-down';

type Faults = 'all' | 'late-only';

export type Failure = { readonly step: number; readonly move: MoveName | 'quiet phase'; readonly said: string; readonly broken: readonly Violation[] };

type Shape = { readonly label: string; readonly holds: (failure: Failure) => boolean };

type Mutant = {
  readonly breaks: readonly [PropertyName, ...PropertyName[]];
  readonly rules?: Partial<Rules>;
  readonly drops?: readonly Drop[];
  readonly sim?: SimBreak;
  readonly faults?: Faults;
  readonly shape?: Shape;
  readonly weights?: Partial<Record<MoveName, number>>;
  readonly linesPerPost?: number;
};

export const mutantName = z.enum([
  'GapIsRefused',
  'DuplicateIsDropped',
  'AckFollowsCommit',
  'BridgeResendsUnacked',
  'CommandsAreNumbered',
  'PruneKeepsHighWater',
  'LostAttemptIsFenced',
  'RestartGraceForLeases',
  'FinishWaitsForLastLine',
  'EngineIsFair',
  'one_event_per_number',
]);

export type MutantName = z.infer<typeof mutantName>;

const storesEveryNumber: Rules['decide'] = (highest, seq) => (seq <= highest + 1 ? 'store' : 'stop');

const countsRows: Rules['highWater'] = async (writer, attempt) => {
  const { rows } = await writer.selectFrom('attempt_event').select(eb => eb.fn.countAll<string>().as('rows')).where('attempt_id', '=', attempt).executeTakeFirstOrThrow();
  return Number(rows);
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isTurnCompleted = (line: Line): boolean => line.kind === 'app' && turnCompleted.safeParse(parsedJson(line.text)).success;

const liveFence: readonly Drop[] = [
  { kind: 'trigger', table: 'attempt_event', name: 'event_needs_live_attempt' },
  { kind: 'trigger', table: 'attempt_command', name: 'command_needs_live_attempt' },
  { kind: 'trigger', table: 'attempt', name: 'finished_attempt_is_final' },
];

export const mutants: Readonly<Record<MutantName, Mutant>> = {
  GapIsRefused: { breaks: ['EventsStoredInOrder'], rules: { decide: (highest, seq) => (seq <= highest ? 'skip' : 'store') } },
  DuplicateIsDropped: {
    breaks: ['NoEventStoredTwice'],
    rules: { decide: storesEveryNumber },
    faults: 'late-only',
    linesPerPost: 1,
    shape: { label: 'by a late post that stores a pruned fragment again', holds: failure => failure.move === 'late' },
  },
  AckFollowsCommit: { breaks: ['AckedMeansStored'], sim: 'ack-inside-commit', shape: { label: 'by a crash between the acknowledgement and the commit', holds: failure => failure.said.includes('crashed before its commit') } },
  BridgeResendsUnacked: { breaks: ['EveryEventStored'], sim: 'drop-failed-batch' },
  CommandsAreNumbered: { breaks: ['CommandAppliedOnce', 'CommandsAppliedInOrder'], sim: 'replay-every-command' },
  PruneKeepsHighWater: { breaks: ['NoEventStoredTwice', 'FinishedStepKeepsItsText'], rules: { highWater: countsRows }, faults: 'late-only', linesPerPost: 1 },
  LostAttemptIsFenced: { breaks: ['LostAttemptChangesNothing'], rules: { fenced: () => false }, drops: liveFence, weights: { stop: 1 } },
  RestartGraceForLeases: { breaks: ['ReconnectedBridgeKeepsItsAttempt'], sim: 'no-lease-grace', weights: { 'engine-crash': 2 }, shape: { label: 'by a reap after an engine restart', holds: failure => failure.move === 'reap' } },
  FinishWaitsForLastLine: { breaks: ['EveryEventStored'], rules: { finishesOn: isTurnCompleted } },
  EngineIsFair: { breaks: ['EveryEventStored', 'EveryCommandApplied'], sim: 'engine-stays-down', weights: { 'engine-crash': 3, restart: 0 } },
  one_event_per_number: { breaks: ['NoEventStoredTwice'], rules: { decide: storesEveryNumber }, drops: [{ kind: 'constraint', table: 'attempt_event', name: 'one_event_per_number' }] },
};

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'no move writes a line or a command for an attempt that does not exist, so the foreign keys to attempt never refuse one': ['event_of_attempt', 'command_of_attempt'],
  'zod refuses a line numbered below 1 at the endpoint and numberCommand counts from 1, so no move reaches a zero; the checks back the parse': ['event_numbers_count_from_one', 'command_numbers_count_from_one'],
  'parseLine marks a line a fragment only when it names its item, so no move reaches a nameless fragment': ['fragment_names_its_item'],
  'fragments_by_item speeds the prune and guards no property': ['fragments_by_item'],
  'numberCommand shapes each kind of command itself, so no move reaches a row these checks refuse': ['command_carries_its_message', 'only_a_start_has_a_schema'],
  'storeLine sets received_at in the statement that sets acted_at, so no move acts on a command before receiving it': ['acted_on_after_received'],
  'numberCommand numbers under the attempt row lock with a fresh random message id, and the simulator runs one engine at a time, so no move reaches a second command with one number or one message id': [
    'one_command_per_number',
    'one_command_per_message',
  ],
};

export const droppedBy = (mutant: MutantName): readonly string[] => (mutants[mutant].drops ?? []).map(drop => drop.name);

const mirrored = {
  freshenLeases: 'a copy of freshenLeases in features/tasks/reaper.ts, which the engine runs each time it resumes',
  reap: 'a copy of reap in features/tasks/claim.ts, attempt rows only',
} as const;

export type Plan = { readonly seeds: readonly number[]; readonly steps: number; readonly mutant?: MutantName };

export type Run = {
  readonly seed: number;
  readonly plan: Plan;
  readonly failure: Failure | undefined;
  readonly ended: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly errors: readonly string[];
  readonly log: readonly string[];
};

const leaseMs = worldLeaseMs;
const tickMs = 50;

const weights = {
  emit: 24,
  post: 14,
  deliver: 18,
  open: 4,
  poll: 8,
  late: 3,
  skip: 1.5,
  break: 1,
  hang: 0.4,
  wake: 6,
  crash: 0.03,
  steer: 2,
  stop: 0.06,
  'engine-crash': 0.6,
  restart: 5,
  reap: 2.5,
  advance: 8,
} satisfies Readonly<Record<string, number>>;

export type MoveName = keyof typeof weights;

const faultMoves: ReadonlySet<MoveName> = new Set(['skip', 'break', 'hang', 'crash', 'engine-crash']);

const deliveries = ['once', 'twice', 'unanswered', 'dropped', 'late', 'crash-before', 'crash-after'] as const;

type Delivery = (typeof deliveries)[number];

const deliveryWeights: Readonly<Record<Faults, Readonly<Record<Delivery, number>>>> = {
  all: { once: 76, twice: 6, unanswered: 6, dropped: 5, late: 5, 'crash-before': 1, 'crash-after': 1 },
  'late-only': { once: 60, twice: 0, unanswered: 0, dropped: 0, late: 40, 'crash-before': 0, 'crash-after': 0 },
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type StepKind = 'agentMessage' | 'reasoning' | 'commandExecution';

type Step = { readonly kind: StepKind; readonly deltas: readonly string[] };

const deltaMethods: Readonly<Record<StepKind, FragmentMethod>> = {
  agentMessage: 'item/agentMessage/delta',
  reasoning: 'item/reasoning/summaryTextDelta',
  commandExecution: 'item/commandExecution/outputDelta',
};

const openedItem = (kind: StepKind, id: string): unknown =>
  kind === 'agentMessage' ? { id, type: kind, text: '' } : kind === 'reasoning' ? { id, type: kind, summary: [] } : { id, type: kind, command: 'npm test', aggregatedOutput: null };

const finishedItem = (kind: StepKind, id: string, text: string): unknown =>
  kind === 'agentMessage' ? { id, type: kind, text } : kind === 'reasoning' ? { id, type: kind, summary: [text] } : { id, type: kind, command: 'npm test', aggregatedOutput: text };

type App = {
  readonly thread: string;
  readonly label: string;
  readonly next: () => number;
  pending: string[];
  turn: string | undefined;
  script: Step[];
  turns: number;
  items: number;
};

const say = (message: unknown): string => JSON.stringify(message);

function scriptFor(next: () => number): Step[] {
  const kinds: readonly StepKind[] = ['reasoning', 'commandExecution', 'agentMessage'];
  const count = 1 + Math.floor(next() * 4);
  const steps = Array.from({ length: count }, (_, index): Step => {
    const kind = kinds[Math.floor(next() * kinds.length)] ?? 'reasoning';
    return { kind, deltas: Array.from({ length: 1 + Math.floor(next() * 3) }, (_unused, part) => `${kind} ${String(index)}.${String(part)} `) };
  });
  return [...steps, { kind: 'agentMessage', deltas: ['All ', 'done.'] }];
}

function userMessage(app: App, turn: string, clientId: string, text: string): readonly string[] {
  app.items += 1;
  const item = { id: `${app.label}-item-${String(app.items)}`, type: 'userMessage', clientId, content: [{ type: 'text', text }] };
  return [say({ method: 'item/started', params: { threadId: app.thread, turnId: turn, item } }), say({ method: 'item/completed', params: { threadId: app.thread, turnId: turn, item } })];
}

function appReads(app: App, message: unknown): void {
  const request = commandRequest.safeParse(message);
  if (!request.success) {
    const parsed = appMessage.safeParse(message);
    if (parsed.success && parsed.data.method === 'thread/start') app.pending.push(say({ id: bridgeRequestIds.threadStart, result: { thread: { id: app.thread } } }));
    return;
  }
  const { id } = request.data;
  const noTurn = say({ id, error: { code: -32600, message: 'no active turn' } });
  switch (request.data.method) {
    case 'turn/start': {
      if (app.turn !== undefined) {
        app.pending.push(say({ id, error: { code: -32600, message: 'a turn is already running' } }));
        return;
      }
      app.turns += 1;
      const turn = `${app.label}-turn-${String(app.turns)}`;
      app.turn = turn;
      app.script = scriptFor(app.next);
      app.pending.push(
        say({ id, result: { turn: { id: turn, status: 'inProgress', items: [] } } }),
        say({ method: 'turn/started', params: { threadId: app.thread, turn: { id: turn } } }),
        ...userMessage(app, turn, request.data.params.clientUserMessageId, request.data.params.input[0]?.text ?? ''),
      );
      return;
    }
    case 'turn/steer': {
      if (app.turn === undefined) {
        app.pending.push(noTurn);
        return;
      }
      app.pending.push(say({ id, result: { turnId: app.turn } }), ...userMessage(app, app.turn, request.data.params.clientUserMessageId, request.data.params.input[0]?.text ?? ''));
      return;
    }
    case 'turn/interrupt': {
      if (app.turn === undefined) {
        app.pending.push(noTurn);
        return;
      }
      app.pending = [say({ id, result: {} }), say({ method: 'turn/completed', params: { threadId: app.thread, turn: { id: app.turn, status: 'interrupted' } } })];
      app.turn = undefined;
      app.script = [];
      return;
    }
  }
}

function stepLines(app: App, turn: string, step: Step): string[] {
  app.items += 1;
  const id = `${app.label}-item-${String(app.items)}`;
  const base = { threadId: app.thread, turnId: turn };
  return [
    say({ method: 'item/started', params: { ...base, item: openedItem(step.kind, id) } }),
    ...step.deltas.map(delta => say({ method: deltaMethods[step.kind], params: { ...base, itemId: id, delta } })),
    say({ method: 'item/completed', params: { ...base, item: finishedItem(step.kind, id, step.deltas.join('')) } }),
  ];
}

function nextLine(app: App): string | undefined {
  if (app.pending.length === 0 && app.turn !== undefined) {
    const step = app.script.shift();
    if (step !== undefined) app.pending = stepLines(app, app.turn, step);
    else {
      app.pending = [say({ method: 'turn/completed', params: { threadId: app.thread, turn: { id: app.turn, status: 'completed' } } })];
      app.turn = undefined;
    }
  }
  return app.pending.shift();
}

type BridgeState = 'up' | 'hung' | 'down' | 'done';

type Bridge = {
  readonly attempt: AttemptId;
  readonly caller: Caller;
  readonly box: Outbox;
  readonly commands: Applier;
  readonly app: App;
  state: BridgeState;
  stream: { cursor: number } | undefined;
  inFlight: Post | undefined;
  initialized: boolean;
  finishing: boolean;
  endLine: number | undefined;
  highestApplied: number;
};

type Post = { readonly received: number; readonly lines: readonly Line[] };

type Late = { readonly bridge: Bridge; readonly post: Post };

type Sim = {
  readonly db: Database;
  readonly next: () => number;
  readonly mutant: Mutant | undefined;
  readonly faults: Faults;
  readonly bridges: readonly Bridge[];
  readonly late: Late[];
  readonly log: string[];
  readonly errors: string[];
  readonly counts: Record<string, number>;
  time: number;
  engine: 'up' | 'down';
};

class EngineCrashed extends Error {}

const count = (sim: Sim, what: string): void => {
  sim.counts[what] = (sim.counts[what] ?? 0) + 1;
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const finish: Finish = async (writer, attempt, now) => {
  const message = await finalMessageOf(writer, attempt);
  await writer
    .updateTable('attempt')
    .set({ finished_at: now, verdict: 'pass', output: JSON.stringify({ finalMessage: message ?? null }) })
    .where('id', '=', attempt)
    .execute();
};

const rulesOf = (sim: Sim): Rules => ({ ...rules, ...(sim.mutant?.rules ?? {}) });

const engineOf = (sim: Sim, chosen: Rules): BridgeEngine => ({ leaseMs, finish, now: () => new Date(sim.time), rules: chosen });

const breaks = (sim: Sim, what: SimBreak): boolean => sim.mutant?.sim === what;

const lastSeq = (post: Post): number => post.lines.at(-1)?.seq ?? 0;

const range = (post: Post): string => (post.lines.length === 0 ? 'no lines' : `lines ${String(post.lines[0]?.seq ?? 0)}..${String(lastSeq(post))}`);

async function call(sim: Sim, bridge: Bridge, post: Post, chosen: Rules): Promise<EventsAnswer | Refused | 'failed'> {
  try {
    return await receive(sim.db, engineOf(sim, chosen), bridge.caller, eventsPost.parse(JSON.parse(JSON.stringify(post))));
  } catch (error) {
    if (!(error instanceof EngineCrashed)) sim.errors.push(`attempt ${bridge.attempt} ${range(post)}: ${describe(error)}`);
    return 'failed';
  }
}

async function heard(sim: Sim, bridge: Bridge, answer: EventsAnswer | Refused): Promise<string> {
  if ('refused' in answer) {
    stopBridge(bridge, 'down');
    return `refused (${answer.refused}), so the bridge stops`;
  }
  await sql`insert into sim_ack (attempt_id, stored) values (${bridge.attempt}, ${answer.stored})`.execute(sim.db);
  bridge.box.acked(answer.stored);
  if (bridge.endLine !== undefined && answer.stored >= bridge.endLine) stopBridge(bridge, 'done');
  return `acknowledged up to ${String(answer.stored)}`;
}

function failed(sim: Sim, bridge: Bridge, post: Post): string {
  if (breaks(sim, 'drop-failed-batch')) {
    bridge.box.acked(lastSeq(post));
    return 'failed, and the bridge dropped the batch';
  }
  return `failed, so the bridge keeps ${String(bridge.box.pending())} lines`;
}

function stopBridge(bridge: Bridge, state: 'down' | 'done'): void {
  bridge.state = state;
  bridge.stream = undefined;
}

async function crashEngine(sim: Sim): Promise<void> {
  sim.engine = 'down';
  for (const bridge of sim.bridges) bridge.stream = undefined;
  await sql`insert into sim_outage (down_at) values (${new Date(sim.time)})`.execute(sim.db);
  count(sim, 'engine crashes');
}

async function freshenLeases(db: Database, now: Date): Promise<number> {
  const { numUpdatedRows } = await db
    .updateTable('attempt')
    .set({ lease_until: sql<Date>`greatest(lease_until, ${new Date(now.getTime() + leaseMs)})` })
    .where('finished_at', 'is', null)
    .executeTakeFirst();
  return Number(numUpdatedRows);
}

async function reapAttempts(db: Database, now: Date): Promise<readonly string[]> {
  const rows = await db.updateTable('attempt').set({ finished_at: now, verdict: 'lost' }).where('finished_at', 'is', null).where('lease_until', '<', now).returning('id').execute();
  return rows.map(row => row.id);
}

async function restartEngine(sim: Sim): Promise<string> {
  sim.engine = 'up';
  const now = new Date(sim.time);
  await sql`update sim_outage set up_at = ${now} where up_at is null`.execute(sim.db);
  if (breaks(sim, 'no-lease-grace')) return 'the engine restarted without a lease grace';
  const freshened = await freshenLeases(sim.db, now);
  return `the engine restarted and gave ${String(freshened)} live attempts a lease of ${String(leaseMs)} ms (${mirrored.freshenLeases})`;
}

async function apply(sim: Sim, bridge: Bridge, frame: CommandFrame): Promise<void> {
  await sql`insert into sim_applied (attempt_id, seq) values (${bridge.attempt}, ${frame.seq})`.execute(sim.db);
  bridge.highestApplied = Math.max(bridge.highestApplied, frame.seq);
  appReads(bridge.app, frame.request);
}

const postOf = (sim: Sim, bridge: Bridge): Post => ({ received: received(sim, bridge), lines: bridge.box.batch().slice(0, sim.mutant?.linesPerPost) });

const received = (sim: Sim, bridge: Bridge): number => (breaks(sim, 'replay-every-command') ? bridge.highestApplied : bridge.commands.applied());

function emit(bridge: Bridge): string | undefined {
  const text = nextLine(bridge.app);
  if (text === undefined) return undefined;
  const seq = bridge.box.push({ kind: 'app', text });
  const message = appMessage.safeParse(parsedJson(text));
  if (!bridge.initialized && message.success && message.data.id === bridgeRequestIds.initialize && message.data.method === undefined) {
    bridge.initialized = true;
    appReads(bridge.app, { method: 'initialized' });
    appReads(bridge.app, threadStart('/workspace'));
  }
  if (!bridge.finishing && turnCompleted.safeParse(parsedJson(text)).success) {
    bridge.finishing = true;
    bridge.stream = undefined;
    const commit = createHash('sha1').update(`${bridge.attempt}-${text}`).digest('hex');
    bridge.box.push({ kind: 'pushed', commit, branch: `autoworker/attempt-${bridge.attempt}` });
    bridge.endLine = bridge.box.push({ kind: 'end' });
    return `line ${String(seq)} ended the turn, so the Job pushed and wrote its end line ${String(bridge.endLine)}`;
  }
  return `line ${String(seq)}`;
}

async function deliver(sim: Sim, bridge: Bridge, delivery: Delivery): Promise<string> {
  const post = bridge.inFlight;
  if (post === undefined) return 'nothing in flight';
  bridge.inFlight = undefined;
  const what = `post of ${range(post)} from attempt ${bridge.attempt}`;
  if (sim.engine === 'down') return `${what} found the engine down and ${failed(sim, bridge, post)}`;
  const base = rulesOf(sim);
  switch (delivery) {
    case 'once': {
      const answer = await call(sim, bridge, post, base);
      return `${what} ${answer === 'failed' ? failed(sim, bridge, post) : await heard(sim, bridge, answer)}`;
    }
    case 'twice': {
      await call(sim, bridge, post, base);
      const answer = await call(sim, bridge, post, base);
      count(sim, 'duplicated posts');
      return `${what} arrived twice and ${answer === 'failed' ? failed(sim, bridge, post) : await heard(sim, bridge, answer)}`;
    }
    case 'unanswered': {
      await call(sim, bridge, post, base);
      count(sim, 'unanswered posts');
      return `${what} was stored but its answer was lost, and it ${failed(sim, bridge, post)}`;
    }
    case 'dropped':
      count(sim, 'dropped posts');
      return `${what} was dropped and ${failed(sim, bridge, post)}`;
    case 'late':
      sim.late.push({ bridge, post });
      count(sim, 'late posts held');
      return `${what} was held back to arrive late, and the bridge's call ${failed(sim, bridge, post)}`;
    case 'crash-before': {
      const crashing: Rules = {
        ...base,
        beforeCommit: async answer => {
          if (breaks(sim, 'ack-inside-commit')) await heard(sim, bridge, answer);
          throw new EngineCrashed('the engine crashed before its commit');
        },
      };
      await call(sim, bridge, post, crashing);
      await crashEngine(sim);
      return `${what}: the engine crashed before its commit, and the call ${failed(sim, bridge, post)}`;
    }
    case 'crash-after': {
      await call(sim, bridge, post, base);
      await crashEngine(sim);
      return `${what}: the engine crashed after its commit, and the call ${failed(sim, bridge, post)}`;
    }
  }
}

async function openStream(sim: Sim, bridge: Bridge): Promise<string> {
  try {
    const denied = await openCommands(sim.db, engineOf(sim, rulesOf(sim)), bridge.caller);
    if (denied !== undefined) {
      stopBridge(bridge, 'down');
      return `the engine refused attempt ${bridge.attempt}'s command stream (${denied.refused}), so the bridge stops`;
    }
  } catch (error) {
    sim.errors.push(`opening attempt ${bridge.attempt}'s stream: ${describe(error)}`);
    return `opening attempt ${bridge.attempt}'s stream failed`;
  }
  const cursor = breaks(sim, 'replay-every-command') ? 0 : bridge.commands.applied();
  bridge.stream = { cursor };
  return `attempt ${bridge.attempt} opened its command stream after ${String(cursor)}`;
}

async function poll(sim: Sim, bridge: Bridge): Promise<string> {
  const stream = bridge.stream;
  if (stream === undefined) return 'no stream';
  const polled = await pollCommands(sim.db, bridge.attempt, stream.cursor);
  const said: string[] = [];
  for (const sent of polled.frames) {
    const frame = commandFrame.parse(JSON.parse(JSON.stringify(sent)));
    stream.cursor = frame.seq;
    if (breaks(sim, 'replay-every-command')) {
      await apply(sim, bridge, frame);
      said.push(`applied ${String(frame.seq)}`);
      continue;
    }
    const accepted = bridge.commands.accept(frame);
    if (accepted === 'gap') {
      bridge.stream = undefined;
      said.push(`refused a gap at ${String(frame.seq)} and reconnects`);
      break;
    }
    if (accepted === 'apply') await apply(sim, bridge, frame);
    said.push(`${accepted === 'apply' ? 'applied' : 'skipped'} ${String(frame.seq)}`);
  }
  if (polled.ended && bridge.stream !== undefined) {
    bridge.stream = undefined;
    said.push('the stream ended with the attempt');
  }
  return `attempt ${bridge.attempt}'s stream: ${said.length === 0 ? 'nothing new' : said.join(', ')}`;
}

async function liveAttempts(sim: Sim): Promise<readonly AttemptId[]> {
  const rows = await sim.db.selectFrom('attempt').select('id').where('finished_at', 'is', null).orderBy('id').execute();
  return rows.map(row => attemptId.parse(row.id));
}

async function stop(sim: Sim, attempt: AttemptId): Promise<string> {
  const now = new Date(sim.time);
  const sent = await sim.db.transaction().execute(async writer => {
    const numbered = await numberCommand(writer, attempt, { kind: 'turn.stop' }, now);
    if (numbered === 'ended') return numbered;
    await writer.updateTable('attempt').set({ finished_at: now, verdict: 'stopped' }).where('id', '=', attempt).where('finished_at', 'is', null).execute();
    return numbered;
  });
  count(sim, 'stops');
  return sent === 'ended' ? `a person stopped attempt ${attempt}, which had already ended` : `a person stopped attempt ${attempt} and the engine sent turn.stop as command ${String(sent.seq)}`;
}

const expendable = attemptId.parse('2');

type Choice = { readonly move: MoveName; readonly bridge: Bridge | undefined };

function choices(sim: Sim): readonly Choice[] {
  const list: Choice[] = [];
  const allowed = (move: MoveName): boolean => sim.faults === 'all' || !faultMoves.has(move);
  for (const bridge of sim.bridges) {
    const up = bridge.state === 'up';
    const offer = (move: MoveName, when: boolean): void => {
      if (when && allowed(move)) list.push({ move, bridge });
    };
    offer('emit', up && (bridge.app.pending.length > 0 || bridge.app.turn !== undefined));
    offer('post', up && bridge.inFlight === undefined);
    offer('deliver', bridge.inFlight !== undefined);
    offer('open', up && !bridge.finishing && bridge.stream === undefined && sim.engine === 'up');
    offer('poll', up && bridge.stream !== undefined && sim.engine === 'up');
    offer('skip', up && sim.engine === 'up' && bridge.box.batch().length >= 2);
    offer('break', bridge.stream !== undefined);
    offer('hang', up);
    offer('wake', bridge.state === 'hung');
    offer('crash', (up || bridge.state === 'hung') && bridge.attempt === expendable);
  }
  const global = (move: MoveName, when: boolean): void => {
    if (when && allowed(move)) list.push({ move, bridge: undefined });
  };
  global('late', sim.late.length > 0 && sim.engine === 'up');
  global('steer', sim.engine === 'up');
  global('stop', sim.engine === 'up');
  global('engine-crash', sim.engine === 'up');
  global('restart', sim.engine === 'down');
  global('reap', sim.engine === 'up');
  global('advance', true);
  return list;
}

function pickWeighted<T>(next: () => number, items: readonly T[], weightOf: (item: T) => number): T | undefined {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let roll = next() * total;
  for (const item of items) {
    roll -= weightOf(item);
    if (roll < 0) return item;
  }
  return items.at(-1);
}

async function applyMove(sim: Sim, choice: Choice): Promise<string> {
  const { bridge } = choice;
  switch (choice.move) {
    case 'emit':
      return bridge === undefined ? 'no bridge' : `attempt ${bridge.attempt}'s app server wrote ${emit(bridge) ?? 'nothing'}`;
    case 'post':
      if (bridge === undefined) return 'no bridge';
      bridge.inFlight = postOf(sim, bridge);
      return `attempt ${bridge.attempt}'s bridge posted ${range(bridge.inFlight)}`;
    case 'deliver': {
      if (bridge === undefined) return 'no bridge';
      const delivery = pickWeighted(sim.next, deliveries, kind => deliveryWeights[sim.faults][kind]) ?? 'once';
      return deliver(sim, bridge, delivery);
    }
    case 'open':
      return bridge === undefined ? 'no bridge' : openStream(sim, bridge);
    case 'poll':
      return bridge === undefined ? 'no bridge' : poll(sim, bridge);
    case 'late': {
      const index = Math.floor(sim.next() * sim.late.length);
      const late = sim.late[index];
      if (late === undefined) return 'no late post';
      sim.late.splice(index, 1);
      const answer = await call(sim, late.bridge, late.post, rulesOf(sim));
      count(sim, 'late posts delivered');
      return `a late post of ${range(late.post)} from attempt ${late.bridge.attempt} arrived and the engine answered ${answer === 'failed' ? 'with an error' : JSON.stringify(answer)}, to nobody`;
    }
    case 'skip': {
      if (bridge === undefined) return 'no bridge';
      const post = { received: received(sim, bridge), lines: bridge.box.batch().slice(1) };
      const answer = await call(sim, bridge, post, rulesOf(sim));
      count(sim, 'posts that skip a number');
      return `a post of ${range(post)} that skips a number arrived from attempt ${bridge.attempt}, and the engine answered ${answer === 'failed' ? 'with an error' : JSON.stringify(answer)}`;
    }
    case 'break':
      if (bridge === undefined) return 'no bridge';
      bridge.stream = undefined;
      count(sim, 'broken streams');
      return `attempt ${bridge.attempt}'s command stream broke`;
    case 'hang':
    case 'crash': {
      if (bridge === undefined) return 'no bridge';
      if (bridge.inFlight !== undefined) sim.late.push({ bridge, post: bridge.inFlight });
      bridge.inFlight = undefined;
      bridge.stream = undefined;
      bridge.state = choice.move === 'hang' ? 'hung' : 'down';
      count(sim, choice.move === 'hang' ? 'bridge hangs' : 'bridge crashes');
      return `attempt ${bridge.attempt}'s bridge ${choice.move === 'hang' ? 'hung' : 'crashed for good'}`;
    }
    case 'wake':
      if (bridge === undefined) return 'no bridge';
      bridge.state = 'up';
      return `attempt ${bridge.attempt}'s bridge woke and resends from line ${String(bridge.box.batch()[0]?.seq ?? bridge.box.emitted() + 1)}`;
    case 'steer': {
      const attempt = (await liveAttempts(sim))[Math.floor(sim.next() * 2)];
      if (attempt === undefined) return 'nobody to steer';
      const sent = await sendCommand(sim.db, attempt, { kind: 'turn.steer', message: 'Also check the edge case.' }, new Date(sim.time));
      count(sim, 'steers');
      return sent === 'ended' ? `a person steered attempt ${attempt}, which had ended` : `a person steered attempt ${attempt} as command ${String(sent.seq)}`;
    }
    case 'stop': {
      return stop(sim, expendable);
    }
    case 'engine-crash':
      await crashEngine(sim);
      return 'the engine crashed';
    case 'restart':
      return restartEngine(sim);
    case 'reap': {
      const reaped = await reapAttempts(sim.db, new Date(sim.time));
      if (reaped.length > 0) count(sim, 'reaps');
      return `the reaper (${mirrored.reap}) marked ${reaped.length === 0 ? 'nothing' : `attempts ${reaped.join(', ')}`} lost`;
    }
    case 'advance': {
      const long = sim.engine === 'down' && sim.next() < 0.4;
      const ms = long ? leaseMs + Math.floor(sim.next() * 2 * leaseMs) : 1000 + Math.floor(sim.next() * 9000);
      sim.time += ms;
      const beats: string[] = [];
      for (const bridge of sim.bridges) {
        if (bridge.state !== 'up' || bridge.inFlight !== undefined || sim.engine === 'down') continue;
        bridge.inFlight = postOf(sim, bridge);
        beats.push(await deliver(sim, bridge, 'once'));
      }
      return `advanced ${String(ms)} ms${beats.length === 0 ? '' : `, and the bridges that were due posted: ${beats.join('; ')}`}`;
    }
  }
}

async function syncBridges(sim: Sim): Promise<void> {
  const rows = sim.bridges.map(bridge => sql`(${bridge.attempt}::bigint, ${bridge.state}, ${bridge.box.emitted()}::bigint)`);
  await sql`update sim_bridge set state = v.state, emitted = v.emitted from (values ${sql.join(rows)}) as v(attempt_id, state, emitted) where sim_bridge.attempt_id = v.attempt_id`.execute(sim.db);
}

const signature = (sim: Sim): string =>
  JSON.stringify([sim.engine, ...sim.bridges.map(bridge => [bridge.state, bridge.box.emitted(), bridge.box.pending(), bridge.commands.applied(), bridge.highestApplied, bridge.stream?.cursor ?? -1])]);

const isUp = (bridge: Bridge): boolean => bridge.state === 'up';

async function quietPhase(sim: Sim): Promise<void> {
  sim.late.length = 0;
  if (breaks(sim, 'engine-stays-down')) {
    if (sim.engine === 'up') await crashEngine(sim);
  } else if (sim.engine === 'down') await restartEngine(sim);
  for (const bridge of sim.bridges) if (bridge.state === 'hung') bridge.state = 'up';
  let still = 0;
  for (let round = 0; round < 5000 && still < 3; round += 1) {
    const before = signature(sim);
    for (const bridge of sim.bridges) {
      if (!isUp(bridge)) continue;
      emit(bridge);
      if (!bridge.finishing && bridge.stream === undefined && sim.engine === 'up') await openStream(sim, bridge);
      if (isUp(bridge) && bridge.stream !== undefined && sim.engine === 'up') await poll(sim, bridge);
      if (isUp(bridge) && (bridge.box.pending() > 0 || round % 5 === 0)) {
        bridge.inFlight = postOf(sim, bridge);
        await deliver(sim, bridge, 'once');
      }
    }
    sim.time += 1000;
    still = signature(sim) === before ? still + 1 : 0;
  }
  await syncBridges(sim);
}

async function endsStored(db: Database): Promise<number> {
  const { rows } = await sql<{ ended: number }>`
    select count(*)::int as ended from attempt a
    where a.verdict = 'pass' and exists (select 1 from attempt_event e where e.attempt_id = a.id and e.kind = 'end')`.execute(db);
  return rows[0]?.ended ?? 0;
}

async function dropGuard(db: Database, drop: Drop): Promise<void> {
  if (drop.kind === 'trigger') await sql`drop trigger ${sql.id(drop.name)} on ${sql.id(drop.table)}`.execute(db);
  else await sql`alter table ${sql.id(drop.table)} drop constraint ${sql.id(drop.name)}`.execute(db);
}

async function makeBridge(sim: Pick<Sim, 'db' | 'next'>, index: number): Promise<Bridge> {
  const attempt = attemptId.parse(String(index));
  const token = await issueToken(sim.db, attempt);
  if (token === undefined) throw new Error(`attempt ${attempt} took no bridge token`);
  const app: App = { thread: `thread-${attempt}`, label: `a${attempt}`, next: sim.next, pending: [], turn: undefined, script: [], turns: 0, items: 0 };
  app.pending.push(say({ id: bridgeRequestIds.initialize, result: { userAgent: 'simulated app server' } }));
  return {
    attempt,
    caller: { attempt, token, protocol: protocolVersion, pid: 4000 + index, image: 'autoworker-job:sim' },
    box: outbox(),
    commands: applier(),
    app,
    state: 'up',
    stream: undefined,
    inFlight: undefined,
    initialized: false,
    finishing: false,
    endLine: undefined,
    highestApplied: 0,
  };
}

async function simulateSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 4);
  const next = random(seed);
  const mutant = plan.mutant === undefined ? undefined : mutants[plan.mutant];
  let failure: Failure | undefined;
  try {
    for (const statement of [...simulatorSchema, ...world]) await statement.execute(db);
    for (const drop of mutant?.drops ?? []) await dropGuard(db, drop);
    const bridges = [await makeBridge({ db, next }, 1), await makeBridge({ db, next }, 2)];
    const sim: Sim = { db, next, mutant, faults: mutant?.faults ?? 'all', bridges, late: [], log: [], errors: [], counts: {}, time: worldStartsAt, engine: 'up' };
    for (const bridge of bridges) {
      const sent = await sendCommand(db, bridge.attempt, { kind: 'turn.start', prompt: 'Do the work.', outputSchema: null }, new Date(sim.time));
      if (sent === 'ended') throw new Error(`attempt ${bridge.attempt} ended before its turn started`);
      await sql`insert into sim_bridge (attempt_id, state, emitted) values (${bridge.attempt}, 'up', 0)`.execute(db);
    }
    for (let step = 1; step <= plan.steps && failure === undefined; step += 1) {
      const choice = pickWeighted(next, choices(sim), option => mutant?.weights?.[option.move] ?? weights[option.move]);
      if (choice === undefined) break;
      sim.time += tickMs;
      const said = await applyMove(sim, choice);
      sim.log.push(`${new Date(sim.time).toISOString()} step ${String(step)} ${choice.move}: ${said}`);
      await syncBridges(sim);
      const broken = await violations(db, 'each-step');
      if (broken.length > 0) failure = { step, move: choice.move, said, broken };
    }
    if (failure === undefined) {
      await quietPhase(sim);
      sim.log.push(`${new Date(sim.time).toISOString()} quiet phase: ${signature(sim)}`);
      const broken = await violations(db, 'every');
      if (broken.length > 0) failure = { step: plan.steps + 1, move: 'quiet phase', said: 'the engine served and every bridge that was up drained', broken };
    }
    const verdicts = await db.selectFrom('attempt').select(['verdict']).execute();
    for (const { verdict } of verdicts) count(sim, `attempts ${verdict ?? 'live'}`);
    return { seed, plan, failure, ended: await endsStored(db), counts: sim.counts, errors: sim.errors, log: sim.log };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export async function simulate(postgres: TestPostgres, plans: readonly Plan[], onRun: (run: Run) => void = () => undefined, parallel = 16): Promise<readonly Run[]> {
  const jobs = plans.flatMap(plan => plan.seeds.map(seed => ({ plan, seed })));
  const runs: Run[] = [];
  let taken = 0;
  const worker = async (): Promise<void> => {
    while (taken < jobs.length) {
      const job = jobs[taken];
      taken += 1;
      if (job === undefined) continue;
      const run = await simulateSeed(postgres, job.plan, job.seed);
      onRun(run);
      runs.push(run);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return runs.sort((a, b) => a.seed - b.seed);
}

