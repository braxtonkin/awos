import { z } from 'zod';
import type { ConnectorKind, CredentialState, TaskState, WaitingOn } from '../../shared/db/types.ts';
import { marks } from '../../shared/task-status.ts';

const moment = z.iso.datetime({ offset: true });

export const taskStates = ['ready', 'waiting', 'stopped', 'done'] as const satisfies readonly TaskState[];

export const waitingOns = ['answer', 'approval', 'outside_approval', 'retry'] as const satisfies readonly WaitingOn[];

export const connectors = ['codex', 'github', 'jira'] as const satisfies readonly ConnectorKind[];

const task = z.strictObject({
  key: z.string(),
  title: z.string(),
  routine: z.string(),
  workflow: z.string(),
  step: z.string(),
  state: z.enum(taskStates),
  waitingOn: z.enum(waitingOns).nullable(),
  waitingReason: z.string().nullable(),
  marks: z.array(z.enum(marks)).readonly(),
  person: z.string(),
  since: moment.nullable(),
});

export type TaskRow = z.infer<typeof task>;

const login = z.strictObject({
  connector: z.enum(connectors),
  state: z.enum(['invalid', 'unknown', 'valid'] as const satisfies readonly CredentialState[]).nullable(),
  expiresAt: moment.nullable(),
});

export type Login = z.infer<typeof login>;

const world = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('no-routines') }),
  z.strictObject({ kind: z.literal('no-tasks'), next: z.strictObject({ routine: z.string(), at: moment }).nullable() }),
  z.strictObject({ kind: z.literal('tasks') }),
]);

export type World = z.infer<typeof world>;

const needsYou = z.strictObject({
  at: moment,
  picked: z.boolean(),
  waiting: z.array(task).readonly(),
  gates: z.array(task).readonly(),
  logins: z.array(login).readonly(),
  running: z.array(task).readonly(),
  moreRunning: z.int().nonnegative(),
  world,
});

export type NeedsYou = z.infer<typeof needsYou>;

export const frame = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('needs-you'), needs: needsYou })]);

export type Frame = z.infer<typeof frame>;
