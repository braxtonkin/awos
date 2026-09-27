import { z } from 'zod';
import { reproduction } from '../../shared/reproduction.ts';

export const protocolVersion = 2;

export const batchLimit = 256;

export const pinned = {
  model: 'gpt-6-luna',
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  effort: 'medium',
} as const;

export const bridgeRequestIds = { initialize: 'bridge-initialize', threadStart: 'bridge-thread-start' } as const;

export const commandRequestId = (seq: number): string => `command-${String(seq)}`;

export const headers = {
  attempt: 'x-autoworker-attempt',
  protocol: 'x-autoworker-protocol',
  process: 'x-autoworker-process',
  image: 'x-autoworker-image',
} as const;

const count = z.int().nonnegative();

const number = z.int().positive();

export const attemptId = z.string().regex(/^[1-9]\d{0,18}$/).brand<'AttemptId'>();

export type AttemptId = z.infer<typeof attemptId>;

export const caller = z.object({
  attempt: attemptId,
  token: z.string().min(32).max(200),
  protocol: z.coerce.number().pipe(z.int()),
  process: z.uuid(),
  image: z.string().min(1).max(500),
});

export type Caller = z.infer<typeof caller>;

export const bearer = z.string().regex(/^Bearer \S+$/).transform(value => value.slice('Bearer '.length));

const commit = z.string().regex(/^[0-9a-f]{40}$/);

const appLine = z.object({ kind: z.literal('app'), text: z.string().max(4_000_000) });

const pushedLine = z.object({ kind: z.literal('pushed'), commit, branch: z.string().min(1).max(255) });

const reproducedLine = z.object({ kind: z.literal('reproduced'), reproduction });

const endLine = z.object({ kind: z.literal('end'), declined: z.string().min(1).max(4_000).optional() });

export type LineBody = z.infer<typeof appLine> | z.infer<typeof pushedLine> | z.infer<typeof reproducedLine> | z.infer<typeof endLine>;

export const line = z.discriminatedUnion('kind', [appLine.extend({ seq: number }), pushedLine.extend({ seq: number }), reproducedLine.extend({ seq: number }), endLine.extend({ seq: number })]);

export type Line = z.infer<typeof line>;

export const eventsPost = z.object({ received: count, lines: z.array(line).max(batchLimit) });

export type EventsPost = z.infer<typeof eventsPost>;

export const eventsAnswer = z.object({ stored: count });

export type EventsAnswer = z.infer<typeof eventsAnswer>;

export const refusalKind = z.enum(['token', 'protocol', 'process', 'ended', 'malformed']);

export type RefusalKind = z.infer<typeof refusalKind>;

export const refusalAnswer = z.object({ refused: refusalKind, reason: z.string() });

export type Refused = z.infer<typeof refusalAnswer>;

export const refusalStatus: Readonly<Record<RefusalKind, number>> = { token: 401, protocol: 426, process: 409, ended: 410, malformed: 400 };

const userInput = z.array(z.object({ type: z.literal('text'), text: z.string(), text_elements: z.array(z.never()) }));

const requestId = z.string().regex(/^command-\d+$/);

export const commandRequest = z.discriminatedUnion('method', [
  z.object({
    id: requestId,
    method: z.literal('turn/start'),
    params: z.object({ threadId: z.string(), clientUserMessageId: z.uuid(), input: userInput, outputSchema: z.json().nullable() }),
  }),
  z.object({
    id: requestId,
    method: z.literal('turn/steer'),
    params: z.object({ threadId: z.string(), expectedTurnId: z.string(), clientUserMessageId: z.uuid(), input: userInput }),
  }),
  z.object({ id: requestId, method: z.literal('turn/interrupt'), params: z.object({ threadId: z.string(), turnId: z.string() }) }),
]);

export type CommandRequest = z.infer<typeof commandRequest>;

export const commandFrame = z.object({ seq: number, request: commandRequest });

export type CommandFrame = z.infer<typeof commandFrame>;

export const textInput = (text: string): z.infer<typeof userInput> => [{ type: 'text', text, text_elements: [] }];

export const appMessage = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type AppMessage = z.infer<typeof appMessage>;

export const turnCompleted = z.object({
  method: z.literal('turn/completed'),
  params: z.object({ threadId: z.string(), turn: z.looseObject({ id: z.string(), status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']) }) }),
});

export type TurnCompleted = z.infer<typeof turnCompleted>['params'];
