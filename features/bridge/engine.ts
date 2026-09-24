import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { inTransaction, type Transacting } from '../../shared/transaction.ts';
import type { AttemptCommandKind, DB } from '../../shared/db/types.ts';
import { finalMessage, isFragmentMethod, reduce } from '../../shared/items.ts';
import {
  appMessage,
  bearer,
  bridgeRequestIds,
  caller,
  commandRequestId,
  eventsPost,
  headers,
  protocolVersion,
  refusalStatus,
  textInput,
  type AttemptId,
  type Caller,
  type CommandFrame,
  type EventsAnswer,
  type EventsPost,
  type Line,
  type RefusalKind,
  type Refused,
} from './protocol.ts';

export type Writer = Transaction<DB>;

export type Finish = (writer: Transacting, attempt: AttemptId, now: Date) => Promise<void>;

export type Decision = 'store' | 'skip' | 'stop';

export type Rules = {
  readonly decide: (highest: number, seq: number) => Decision;
  readonly highWater: (writer: Writer, attempt: AttemptId, column: number) => Promise<number>;
  readonly fenced: (finishedAt: Date | null) => boolean;
  readonly finishesOn: (line: Line) => boolean;
  readonly beforeCommit: (answer: EventsAnswer) => Promise<void>;
};

export const rules: Rules = {
  decide: (highest, seq) => (seq <= highest ? 'skip' : seq === highest + 1 ? 'store' : 'stop'),
  highWater: (_writer, _attempt, column) => Promise.resolve(column),
  fenced: finishedAt => finishedAt !== null,
  finishesOn: line => line.kind === 'end',
  beforeCommit: () => Promise.resolve(),
};

export type BridgeEngine = { readonly leaseMs: number; readonly finish: Finish; readonly now: () => Date; readonly rules: Rules };

export type Command = { readonly kind: 'turn.start'; readonly prompt: string; readonly outputSchema: unknown } | { readonly kind: 'turn.steer'; readonly message: string } | { readonly kind: 'turn.stop' };

export type Sent = { readonly seq: number; readonly clientMessageId: string | null };

export type Delivery = 'sent' | 'received' | 'acted on';

export type Polled = { readonly frames: readonly CommandFrame[]; readonly ended: boolean };

const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

const refused = (kind: RefusalKind, reason: string): Refused => ({ refused: kind, reason });

export async function issueToken(db: Database, attempt: AttemptId): Promise<string | undefined> {
  const token = randomBytes(32).toString('base64url');
  const { numUpdatedRows } = await db
    .updateTable('attempt')
    .set({ bridge_token_hash: hashOf(token) })
    .where('id', '=', attempt)
    .where('finished_at', 'is', null)
    .where('bridge_token_hash', 'is', null)
    .executeTakeFirst();
  return numUpdatedRows === 1n ? token : undefined;
}

type Held = { readonly finished_at: Date | null; readonly bridge_token_hash: Buffer | null; readonly bridge_pid: number | null; readonly high_water: string };

async function hold(writer: Writer, attempt: AttemptId): Promise<Held | undefined> {
  return writer.selectFrom('attempt').select(['finished_at', 'bridge_token_hash', 'bridge_pid', 'high_water']).where('id', '=', attempt).forUpdate().executeTakeFirst();
}

function gate(engine: BridgeEngine, held: Held | undefined, from: Caller): Refused | undefined {
  const expected = held?.bridge_token_hash ?? null;
  const given = hashOf(from.token);
  if (held === undefined || expected === null || expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return refused('token', `The token does not open attempt ${from.attempt}.`);
  }
  if (from.protocol !== protocolVersion) {
    return refused('protocol', `The bridge in image ${from.image} speaks protocol ${String(from.protocol)}, and this engine speaks ${String(protocolVersion)}. Run the attempt from an image whose bridge speaks protocol ${String(protocolVersion)}.`);
  }
  if (engine.rules.fenced(held.finished_at)) return refused('ended', `Attempt ${from.attempt} has ended, so the engine takes nothing more from its bridge.`);
  if (held.bridge_pid !== null && held.bridge_pid !== from.pid) {
    return refused('process', `Attempt ${from.attempt} is bound to bridge process ${String(held.bridge_pid)}, not ${String(from.pid)}.`);
  }
  return undefined;
}

