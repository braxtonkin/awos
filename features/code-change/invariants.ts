import type { MergeState } from '../../shared/merge-state.ts';
import type { DraftSetting } from './land.ts';

export type TaskView = { readonly step: string; readonly state: string; readonly waitingOn: string | null; readonly retries: number; readonly answered: readonly string[] };

export type LandRead = {
  readonly task: number;
  readonly value: MergeState['value'];
  readonly draft: DraftSetting;
  readonly countedGreen: boolean;
  readonly before: TaskView;
  readonly after: TaskView;
  readonly owed: readonly string[];
};

export type Merge = {
  readonly task: number;
  readonly how: 'perform' | 'arrive' | 'queue';
  readonly joins: 'merge' | 'queue';
  readonly before: TaskView;
  readonly sentBeforeStop: boolean;
  readonly fromEjection: string | null;
};

export type Settling = { readonly task: number; readonly view: TaskView; readonly newChangesRequest: boolean };

export type Observed =
  | { readonly kind: 'pass'; readonly reads: readonly LandRead[] }
  | { readonly kind: 'merge'; readonly merge: Merge }
  | { readonly kind: 'heads'; readonly merged: readonly { readonly task: number; readonly head: number; readonly judged: readonly number[] }[] }
  | { readonly kind: 'quiet'; readonly tasks: readonly Settling[] };

type Property = (observed: Observed) => readonly string[];

const returned = (view: TaskView): boolean => view.step !== 'land' || view.state === 'waiting';

const readsWhere = (observed: Observed, holds: (read: LandRead) => boolean, broken: (read: LandRead) => boolean, say: (read: LandRead) => string): readonly string[] =>
  observed.kind === 'pass' ? observed.reads.filter(read => holds(read) && broken(read)).map(say) : [];

const ejectionOf = (read: LandRead): string | null => (read.value.kind === 'ejected' && !read.before.answered.includes(read.value.ejection) ? read.value.ejection : null);

const landRetries = 2;

const typed = (view: TaskView): boolean =>
  ['land', 'implement'].includes(view.step) &&
  ['ready', 'waiting', 'done', 'stopped'].includes(view.state) &&
  (view.state === 'waiting') === (view.waitingOn !== null) &&
  view.retries >= 0 &&
  view.retries <= landRetries &&
  new Set(view.answered).size === view.answered.length;

const viewsIn = (observed: Observed): readonly (readonly [number, TaskView])[] => {
  switch (observed.kind) {
    case 'pass':
      return observed.reads.flatMap(read => [[read.task, read.before], [read.task, read.after]] as const);
    case 'merge':
      return [[observed.merge.task, observed.merge.before]];
    case 'quiet':
      return observed.tasks.map(entry => [entry.task, entry.view] as const);
    case 'heads':
      return [];
  }
};

export const properties = {
  TypeOK: observed =>
    viewsIn(observed)
      .filter(([, view]) => !typed(view))
      .map(([task, view]) => `task ${String(task)} was ${view.state} at ${view.step} on ${view.waitingOn ?? 'nothing'} with ${String(view.retries)} retries and answers ${view.answered.join(', ')}`),
  MergedHeadWasMergeable: observed =>
    observed.kind === 'heads'
      ? observed.merged.filter(entry => !entry.judged.includes(entry.head)).map(entry => `task ${String(entry.task)} merged head ${String(entry.head)}, which Land never judged mergeable`)
      : [],
  PerformedMergeWasAllowed: observed => {
    if (observed.kind !== 'merge') return [];
    const { merge } = observed;
    const atLand = merge.before.step === 'land' && merge.before.state === 'ready';
    const stoppedAfterSending = merge.before.state === 'stopped' && merge.sentBeforeStop;
    return atLand || stoppedAfterSending ? [] : [`task ${String(merge.task)} joined the ${merge.joins} by ${merge.how} while it was ${merge.before.state} at ${merge.before.step}`];
  },
  ReadyOnlyWhenChecksGreen: observed =>
    readsWhere(
      observed,
      read => read.owed.includes('pr.mark-ready') && read.draft === 'when-green',
      read => !read.countedGreen,
      read => `task ${String(read.task)} owed pr.mark-ready under ready when green while a counted check was not green`,
    ),
  RedCheckReturnsToImplement: observed =>
    readsWhere(
      observed,
      read => read.value.kind === 'red' && read.draft === 'when-green',
      read => !returned(read.after),
      read => `task ${String(read.task)} read a red check and stayed ${read.after.state} at ${read.after.step}`,
    ),
  ConflictReturnsToImplement: observed =>
    readsWhere(
      observed,
      read => read.value.kind === 'conflicting',
      read => !returned(read.after),
      read => `task ${String(read.task)} read a conflict and stayed ${read.after.state} at ${read.after.step}`,
    ),
  EjectionFailsLand: observed => {
    if (observed.kind === 'merge') {
      const { merge } = observed;
      return merge.fromEjection !== null && !merge.before.answered.includes(merge.fromEjection)
        ? [`task ${String(merge.task)} joined the queue again before Land answered ejection ${merge.fromEjection}`]
        : [];
    }
    return readsWhere(
      observed,
      read => ejectionOf(read) !== null,
      read => !(read.after.retries === read.before.retries + 1 || (read.after.state === 'waiting' && read.after.waitingOn === 'retry')),
      read => `task ${String(read.task)} read ejection ${ejectionOf(read) ?? ''} and did not fail its attempt`,
    );
  },
  LandSettles: observed =>
    observed.kind === 'quiet'
      ? observed.tasks
          .filter(({ view, newChangesRequest }) => !(['done', 'stopped'].includes(view.state) || (view.state === 'waiting' && !(view.waitingOn === 'outside_approval' && newChangesRequest))))
          .map(({ task, view }) => `task ${String(task)} was still ${view.state} at ${view.step} after the quiet phase`)
      : [],
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly detail: string };

export const propertyNames = Object.keys(properties).filter((name): name is PropertyName => Object.hasOwn(properties, name));

export const violationsOf = (observed: Observed): readonly Violation[] =>
  propertyNames.flatMap(property => properties[property](observed).map(detail => ({ property, detail })));
