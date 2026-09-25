import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { z } from 'zod';
import type { DB } from './db/types.ts';
import type { Transacting } from './transaction.ts';

const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const branch = z.string().min(1).max(255);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
export const ticket = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/, { error: 'must be a ticket key such as ABC-12' });

export const marker = z.string().regex(/^[A-Za-z0-9_-]{22,}$/).brand<'Marker'>();

export type Marker = z.infer<typeof marker>;

export type ActionSpec<K extends string, P, R> = { readonly kind: K; readonly payload: z.ZodType<P>; readonly result: z.ZodType<R> };

const spec = <K extends string, P, R>(kind: K, payload: z.ZodType<P>, result: z.ZodType<R>): ActionSpec<K, P, R> => ({ kind, payload, result });

export const mergeResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('merged'), head: commit }),
  z.object({ outcome: z.literal('queued'), head: commit }),
  z.object({ outcome: z.literal('ejected'), head: commit, ejection: z.string().min(1), reason: z.string() }),
]);

export const actionKinds = {
  ticketComment: spec('ticket.comment', z.object({ ticket, text: z.string().min(1), linkPullRequest: z.boolean() }), z.object({ comment: z.string().min(1) })),
  ticketTransition: spec('ticket.transition', z.object({ ticket, status: z.string().min(1), from: z.string().min(1).nullable() }), z.object({ status: z.string().min(1) })),
  prOpenDraft: spec(
    'pr.open-draft',
    z.object({ repository, head: branch, base: branch, title: z.string().min(1), body: z.string() }),
    z.object({ number: z.int().positive(), url: z.url() }),
  ),
  prMarkReady: spec('pr.mark-ready', z.object({ repository, head: branch, evidence: z.string().min(1) }), z.object({ number: z.int().positive() })),
  prEvidence: spec('pr.evidence', z.object({ repository, head: branch, evidence: z.string().min(1) }), z.object({ number: z.int().positive() })),
  prUpdateBranch: spec('pr.update-branch', z.object({ repository, head: branch, commit }), z.object({ head: commit })),
  prMerge: spec('pr.merge', z.object({ repository, number: z.int().positive(), commit }), mergeResult),
  branchAdvance: spec('branch.advance', z.object({ repository, branch, from: commit.nullable(), to: commit }), z.object({ head: commit })),
  branchDelete: spec('branch.delete', z.object({ repository, branch }), z.object({ deleted: z.boolean() })),
} as const;

export type Owe<K extends string = string> = { readonly kind: K; readonly payload: unknown };

export const owe = <K extends string, P, R>(kind: ActionSpec<K, P, R>, payload: P): Owe<K> => ({ kind: kind.kind, payload: kind.payload.parse(payload) });

export type Owing = { readonly task: string; readonly actsAs: string; readonly now: Date };

export type Enqueue = (tx: Transacting, owing: Owing, actions: readonly Owe[]) => Promise<readonly string[]>;

export type Owed<P> = { readonly row: string; readonly task: string; readonly kind: string; readonly payload: P; readonly marker: Marker; readonly actsAs: string };

export type Limits = { readonly deadline: Date; readonly signal: AbortSignal };

export type Refusal = { readonly reason: string; readonly head: string | null };

export type Outcome<R> = { readonly done: R } | { readonly refused: Refusal } | { readonly failed: string };

export type Lookup<R> = { readonly found: R } | { readonly absent: true } | { readonly failed: string };

export type Target<P, R> =
  | { readonly catches: 'duplicates'; readonly call: (owed: Owed<P>, limits: Limits) => Promise<Outcome<R>> }
  | {
      readonly catches: 'nothing';
      readonly find: (owed: Owed<P>, limits: Limits) => Promise<Lookup<R>>;
      readonly call: (owed: Owed<P>, limits: Limits) => Promise<Outcome<R>>;
    };

export type Stands = (eb: ExpressionBuilder<DB, 'outbox' | 'task'>) => Expression<SqlBool>;

export type Performer<K extends string = string> = {
  readonly kind: K;
  readonly stands: Stands | null;
  readonly find: ((owed: Owed<unknown>, limits: Limits) => Promise<Lookup<unknown>>) | null;
  readonly call: (owed: Owed<unknown>, limits: Limits) => Promise<Outcome<unknown>>;
};

export type Performers<K extends string> = { readonly [Kind in K]: Performer<Kind> };

type StepsThatOwe = { readonly steps: readonly { readonly owes: readonly { readonly kind: string }[] }[] };

export type OwedKinds<W extends StepsThatOwe> = W['steps'][number]['owes'][number]['kind'];

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parsedPayload<P>(schema: z.ZodType<P>, owed: Owed<unknown>): Owed<P> | string {
  const payload = schema.safeParse(owed.payload);
  return payload.success ? { ...owed, payload: payload.data } : `The ${owed.kind} payload does not parse. ${z.prettifyError(payload.error)}`;
}

function checkedOutcome<R>(schema: z.ZodType<R>, outcome: Outcome<R>): Outcome<R> {
  if (!('done' in outcome)) return outcome;
  const result = schema.safeParse(outcome.done);
  return result.success ? { done: result.data } : { failed: `The performer's result does not parse. ${z.prettifyError(result.error)}` };
}

async function settle<R>(schema: z.ZodType<R>, call: () => Promise<Outcome<R>>): Promise<Outcome<R>> {
  try {
    return checkedOutcome(schema, await call());
  } catch (error) {
    return { failed: reason(error) };
  }
}

async function look<R>(schema: z.ZodType<R>, find: () => Promise<Lookup<R>>): Promise<Lookup<R>> {
  try {
    const found = await find();
    if (!('found' in found)) return found;
    const result = schema.safeParse(found.found);
    return result.success ? { found: result.data } : { failed: `The found result does not parse. ${z.prettifyError(result.error)}` };
  } catch (error) {
    return { failed: reason(error) };
  }
}

export function performer<K extends string, P, R>(kind: ActionSpec<K, P, R>, target: Target<P, R>, stands: Stands | null = null): Performer<K> {
  const typed = (owed: Owed<unknown>): Owed<P> | string => parsedPayload(kind.payload, owed);
  const call = (owed: Owed<unknown>, limits: Limits): Promise<Outcome<unknown>> => {
    const parsed = typed(owed);
    return typeof parsed === 'string' ? Promise.resolve({ failed: parsed }) : settle(kind.result, () => target.call(parsed, limits));
  };
  if (target.catches === 'duplicates') return { kind: kind.kind, stands, find: null, call };
  const { find } = target;
  return {
    kind: kind.kind,
    stands,
    call,
    find: (owed, limits) => {
      const parsed = typed(owed);
      return typeof parsed === 'string' ? Promise.resolve({ failed: parsed }) : look(kind.result, () => find(parsed, limits));
    },
  };
}

export const owesAction = (eb: ExpressionBuilder<DB, 'task'>): Expression<SqlBool> => eb('task.owed_actions', '>', 0);