async function admit(writer: Writer, engine: BridgeEngine, from: Caller, now: Date, received: number): Promise<void> {
  await writer
    .updateTable('attempt')
    .set({
      bridge_pid: from.pid,
      lease_until: sql<Date>`greatest(lease_until, ${new Date(now.getTime() + engine.leaseMs)})`,
      commands_received: sql<string>`greatest(commands_received, ${received})`,
    })
    .where('id', '=', from.attempt)
    .execute();
  if (received > 0) {
    await writer
      .updateTable('attempt_command')
      .set({ received_at: now })
      .where('attempt_id', '=', from.attempt)
      .where('seq', '<=', String(received))
      .where('received_at', 'is', null)
      .execute();
  }
}

const itemOf = z.object({ params: z.object({ item: z.looseObject({ id: z.string(), type: z.string(), clientId: z.string().nullable().optional() }) }) });

const fragmentOf = z.object({ params: z.object({ itemId: z.string() }) });

type Parsed = { readonly method: string | null; readonly itemId: string | null; readonly fragment: boolean; readonly body: unknown; readonly clientId: string | null; readonly responseTo: string | null };

function parseLine(line: Line): Parsed {
  switch (line.kind) {
    case 'pushed':
      return { method: null, itemId: null, fragment: false, body: { commit: line.commit, branch: line.branch }, clientId: null, responseTo: null };
    case 'end':
      return { method: null, itemId: null, fragment: false, body: {}, clientId: null, responseTo: null };
    case 'app': {
      let json: unknown;
      try {
        json = JSON.parse(line.text);
      } catch {
        return { method: null, itemId: null, fragment: false, body: line.text, clientId: null, responseTo: null };
      }
      const message = appMessage.safeParse(json);
      const method = message.success ? (message.data.method ?? null) : null;
      const responseTo = message.success && method === null && typeof message.data.id === 'string' ? message.data.id : null;
      if (isFragmentMethod(method ?? undefined)) {
        const fragment = fragmentOf.safeParse(json);
        return { method, itemId: fragment.success ? fragment.data.params.itemId : null, fragment: fragment.success, body: json, clientId: null, responseTo };
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = itemOf.safeParse(json);
        const clientId = item.success && item.data.params.item.type === 'userMessage' ? (item.data.params.item.clientId ?? null) : null;
        return { method, itemId: item.success ? item.data.params.item.id : null, fragment: false, body: json, clientId, responseTo };
      }
      return { method, itemId: null, fragment: false, body: json, clientId: null, responseTo };
    }
  }
}

async function storeLine(writer: Writer, attempt: AttemptId, line: Line, now: Date): Promise<void> {
  const parsed = parseLine(line);
  await writer
    .insertInto('attempt_event')
    .values({
      attempt_id: attempt,
      seq: String(line.seq),
      kind: line.kind,
      method: parsed.method,
      item_id: parsed.itemId,
      fragment: parsed.fragment,
      body: JSON.stringify(parsed.body),
      stored_at: now,
    })
    .execute();
  if (line.kind === 'pushed') {
    await writer.updateTable('attempt').set({ last_pushed: line.commit }).where('id', '=', attempt).where('branch', '=', line.branch).execute();
  }
  if (parsed.method === 'item/completed' && parsed.itemId !== null) {
    await writer.deleteFrom('attempt_event').where('attempt_id', '=', attempt).where('item_id', '=', parsed.itemId).where('fragment', '=', true).execute();
  }
  if (parsed.clientId !== null && z.uuid().safeParse(parsed.clientId).success) {
    await writer
      .updateTable('attempt_command')
      .set({ received_at: sql<Date>`coalesce(received_at, ${now})`, acted_at: now })
      .where('attempt_id', '=', attempt)
      .where('client_message_id', '=', parsed.clientId)
      .where('acted_at', 'is', null)
      .execute();
  }
  const stopSeq = parsed.responseTo === null ? undefined : /^command-(\d+)$/.exec(parsed.responseTo)?.[1];
  if (stopSeq !== undefined) {
    await writer
      .updateTable('attempt_command')
      .set({ received_at: sql<Date>`coalesce(received_at, ${now})`, acted_at: now })
      .where('attempt_id', '=', attempt)
      .where('seq', '=', stopSeq)
      .where('kind', '=', 'turn.stop')
      .where('acted_at', 'is', null)
      .execute();
  }
}

