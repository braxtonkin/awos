import { z } from 'zod';
import type { Owe } from '../../shared/actions.ts';
import type { MergeState } from '../../shared/merge-state.ts';
import type { Unasked } from '../../shared/workflow.ts';
import { violationsOf, type LandRead, type Observed, type PropertyName, type TaskView, type Violation } from './invariants.ts';
import { coreReview, guarded, landPass, type DraftSetting, type Follow, type Guards, type LandOutput, type LandStore, type Reading } from './land.ts';
import { workflow } from './workflow.ts';

export type WorldGuards = { readonly ActionCarriesHead: boolean; readonly FailedMergeKeepsClaim: boolean; readonly MergeClaimChecksTask: boolean; readonly LandPollIsFair: boolean };

export type GuardName = keyof Guards | keyof WorldGuards;

export const mutantName = z.enum([
  'ActionCarriesHead',
  'ReadyWaitsForGreen',
  'RedCheckSendsBack',
  'ConflictSendsBack',
  'EjectionEndsAttempt',
  'LandPollIsFair',
  'LandWaitsForMergeRow',
  'LandWaitsWhileQueued',
  'FailedMergeKeepsClaim',
  'MergeClaimChecksTask',
  'RefusalFailsAttempt',
  'AnyReviewResumesLand',
]);

export type MutantName = z.infer<typeof mutantName> & GuardName;

export const mutants: Readonly<Record<MutantName, PropertyName>> = {
  ActionCarriesHead: 'MergedHeadWasMergeable',
  ReadyWaitsForGreen: 'ReadyOnlyWhenChecksGreen',
  RedCheckSendsBack: 'RedCheckReturnsToImplement',
  ConflictSendsBack: 'ConflictReturnsToImplement',
  EjectionEndsAttempt: 'EjectionFailsLand',
  LandPollIsFair: 'LandSettles',
  LandWaitsForMergeRow: 'PerformedMergeWasAllowed',
  LandWaitsWhileQueued: 'PerformedMergeWasAllowed',
  FailedMergeKeepsClaim: 'PerformedMergeWasAllowed',
  MergeClaimChecksTask: 'PerformedMergeWasAllowed',
  RefusalFailsAttempt: 'LandSettles',
  AnyReviewResumesLand: 'LandSettles',
};

export type Plan = { readonly seeds: readonly number[]; readonly steps: number; readonly tasks: number; readonly mutant?: MutantName };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Run = {
  readonly seed: number;
  readonly mutant: MutantName | undefined;
  readonly failure: Failure | undefined;
  readonly trace: readonly string[];
  readonly settled: Readonly<Record<string, number>>;
  readonly outcomes: Readonly<Record<string, number>>;
};

type Random = () => number;

type CheckState = 'pending' | 'green' | 'red';

type Review = { readonly id: string; readonly kind: 'approve' | 'changes'; readonly ignored: boolean };

type Repo = { readonly queue: boolean; readonly reviews: boolean; readonly draft: DraftSetting; readonly required: readonly string[]; readonly ignoreLaterReviews: boolean };

type Pull = {
  head: number;
  checks: Map<string, CheckState>;
  draft: boolean;
  conflict: boolean;
  reviews: Review[];
  queue: 'none' | 'queued' | 'ejected';
  queuedHead: number;
  ejection: string | null;
  mergedAt: number | null;
  pushes: number;
  ejections: number;
  reruns: number;
  failures: number;
};

type Row = { readonly id: number; readonly kind: string; readonly commit: number | null; state: 'owed' | 'claimed' | 'done' | 'refused' | 'dropped'; refusedAt: number | null };

type Inflight = { readonly row: number; readonly commit: number };

