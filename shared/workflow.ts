import { z } from 'zod';
import type { Verdict } from './db/types.ts';
import type { BlockKind, Review } from './review.ts';

type Capital = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

export type Instruction = `${Capital}${string}.`;

export type StepVerdict = Exclude<Verdict, 'lost' | 'stopped' | 'handed_off'>;

type FailureVerdict = Exclude<StepVerdict, 'pass'>;

export type Unasked = Exclude<FailureVerdict, 'needs_input'>;

type Charge = { readonly counter: string; readonly cap: number; readonly parks: Instruction };

type Route =
  | { readonly kind: 'fail' }
  | (Charge & { readonly kind: 'return'; readonly to: string })
  | (Charge & { readonly kind: 'rerun' })
  | (Charge & { readonly kind: 'review'; readonly to: string; readonly ignored: Instruction })
  | { readonly kind: 'await'; readonly waits: Instruction };

export type Failure = Route | { readonly kind: 'ask' };

type Failures = { readonly needs_input?: { readonly kind: 'ask' } } & { readonly [verdict in Unasked]?: Route };

type OwedAction<K extends string> = { readonly kind: K; readonly irreversible: boolean };

const judged = Symbol('judged');

const builtBySteps = new WeakSet<object>();

type Judge = ((output: unknown) => StepVerdict) & { readonly [judged]: true };

export type AfterTurn = 'push' | 'reproduce';

export type JobAfterTurn = { readonly kind: 'push' } | { readonly kind: 'reproduce'; readonly base: string; readonly setup: string | null };

export type RunBy = { readonly runBy: 'agent'; readonly prompt: string; readonly startsEnvironment: boolean; readonly afterTurn: AfterTurn } | { readonly runBy: 'engine' };

type Common<K extends string> = {
  readonly name: string;
  readonly reads: readonly string[];
  readonly needsRepository: boolean;
  readonly canEnd: boolean;
  readonly owes: readonly OwedAction<K>[];
  readonly output: z.ZodType<Review>;
  readonly requires: readonly BlockKind[];
  readonly failures: Failures;
  readonly blocked: Unasked;
  readonly judge: Judge;
};

export type StepKind<K extends string = string> = Common<K> & RunBy;

export type AgentStepKind<K extends string = string> = StepKind<K> & { readonly runBy: 'agent' };

export const runByAgent = (kind: StepKind): kind is AgentStepKind => kind.runBy === 'agent';

type Declared<O extends Review, F extends Failures, K extends string> = Omit<Common<K>, 'output' | 'failures' | 'blocked' | 'judge'> & RunBy & {
  readonly output: z.ZodType<O>;
  readonly failures: F;
  readonly blocked: keyof F & Unasked;
  readonly done: (output: O) => 'pass' | (keyof F & Unasked);
};

export function step<O extends Review, F extends Failures, K extends string = never>({ done, ...declared }: Declared<O, F, K>): StepKind<K> {
  const judge = (raw: unknown): StepVerdict => {
    const parsed = declared.output.safeParse(raw);
    if (!parsed.success) return declared.blocked;
    const { outcome, blocks } = parsed.data;
    if (outcome === 'needs_input' && declared.failures.needs_input !== undefined) return 'needs_input';
    if (outcome !== 'done' || !declared.requires.every(kind => blocks.some(block => block.kind === kind))) return declared.blocked;
    return done(parsed.data);
  };
  const kind: StepKind<K> = { ...declared, judge: Object.assign(judge, { [judged]: true as const }) };
  builtBySteps.add(kind);
  return kind;
}

export const builtByStep = (kind: StepKind): boolean => builtBySteps.has(kind);

export const outputSchema = (kind: StepKind): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(z.toJSONSchema(kind.output, { target: 'draft-7', io: 'output' })).filter(([key]) => key !== '$schema'));

export type Workflow<K extends string = string> = { readonly name: string; readonly steps: readonly [StepKind<K>, ...StepKind<K>[]] };

export type Shape = {
  readonly steps: readonly string[];
  readonly endSteps: readonly string[];
  readonly checks: readonly string[];
  readonly merges: readonly string[];
  readonly returnsTo: readonly string[];
  readonly asking: readonly string[];
};

export function shapeOf({ steps }: Workflow): Shape {
  const where = (holds: (kind: StepKind) => boolean): readonly string[] => steps.filter(holds).map(kind => kind.name);
  const declares = (kind: StepKind, verdicts: readonly Unasked[]): boolean => verdicts.some(verdict => kind.failures[verdict] !== undefined);
  return {
    steps: steps.map(kind => kind.name),
    endSteps: where(kind => kind.canEnd),
    checks: where(kind => declares(kind, ['behavior_fail', 'environment_fail'])),
    merges: where(kind => declares(kind, ['red_check', 'changes_requested', 'review_required'])),
    returnsTo: [...new Set(steps.flatMap(kind => Object.values(kind.failures).flatMap(failure => ('to' in failure ? [failure.to] : []))))],
    asking: where(kind => kind.failures.needs_input !== undefined),
  };
}