const alreadyStored = (held: Held | undefined, denied: Refused | undefined, posted: EventsPost): boolean =>
  held !== undefined && denied?.refused === 'ended' && posted.lines.length > 0 && posted.lines.every(line => line.seq <= Number(held.high_water));

export async function receive(db: Database, engine: BridgeEngine, from: Caller, posted: EventsPost): Promise<EventsAnswer | Refused> {
  return inTransaction(db, async writer => {
    const held = await hold(writer, from.attempt);
    const denied = gate(engine, held, from);
    if (alreadyStored(held, denied, posted)) return { stored: Number(held?.high_water ?? 0) };
    if (denied !== undefined || held === undefined) return denied ?? refused('token', `No attempt ${from.attempt}.`);
    const now = engine.now();
    await admit(writer, engine, from, now, posted.received);
    let highest = await engine.rules.highWater(writer, from.attempt, Number(held.high_water));
    const settle = (): Promise<unknown> =>
      writer.updateTable('attempt').set({ high_water: sql<string>`greatest(high_water, ${highest})` }).where('id', '=', from.attempt).execute();
    let finished = false;
    for (const line of posted.lines) {
      const decision = engine.rules.decide(highest, line.seq);
      if (decision === 'skip') continue;
      if (decision === 'stop') break;
      await storeLine(writer, from.attempt, line, now);
      highest = Math.max(highest, line.seq);
      if (engine.rules.finishesOn(line)) {
        await settle();
        await engine.finish(writer, from.attempt, now);
        finished = true;
        break;
      }
    }
    if (!finished) await settle();
    const answer = { stored: highest };
    await engine.rules.beforeCommit(answer);
    return answer;
  });
}

export async function openCommands(db: Database, engine: BridgeEngine, from: Caller): Promise<Refused | undefined> {
  return db.transaction().execute(async writer => {
    const held = await hold(writer, from.attempt);
    const denied = gate(engine, held, from);
    if (denied !== undefined) return denied;
    await admit(writer, engine, from, engine.now(), 0);
    return undefined;
  });
}

const resultIds = z.object({ thread: z.object({ id: z.string() }).optional(), turn: z.object({ id: z.string() }).optional() });

async function answeredIds(db: Database, attempt: AttemptId, ids: readonly string[]): Promise<ReadonlyMap<string, z.infer<typeof resultIds>>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('attempt_event')
    .select([sql<string>`body->>'id'`.as('id'), sql`body->'result'`.as('result')])
    .where('attempt_id', '=', attempt)
    .where('kind', '=', 'app')
    .where('method', 'is', null)
    .where(sql<string>`body->>'id'`, 'in', ids)
    .execute();
  return new Map(rows.flatMap(row => {
    const parsed = resultIds.safeParse(row.result);
    return parsed.success ? [[row.id, parsed.data] as const] : [];
  }));
}

type Stored = { readonly seq: string; readonly kind: AttemptCommandKind; readonly input: string | null; readonly output_schema: unknown; readonly client_message_id: string | null };

function frameOf(command: Stored, thread: string, turn: string | undefined): CommandFrame | undefined {
  const seq = Number(command.seq);
  const id = commandRequestId(seq);
  switch (command.kind) {
    case 'turn.start':
      return command.input === null || command.client_message_id === null
        ? undefined
        : { seq, request: { id, method: 'turn/start', params: { threadId: thread, clientUserMessageId: command.client_message_id, input: textInput(command.input), outputSchema: z.json().nullable().parse(command.output_schema ?? null) } } };
    case 'turn.steer':
      return command.input === null || command.client_message_id === null || turn === undefined
        ? undefined
        : { seq, request: { id, method: 'turn/steer', params: { threadId: thread, expectedTurnId: turn, clientUserMessageId: command.client_message_id, input: textInput(command.input) } } };
    case 'turn.stop':
      return turn === undefined ? undefined : { seq, request: { id, method: 'turn/interrupt', params: { threadId: thread, turnId: turn } } };
  }
}