type Task = {
  readonly index: number;
  readonly key: string;
  readonly repo: Repo;
  readonly pull: Pull;
  step: 'land' | 'implement';
  state: 'ready' | 'waiting' | 'done' | 'stopped';
  waitingOn: 'retry' | 'outside_approval' | null;
  retries: number;
  counts: Record<string, number>;
  attempt: string | null;
  answered: string[];
  rows: Row[];
  inflight: Inflight[];
  judged: number[];
  sentBeforeStop: boolean;
};

type World = { readonly random: Random; readonly tasks: Task[]; readonly land: Guards; readonly world: WorldGuards; readonly observed: Observed[]; attempts: number; rows: number; reviews: number };

const checks = ['c1', 'c2'] as const;

const ignorable: ReadonlySet<string> = new Set(['c2']);

const counted = checks.filter(check => !ignorable.has(check));

const limits = { pushes: 4, ejections: 2, reruns: 2, failures: 3, reviews: 3 } as const;

const traceTail = 40;

const landDeclared = workflow.steps[3];

const shaOf = (head: number): string => head.toString(16).padStart(40, '0');

const headOf = (sha: string): number => Number.parseInt(sha, 16);

function seeded(seed: number): Random {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const pick = <T>(random: Random, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

function weighted<T>(random: Random, choices: readonly (readonly [T, number])[]): T | undefined {
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [choice, weight] of choices) {
    roll -= weight;
    if (weight > 0 && roll < 0) return choice;
  }
  return undefined;
}

const viewOf = (task: Task): TaskView => ({ step: task.step, state: task.state, waitingOn: task.waitingOn, retries: task.retries, answered: [...task.answered] });

const standing = (task: Task): boolean => task.step === 'land' && task.state === 'ready';

const latestReview = (pull: Pull): Review | undefined => pull.reviews.filter(review => !review.ignored).at(-1);

const reviewSatisfied = (task: Task): boolean => !task.repo.reviews || latestReview(task.pull)?.kind === 'approve';

const allows = (task: Task, head: number): boolean =>
  task.pull.head === head && !task.pull.draft && !task.pull.conflict && task.repo.required.every(check => task.pull.checks.get(check) === 'green') && reviewSatisfied(task);

const countedGreen = (pull: Pull): boolean => counted.every(check => pull.checks.get(check) === 'green');

const newChangesRequest = (task: Task): boolean => {
  const latest = latestReview(task.pull);
  return latest?.kind === 'changes' && !task.answered.includes(latest.id);
};

function valueOf(task: Task, queuedFirst: boolean): MergeState['value'] {
  const { pull } = task;
  const red = counted.filter(check => pull.checks.get(check) === 'red');
  const latest = latestReview(pull);
  const queued: readonly MergeState['value'][] = pull.queue === 'queued' ? [{ kind: 'queued' }] : [];
  const ejected: readonly MergeState['value'][] = pull.queue === 'ejected' && pull.ejection !== null ? [{ kind: 'ejected', ejection: pull.ejection, reason: 'a required check failed in the queue' }] : [];
  const [first, ...rest] = red;
  const changes: readonly MergeState['value'][] = latest?.kind === 'changes' ? [{ kind: 'changes-requested', review: { id: latest.id, reviewer: 'reviewer', body: 'Please change this.', comments: [] } }] : [];
  const failing: readonly MergeState['value'][] = first === undefined ? [] : [{ kind: 'red', failing: [first, ...rest] }];
  const ranked: readonly MergeState['value'][] = [
    ...(pull.mergedAt === null ? [] : [{ kind: 'merged' } as const]),
    ...(queuedFirst ? queued : []),
    ...ejected,
    ...(pull.conflict ? [{ kind: 'conflicting' } as const] : []),
    ...failing,
    ...(counted.some(check => pull.checks.get(check) === 'pending') ? [{ kind: 'waiting-for-checks' } as const] : []),
    ...(pull.draft ? [{ kind: 'green-draft' } as const] : []),
    ...changes,
    ...(task.repo.reviews && latest?.kind !== 'approve' ? [{ kind: 'review-required' } as const] : []),
    ...(queuedFirst ? [] : queued),
  ];
  return ranked[0] ?? { kind: 'ready' };
}

function mergeAt(world: World, task: Task, commit: number, how: 'perform' | 'arrive'): 'merged' | 'queued' | 'already' | 'refused' {
  const { pull } = task;
  const head = world.world.ActionCarriesHead ? commit : pull.head;
  const unanswered = pull.queue === 'ejected' && pull.ejection !== null && !task.answered.includes(pull.ejection);
  if (pull.mergedAt !== null || pull.queue === 'queued' || unanswered) return 'already';
  if (!allows(task, head)) return 'refused';
  const merge = { task: task.index, how, before: viewOf(task), sentBeforeStop: task.sentBeforeStop, fromEjection: pull.queue === 'ejected' ? pull.ejection : null } as const;
  if (task.repo.queue) {
    world.observed.push({ kind: 'merge', merge: { ...merge, joins: 'queue' } });
    pull.queue = 'queued';
    pull.queuedHead = head;
    return 'queued';
  }
  world.observed.push({ kind: 'merge', merge: { ...merge, joins: 'merge' } });
  pull.mergedAt = head;
  return 'merged';
}

function route(task: Task, verdict: Unasked | null): void {
  const failure = verdict === null ? undefined : landDeclared.failures[verdict];
  const count = (counter: string): number => task.counts[counter] ?? 0;
  const park = (): void => {
    task.state = 'waiting';
    task.waitingOn = 'retry';
  };
  const back = (): void => {
    task.step = 'implement';
    task.retries = 0;
  };
  if (verdict === null) {
    task.state = 'done';
    return;
  }
  if (failure === undefined) throw new Error(`Land declares no verdict ${verdict}.`);
  switch (failure.kind) {
    case 'fail':
      if (task.retries >= 2) park();
      else task.retries += 1;
      return;
    case 'return': {
      const rounds = count(failure.counter) + 1;
      task.counts = { ...task.counts, [failure.counter]: rounds };
      if (rounds >= failure.cap) park();
      else back();
      return;
    }
    case 'review': {
      const reviews = count(failure.counter);
      if (reviews < failure.cap) {
        task.counts = { [failure.counter]: reviews + 1 };
        back();
      } else if (task.repo.ignoreLaterReviews) {
        task.state = 'waiting';
        task.waitingOn = 'outside_approval';
      } else park();
      return;
    }
    case 'await':
      task.state = 'waiting';
      task.waitingOn = 'outside_approval';
      return;
    case 'rerun':
      throw new Error(`Land never reports ${verdict}.`);
  }
}

function addRows(world: World, task: Task, owes: readonly Owe[]): void {
  for (const owed of owes) {
    const payload = z.object({ commit: z.string() }).safeParse(owed.payload);
    const commit = payload.success ? headOf(payload.data.commit) : null;
    world.rows += 1;
    task.rows.push({ id: world.rows, kind: owed.kind, commit, state: 'owed', refusedAt: null });
    if (owed.kind === 'pr.merge' && commit !== null) task.judged.push(commit);
  }
}

function storeOf(world: World, reads: Map<number, LandRead>): LandStore {
  const byId = (id: string): Task | undefined => world.tasks.find(task => task.key === id);
  const holding = (attempt: string): Task | undefined => world.tasks.find(task => task.attempt === attempt);
  const settle = (task: Task, apply: () => void): void => {
    task.attempt = null;
    apply();
    const read = reads.get(task.index);
    if (read !== undefined) reads.set(task.index, { ...read, after: viewOf(task) });
  };
  return {
    atLand: () =>
      Promise.resolve(
        world.tasks
          .filter(task => task.step === 'land' && (task.state === 'ready' || (task.state === 'waiting' && task.waitingOn === 'outside_approval')))
          .map(task => {
            const merges = task.rows.filter(row => row.kind === 'pr.merge');
            const last = merges.at(-1);
            return {
              task: task.key,
              key: task.key,
              pull: { repository: 'owner/repository', branch: `autoworker/${task.key}`, number: task.index + 1 },
              awaiting: task.state === 'waiting',
              owes: task.rows.some(row => row.state === 'owed' || row.state === 'claimed'),
              attempt: task.attempt,
              record: {
                answered: [...task.answered],
                markedReady: task.rows.some(row => row.kind === 'pr.mark-ready' && row.state !== 'dropped'),
                refusedAt: last?.state === 'refused' && last.refusedAt !== null ? shaOf(last.refusedAt) : null,
                gatesApproved: true,
                evidence: 'The reproduction failed before the change and passed after it.',
              },
            };
          }),
      ),
    claim: task => {
      const found = byId(task);
      if (found === undefined || !standing(found) || found.attempt !== null) return Promise.resolve(undefined);
      world.attempts += 1;
      found.attempt = `attempt-${String(world.attempts)}`;
      return Promise.resolve(found.attempt);
    },
    renew: attempt => Promise.resolve(holding(attempt) !== undefined),
    handOff: (attempt, _output: LandOutput, owes) => {
      const task = holding(attempt);
      if (task === undefined || !standing(task)) return Promise.resolve(false);
      settle(task, () => {
        addRows(world, task, owes);
      });
      const read = reads.get(task.index);
      if (read !== undefined) reads.set(task.index, { ...read, owed: owes.map(owed => owed.kind) });
      return Promise.resolve(true);
    },
    finish: (attempt, verdict, output: LandOutput, follow: Follow) => {
      const task = holding(attempt);
      if (task === undefined) return Promise.resolve(false);
      settle(task, () => {
        if (output.answers !== undefined) task.answered.push(output.answers);
        route(task, verdict);
        if (task.state === 'done') addRows(world, task, follow.whenDone);
        if (task.state === 'waiting' && task.waitingOn === 'outside_approval' && follow.whenAwaiting !== null) addRows(world, task, follow.whenAwaiting.actions);
      });
      return Promise.resolve(true);
    },
    resume: id => {
      const task = byId(id);
      if (task?.state !== 'waiting' || task.waitingOn !== 'outside_approval') return Promise.resolve(false);
      task.state = 'ready';
      task.waitingOn = null;
      return Promise.resolve(true);
    },
  };
}

async function runLand(world: World): Promise<string> {
  const reads = new Map<number, LandRead>();
  const queuedFirst = world.land.LandWaitsWhileQueued;
  const read = (pull: { readonly branch: string }): Promise<Reading> => {
    const task = world.tasks.find(candidate => `autoworker/${candidate.key}` === pull.branch);
    if (task === undefined) return Promise.reject(new Error(`no pull request for ${pull.branch}`));
    const value = valueOf(task, queuedFirst);
    if (standing(task)) reads.set(task.index, { task: task.index, value, draft: task.repo.draft, countedGreen: countedGreen(task.pull), before: viewOf(task), after: viewOf(task), owed: [] });
    return Promise.resolve({ state: { head: shaOf(task.pull.head), value }, draft: task.repo.draft });
  };
  const lines = await landPass({ store: storeOf(world, reads), read, review: coreReview, guards: world.land });
  world.observed.push({ kind: 'pass', reads: [...reads.values()] });
  return lines.join('; ');
}

function push(task: Task): void {
  const { pull } = task;
  pull.head += 1;
  pull.pushes += 1;
  pull.checks = new Map(checks.map(check => [check, 'pending']));
  pull.conflict = false;
  if (pull.queue === 'queued') eject(task);
}

function eject(task: Task): void {
  task.pull.queue = 'ejected';
  task.pull.ejections += 1;
  task.pull.ejection = `ejection-${String(task.index)}-${String(task.pull.ejections)}`;
}

function perform(world: World, task: Task, faults: boolean): string {
  const row = task.rows.find(candidate => candidate.state === 'owed' || candidate.state === 'claimed');
  if (row?.state !== 'owed') return `task ${task.key} has no owed row to perform`;
  if (task.state === 'stopped' && world.world.MergeClaimChecksTask) return `task ${task.key} is stopped, so its rows wait`;
  if (row.kind === 'pr.merge' && world.world.MergeClaimChecksTask && !standing(task)) {
    row.state = 'dropped';
    return `dropped ${row.kind} of task ${task.key}, because the task no longer stands at Land`;
  }
  if (faults && task.pull.failures < limits.failures && world.random() < 0.4 && row.kind === 'pr.merge' && row.commit !== null) {
    task.pull.failures += 1;
    task.inflight.push({ row: row.id, commit: row.commit });
    row.state = world.world.FailedMergeKeepsClaim ? 'claimed' : 'owed';
    return `the ${row.kind} call of task ${task.key} failed with its request still in flight`;
  }
  if (row.kind === 'pr.mark-ready') task.pull.draft = false;
  if (row.kind === 'pr.merge' && row.commit !== null) {
    const outcome = mergeAt(world, task, row.commit, 'perform');
    row.state = outcome === 'refused' ? 'refused' : 'done';
    row.refusedAt = outcome === 'refused' ? row.commit : null;
    return `performed pr.merge of task ${task.key} at head ${String(row.commit)}: ${outcome}`;
  }
  row.state = 'done';
  return `performed ${row.kind} of task ${task.key}`;
}

type Move = { readonly name: string; readonly weight: (quiet: boolean) => number; readonly tasks: (task: Task) => boolean; readonly apply: (world: World, task: Task, quiet: boolean) => string };

const always = (weight: number) => (): number => weight;

const loud = (weight: number) => (quiet: boolean): number => (quiet ? 0 : weight);

const moves: readonly Move[] = [
  {
    name: 'perform',
    weight: always(2),
    tasks: task => task.rows.some(row => row.state === 'owed'),
    apply: (world, task, quiet) => perform(world, task, !quiet),
  },
  {
    name: 'arrive',
    weight: always(0.4),
    tasks: task => task.inflight.length > 0,
    apply: (world, task) => {
      const [first, ...rest] = task.inflight;
      task.inflight = rest;
      if (first === undefined) return 'nothing in flight';
      if (world.random() < 0.3) return `the request of task ${task.key} vanished`;
      return `the request of task ${task.key} arrived: ${mergeAt(world, task, first.commit, 'arrive')}`;
    },
  },
  {
    name: 'lapse',
    weight: always(1),
    tasks: task => task.inflight.length === 0 && task.rows.some(row => row.state === 'claimed'),
    apply: (_world, task) => {
      task.rows.forEach(row => {
        if (row.state === 'claimed') row.state = 'owed';
      });
      return `the claim on a row of task ${task.key} lapsed`;
    },
  },
  {
    name: 'queue',
    weight: always(1),
    tasks: task => task.pull.queue === 'queued',
    apply: (world, task) => {
      const { pull } = task;
      if (allows(task, pull.queuedHead) && (pull.ejections >= limits.ejections || world.random() < 0.6)) {
        world.observed.push({ kind: 'merge', merge: { task: task.index, how: 'queue', joins: 'merge', before: viewOf(task), sentBeforeStop: task.sentBeforeStop, fromEjection: null } });
        pull.mergedAt = pull.queuedHead;
        pull.queue = 'none';
        return `the queue merged task ${task.key} at head ${String(pull.queuedHead)}`;
      }
      eject(task);
      return `the queue ejected task ${task.key}`;
    },
  },
  {
    name: 'implement',
    weight: always(2),
    tasks: task => task.step === 'implement' && task.state === 'ready',
    apply: (world, task) => {
      if (task.pull.pushes >= limits.pushes || world.random() < 0.05) {
        task.state = 'waiting';
        task.waitingOn = 'retry';
        return `Implement parked task ${task.key}`;
      }
      push(task);
      task.step = 'land';
      return `Implement pushed head ${String(task.pull.head)} of task ${task.key}`;
    },
  },
  {
    name: 'finish',
    weight: always(3),
    tasks: task => task.pull.mergedAt === null && [...task.pull.checks.values()].includes('pending'),
    apply: (world, task) => {
      const check = pick(
        world.random,
        checks.filter(name => task.pull.checks.get(name) === 'pending'),
      );
      if (check === undefined) return 'no check pending';
      const result = world.random() < 0.9 ? 'green' : 'red';
      task.pull.checks.set(check, result);
      return `check ${check} of task ${task.key} turned ${result}`;
    },
  },
  {
    name: 'rerun',
    weight: loud(0.8),
    tasks: task => task.pull.mergedAt === null && task.pull.reruns < limits.reruns && standing(task),
    apply: (world, task) => {
      const check = pick(world.random, counted);
      if (check === undefined) return 'no check';
      task.pull.reruns += 1;
      task.pull.checks.set(check, 'pending');
      return `check ${check} of task ${task.key} runs again`;
    },
  },
  {
    name: 'push in the gap',
    weight: loud(0.5),
    tasks: task => task.pull.mergedAt === null && task.pull.pushes < limits.pushes && standing(task) && (task.inflight.length > 0 || task.rows.some(row => row.kind === 'pr.merge' && row.state !== 'done' && row.state !== 'refused' && row.state !== 'dropped')),
    apply: (_world, task) => {
      push(task);
      task.pull.checks = new Map(checks.map(check => [check, 'green']));
      return `someone pushed head ${String(task.pull.head)} to task ${task.key} while its merge was on its way, and its checks passed at once`;
    },
  },
  {
    name: 'outside push',
    weight: loud(0.5),
    tasks: task => task.pull.mergedAt === null && task.pull.pushes < limits.pushes && standing(task),
    apply: (_world, task) => {
      push(task);
      return `someone pushed head ${String(task.pull.head)} to task ${task.key}`;
    },
  },
  {
    name: 'conflict',
    weight: loud(0.2),
    tasks: task => task.pull.mergedAt === null && !task.pull.conflict && standing(task),
    apply: (_world, task) => {
      task.pull.conflict = true;
      return `the base branch of task ${task.key} moved and conflicts`;
    },
  },
  {
    name: 'review',
    weight: loud(1),
    tasks: task => task.pull.mergedAt === null && !task.pull.draft && task.pull.reviews.length < limits.reviews && task.state !== 'done' && task.state !== 'stopped',
    apply: (world, task) => {
      world.reviews += 1;
      const ignored = world.random() < 0.2;
      const kind = ignored || world.random() < 0.5 || !task.repo.reviews ? 'changes' : 'approve';
      task.pull.reviews.push({ id: `review-${String(world.reviews)}`, kind, ignored });
      return `${ignored ? 'an ignored reviewer' : 'a reviewer'} left a review of kind ${kind} on task ${task.key}`;
    },
  },
  {
    name: 'stop',
    weight: loud(0.1),
    tasks: task => standing(task) && (task.rows.some(row => row.kind === 'pr.merge' && (row.state === 'owed' || row.state === 'claimed')) || task.inflight.length > 0 || task.pull.queue === 'queued'),
    apply: (_world, task) => {
      task.sentBeforeStop = task.inflight.length > 0 || task.pull.queue === 'queued';
      task.state = 'stopped';
      task.waitingOn = null;
      task.attempt = null;
      return `a person stopped task ${task.key}`;
    },
  },
];

function settings(random: Random): Repo {
  return {
    queue: random() < 0.5,
    reviews: random() < 0.5,
    draft: random() < 0.5 ? 'when-green' : 'at-once',
    required: [pick(random, checks) ?? 'c1'],
    ignoreLaterReviews: random() < 0.5,
  };
}

function worldOf(random: Random, tasks: number, mutant: MutantName | undefined): World {
  const off = <G extends object>(guards: G): G => (mutant !== undefined && mutant in guards ? { ...guards, [mutant]: false } : guards);
  return {
    random,
    land: off(guarded),
    world: off({ ActionCarriesHead: true, FailedMergeKeepsClaim: true, MergeClaimChecksTask: true, LandPollIsFair: true }),
    observed: [],
    attempts: 0,
    rows: 0,
    reviews: 0,
    tasks: Array.from({ length: tasks }, (_, index) => ({
      index,
      key: `SIM-${String(index + 1)}`,
      repo: settings(random),
      pull: {
        head: 0,
        checks: new Map(checks.map(check => [check, 'pending'])),
        draft: true,
        conflict: false,
        reviews: [],
        queue: 'none',
        queuedHead: 0,
        ejection: null,
        mergedAt: null,
        pushes: 0,
        ejections: 0,
        reruns: 0,
        failures: 0,
      },
      step: 'land',
      state: 'ready',
      waitingOn: null,
      retries: 0,
      counts: {},
      attempt: null,
      answered: [],
      rows: [],
      inflight: [],
      judged: [],
      sentBeforeStop: false,
    })),
  };
}

async function step(world: World, quiet: boolean): Promise<string> {
  const options = moves.flatMap(move => world.tasks.filter(move.tasks).map(task => [[move, task] as const, move.weight(quiet)] as const));
  const landWeight = world.world.LandPollIsFair ? 3 : 0;
  const chosen = weighted<readonly [Move, Task] | 'land'>(world.random, [...options, ['land', landWeight]]);
  if (chosen === undefined) return 'nothing can move';
  if (chosen === 'land') return `land pass: ${await runLand(world)}`;
  const [move, task] = chosen;
  return `${move.name}: ${move.apply(world, task, quiet)}`;
}

function heads(world: World): Observed {
  return {
    kind: 'heads',
    merged: world.tasks.flatMap(task => (task.pull.mergedAt === null ? [] : [{ task: task.index, head: task.pull.mergedAt, judged: [...task.judged] }])),
  };
}

const tally = (values: readonly string[]): Readonly<Record<string, number>> => values.reduce<Record<string, number>>((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});

export async function runSeed(plan: Plan, seed: number): Promise<Run> {
  const random = seeded(seed);
  const world = worldOf(random, plan.tasks, plan.mutant);
  const trace: string[] = [];
  const outcomes: string[] = [];
  const quietSteps = plan.steps * 2;
  let failure: Failure | undefined;
  for (let index = 0; index < plan.steps + quietSteps && failure === undefined; index += 1) {
    const quiet = index >= plan.steps;
    world.observed.length = 0;
    const move = await step(world, quiet);
    trace.push(`${String(index)} ${move}`);
    outcomes.push(move.split(':')[0] ?? move);
    const broken = [...world.observed, heads(world)].flatMap(violationsOf);
    if (broken.length > 0) failure = { step: index, move, broken };
  }
  if (failure === undefined) {
    const quiet: Observed = { kind: 'quiet', tasks: world.tasks.map(task => ({ task: task.index, view: viewOf(task), newChangesRequest: newChangesRequest(task) })) };
    const broken = violationsOf(quiet);
    if (broken.length > 0) failure = { step: plan.steps + quietSteps, move: 'quiet phase ends', broken };
  }
  return { seed, mutant: plan.mutant, failure, trace: trace.slice(-traceTail), settled: tally(world.tasks.map(task => `${task.state}${task.waitingOn === null ? '' : ` on ${task.waitingOn}`}`)), outcomes: tally(outcomes) };
}

export async function simulate(plan: Plan): Promise<readonly Run[]> {
  const runs: Run[] = [];
  for (const seed of plan.seeds) runs.push(await runSeed(plan, seed));
  return runs;
}