export async function pollCommands(db: Database, attempt: AttemptId, after: number): Promise<Polled> {
  const row = await db.selectFrom('attempt').select('finished_at').where('id', '=', attempt).executeTakeFirst();
  const commands = await db
    .selectFrom('attempt_command')
    .select(['seq', 'kind', 'input', 'output_schema', 'client_message_id'])
    .where('attempt_id', '=', attempt)
    .where('seq', '>', String(after))
    .orderBy('seq')
    .execute();
  const ended = row === undefined || row.finished_at !== null;
  if (commands.length === 0) return { frames: [], ended };
  const starts = await db.selectFrom('attempt_command').select('seq').where('attempt_id', '=', attempt).where('kind', '=', 'turn.start').orderBy('seq').execute();
  const answered = await answeredIds(db, attempt, [bridgeRequestIds.threadStart, ...starts.map(start => commandRequestId(Number(start.seq)))]);
  const thread = answered.get(bridgeRequestIds.threadStart)?.thread?.id;
  const frames: CommandFrame[] = [];
  if (thread === undefined) return { frames, ended };
  for (const command of commands) {
    const start = starts.findLast(candidate => Number(candidate.seq) < Number(command.seq));
    const turn = start === undefined ? undefined : answered.get(commandRequestId(Number(start.seq)))?.turn?.id;
    const frame = frameOf(command, thread, turn);
    if (frame === undefined) break;
    frames.push(frame);
  }
  return { frames, ended };
}

export async function numberCommand(writer: Writer, attempt: AttemptId, command: Command, now: Date): Promise<Sent | 'ended'> {
  const held = await writer.selectFrom('attempt').select('finished_at').where('id', '=', attempt).forUpdate().executeTakeFirst();
  if (held === undefined || held.finished_at !== null) return 'ended';
  const last = await writer.selectFrom('attempt_command').select(sql<string>`coalesce(max(seq), 0)`.as('seq')).where('attempt_id', '=', attempt).executeTakeFirstOrThrow();
  const seq = Number(last.seq) + 1;
  const clientMessageId = command.kind === 'turn.stop' ? null : crypto.randomUUID();
  await writer
    .insertInto('attempt_command')
    .values({
      attempt_id: attempt,
      seq: String(seq),
      kind: command.kind,
      input: command.kind === 'turn.start' ? command.prompt : command.kind === 'turn.steer' ? command.message : null,
      output_schema: command.kind === 'turn.start' && command.outputSchema !== undefined && command.outputSchema !== null ? JSON.stringify(command.outputSchema) : null,
      client_message_id: clientMessageId,
      sent_at: now,
    })
    .execute();
  return { seq, clientMessageId };
}

export function sendCommand(db: Database, attempt: AttemptId, command: Command, now: Date): Promise<Sent | 'ended'> {
  return db.transaction().execute(writer => numberCommand(writer, attempt, command, now));
}

export async function deliveries(db: Database, attempt: AttemptId): Promise<readonly { readonly seq: number; readonly kind: AttemptCommandKind; readonly delivery: Delivery }[]> {
  const rows = await db.selectFrom('attempt_command').select(['seq', 'kind', 'received_at', 'acted_at']).where('attempt_id', '=', attempt).orderBy('seq').execute();
  return rows.map(row => ({ seq: Number(row.seq), kind: row.kind, delivery: row.acted_at !== null ? 'acted on' : row.received_at !== null ? 'received' : 'sent' }));
}

export async function storedLines(db: Database, attempt: AttemptId): Promise<readonly { readonly seq: number; readonly method: string | null; readonly body: unknown }[]> {
  const rows = await db.selectFrom('attempt_event').select(['seq', 'method', 'body']).where('attempt_id', '=', attempt).where('kind', '=', 'app').orderBy('seq').execute();
  return rows.map(row => ({ seq: Number(row.seq), method: row.method, body: row.body }));
}

export async function finalMessageOf(db: Database, attempt: AttemptId): Promise<string | undefined> {
  return finalMessage(reduce(await storedLines(db, attempt)));
}

export type ServerSettings = { readonly pollMs: number; readonly keepAliveMs: number; readonly bodyLimitBytes: number; readonly stop: AbortSignal };

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const sendRefusal = (response: ServerResponse, answer: Refused): void => {
  send(response, refusalStatus[answer.refused], answer);
};

function callerOf(request: IncomingMessage): Caller | Refused {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const token = bearer.safeParse(header('authorization'));
  if (!token.success) return refused('token', 'The call carries no bearer token.');
  const parsed = caller.safeParse({ attempt: header(headers.attempt), token: token.data, protocol: header(headers.protocol), pid: header(headers.pid), image: header(headers.image) });
  return parsed.success ? parsed.data : refused('malformed', `The call's headers are wrong. ${z.prettifyError(parsed.error)}`);
}

async function bodyOf(request: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postEvents(db: Database, engine: BridgeEngine, settings: ServerSettings, request: IncomingMessage, response: ServerResponse, from: Caller): Promise<void> {
  const text = await bodyOf(request, settings.bodyLimitBytes);
  if (text === undefined) {
    sendRefusal(response, refused('malformed', `The batch is larger than ${String(settings.bodyLimitBytes)} bytes.`));
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    sendRefusal(response, refused('malformed', 'The batch is not JSON.'));
    return;
  }
  const posted = eventsPost.safeParse(json);
  if (!posted.success) {
    sendRefusal(response, refused('malformed', `The batch is wrong. ${z.prettifyError(posted.error)}`));
    return;
  }
  const answer = await receive(db, engine, from, posted.data);
  if ('refused' in answer) sendRefusal(response, answer);
  else send(response, 200, answer);
}

async function streamCommands(db: Database, engine: BridgeEngine, settings: ServerSettings, request: IncomingMessage, response: ServerResponse, from: Caller, after: number): Promise<void> {
  const denied = await openCommands(db, engine, from);
  if (denied !== undefined) {
    sendRefusal(response, denied);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const closed = new AbortController();
  request.on('close', () => {
    closed.abort();
  });
  const done = AbortSignal.any([closed.signal, settings.stop]);
  let cursor = after;
  let quietSince = Date.now();
  while (!done.aborted) {
    const polled = await pollCommands(db, from.attempt, cursor);
    for (const frame of polled.frames) {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
      cursor = frame.seq;
      quietSince = Date.now();
    }
    if (polled.ended) break;
    if (Date.now() - quietSince >= settings.keepAliveMs) {
      response.write(': keep-alive\n\n');
      quietSince = Date.now();
    }
    await wait(settings.pollMs, undefined, { signal: done }).catch(() => undefined);
  }
  response.end();
}

export function bridgeListener(db: Database, engine: BridgeEngine, settings: ServerSettings): RequestListener {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://engine');
    const route = `${request.method ?? ''} ${url.pathname}`;
    if (route !== 'POST /events' && route !== 'GET /commands') {
      send(response, 404, { refused: 'malformed', reason: `No route ${route}.` });
      return;
    }
    const from = callerOf(request);
    if ('refused' in from) {
      sendRefusal(response, from);
      return;
    }
    if (route === 'POST /events') {
      await postEvents(db, engine, settings, request, response, from);
      return;
    }
    const after = z.coerce.number().pipe(z.int().nonnegative()).safeParse(url.searchParams.get('after') ?? '0');
    if (!after.success) {
      sendRefusal(response, refused('malformed', 'after must be a whole number.'));
      return;
    }
    await streamCommands(db, engine, settings, request, response, from, after.data);
  };
  return (request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) response.end();
      else send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  };
}
