import { z } from 'zod';
import { marker, type Outcome, type Owed, type Performer } from '../../shared/actions.ts';
import type { Answered, MergeValue } from '../../shared/merge-state.ts';
import { githubClient, type GithubClient } from './client.ts';
import { base, checkNames, checksAt, commitOn, eject, fakeFetch, headOf, mergeNow, moveBranch, newWorld, openPullRequest, repository, rerun, reviewDecision, type Faults, type FakePull, type World } from './fake-github.ts';
import { judge, type Broken, type Observation, type PropertyName, type Truth } from './invariants.ts';
import { ranking, readWith, type Rank, type Rules } from './merge-state.ts';
import { githubPerformers, mergeGuarded, type GithubKind, type MergeGuards, type OwedMerge } from './performers.ts';

export const mutantName = z.enum(['ActionCarriesHead', 'ReadyWaitsForGreen', 'RedCheckSendsBack', 'ConflictSendsBack', 'EjectionEndsAttempt', 'LandWaitsWhileQueued', 'MergeRereadsFacts']);

export type MutantName = z.infer<typeof mutantName>;

type Rewrite = Faults['rewrite'];

type Mutant = { readonly breaks: PropertyName; readonly ranks: readonly Rank[]; readonly rewrite: Rewrite; readonly merge: MergeGuards };

const keep: Rewrite = (_method, _path, body) => body;

const without = (name: string): readonly Rank[] => ranking.filter(rank => rank.name !== name);

const rankNamed = (name: string): Rank => {
  const found = ranking.find(rank => rank.name === name);
  if (found === undefined) throw new Error(`The ranking has no row named ${name}.`);
  return found;
};

const headless: Rewrite = (method, path, body) => {
  if (method === 'PUT' && path.endsWith('/merge')) return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'sha'));
  const variables = z.record(z.string(), z.unknown()).safeParse(body['variables']);
  if (path === '/graphql' && variables.success && String(body['query']).includes('enqueuePullRequest')) {
    return { ...body, variables: Object.fromEntries(Object.entries(variables.data).filter(([key]) => key !== 'head')) };
  }
  return body;
};

export const mutants: Readonly<Record<MutantName, Mutant>> = {
  ActionCarriesHead: { breaks: 'MergedHeadWasMergeable', ranks: ranking, rewrite: headless, merge: mergeGuarded },
  ReadyWaitsForGreen: {
    breaks: 'ReadyOnlyWhenChecksGreen',
    ranks: ranking.map(rank => (rank.name === 'green-draft' ? { name: rank.name, value: view => (view.draft ? { kind: 'green-draft' } : undefined) } : rank)),
    rewrite: keep,
    merge: mergeGuarded,
  },
  RedCheckSendsBack: { breaks: 'RedCheckReturnsToImplement', ranks: without('red'), rewrite: keep, merge: mergeGuarded },
  ConflictSendsBack: { breaks: 'ConflictReturnsToImplement', ranks: without('conflicting'), rewrite: keep, merge: mergeGuarded },
  EjectionEndsAttempt: { breaks: 'EjectionFailsLand', ranks: without('ejected'), rewrite: keep, merge: mergeGuarded },
  LandWaitsWhileQueued: { breaks: 'PerformedMergeWasAllowed', ranks: [...without('queued'), rankNamed('queued')], rewrite: keep, merge: mergeGuarded },
  MergeRereadsFacts: { breaks: 'MergedHeadWasMergeable', ranks: ranking, rewrite: keep, merge: { MergeRereadsFacts: false } },
};

export type Plan = { readonly seeds: readonly number[]; readonly steps: number; readonly mutant?: MutantName };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Broken[] };

export type Run = {
  readonly seed: number;
  readonly plan: Plan;
  readonly failure: Failure | undefined;
  readonly merged: number;
  readonly settled: number;
  readonly reads: number;
  readonly lostReplies: number;
  readonly values: ReadonlySet<string>;
};

type Step = 'open' | 'land' | 'implement' | 'awaiting' | 'done' | 'waiting';

const settledSteps: ReadonlySet<Step> = new Set(['awaiting', 'done', 'waiting']);

type Task = {
  readonly key: string;
  readonly branch: string;
  readonly rules: Rules;
  step: Step;
  pull: number | null;
  answered: Answered;
  landFails: number;
  rounds: number;
  readonly opened: number[];
};

type Row = { readonly id: string; readonly task: Task; readonly kind: GithubKind; readonly payload: unknown; readonly owedAt: Date; settled: boolean };

type Sim = {
  readonly world: World;
  readonly random: () => number;
  readonly client: GithubClient;
  readonly performers: Readonly<Record<GithubKind, Performer>>;
  readonly ranks: readonly Rank[];
  readonly tasks: Task[];
  readonly rows: Row[];
  readonly judged: Set<string>;
  readonly values: Set<string>;
  readonly fault: { lost: boolean; count: number };
  reads: number;
  seenMerges: number;
  seenEnqueues: number;
};

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

const chance = (random: () => number, odds: number): boolean => random() < odds;

const now = (world: World): Date => new Date(Date.UTC(2026, 0, 1) + world.time * 1000);

const active = (sim: Sim): Task | undefined => sim.tasks.find(task => !settledSteps.has(task.step));

const pullOf = (sim: Sim, task: Task): FakePull | undefined => sim.world.pulls.find(pull => pull.number === task.pull);

const owedMerge = (row: Row | undefined): OwedMerge | undefined => (row === undefined ? undefined : { owedAt: row.owedAt, rules: row.task.rules });

const oweRow = (sim: Sim, task: Task, kind: GithubKind, payload: unknown): void => {
  sim.rows.push({ id: String(sim.rows.length + 1), task, kind, payload, owedAt: now(sim.world), settled: false });
};

function startTask(sim: Sim): void {
  const { world, random } = sim;
  world.settings = { queue: chance(random, 0.4), requireReviews: chance(random, 0.3), strict: chance(random, 0.3) };
  const key = `SIM-${String(sim.tasks.length + 1)}`;
  const task: Task = {
    key,
    branch: `autoworker/${key}`,
    rules: { ignorableChecks: new Set([checkNames.ignorable]), ignoredReviewers: new Set(['bot']), draftLeaves: chance(random, 0.3) ? 'at-once' : 'when-green' },
    step: 'open',
    pull: null,
    answered: { ejection: null, review: null },
    landFails: 0,
    rounds: 0,
    opened: [],
  };
  sim.tasks.push(task);
  const first = commitOn(world, [world.branches.get(base) ?? '']);
  oweRow(sim, task, 'branch.advance', { repository, branch: task.branch, from: null, to: first });
  const opening = { repository, head: task.branch, base, title: `Simulated change ${key}`, body: 'Opened by the simulator.' };
  oweRow(sim, task, 'pr.open-draft', opening);
  if (chance(random, 0.3)) oweRow(sim, task, 'pr.open-draft', opening);
}

function truthOf(sim: Sim, task: Task, pull: FakePull): Truth {
  const head = headOf(sim.world, pull);
  const checks = checksAt(sim.world, head);
  const counted = [checkNames.required, checkNames.counted];
  const ejection = pull.ejections.at(-1);
  return {
    open: !pull.closed && pull.merged === null,
    queued: pull.queued !== null,
    unansweredEjection: ejection === undefined || ejection.id === task.answered.ejection ? null : ejection.id,
    conflictReported: pull.mergeabilityKnown && pull.conflict,
    draft: pull.draft,
    leavesDraftAtOnce: task.rules.draftLeaves === 'at-once',
    countedRed: counted.filter(name => checks.get(name) === 'red'),
    countedAllGreen: counted.every(name => checks.get(name) === 'green'),
    approved: reviewDecision(sim.world, pull) === 'APPROVED',
  };
}

const landRetries = 3;

const landRounds = 3;

function failAttempt(task: Task): void {
  task.landFails += 1;
  if (task.landFails > landRetries) task.step = 'waiting';
}

function decide(sim: Sim, task: Task, number: number, head: string, value: MergeValue): void {
  const updated = { repository, head: task.branch, commit: head };
  switch (value.kind) {
    case 'merged':
      oweRow(sim, task, 'branch.delete', { repository, branch: task.branch });
      task.step = 'done';
      return;
    case 'ejected':
      task.answered = { ...task.answered, ejection: value.ejection };
      failAttempt(task);
      return;
    case 'changes-requested':
      task.step = task.answered.review === null ? 'implement' : 'waiting';
      task.answered = { ...task.answered, review: value.review.id };
      return;
    case 'conflicting':
    case 'red':
      task.rounds += 1;
      task.step = task.rounds > landRounds ? 'waiting' : 'implement';
      return;
    case 'green-draft':
      oweRow(sim, task, 'pr.mark-ready', { repository, head: task.branch, evidence: `Evidence for ${head}.` });
      return;
    case 'behind':
      oweRow(sim, task, 'pr.update-branch', updated);
      return;
    case 'ready':
      sim.judged.add(head);
      oweRow(sim, task, 'pr.merge', { repository, number, commit: head });
      return;
    case 'queued':
    case 'waiting-for-checks':
      return;
    case 'review-required':
      task.step = 'awaiting';
      return;
  }
}

async function land(sim: Sim): Promise<readonly Observation[]> {
  const task = active(sim);
  if (task?.step !== 'land' || task.pull === null || sim.rows.some(row => row.task === task && !row.settled)) return [];
  const pull = pullOf(sim, task);
  if (pull === undefined) return [];
  sim.reads += 1;
  const read = await readWith(sim.client, { github: repository, number: task.pull, rules: task.rules }, task.answered, new AbortController().signal, sim.ranks);
  if ('failed' in read) return [{ kind: 'performed', action: 'merge-state read', outcome: 'failed', faulted: false, detail: read.failed }];
  const truth = truthOf(sim, task, pull);
  sim.values.add(read.state.value.kind);
  decide(sim, task, task.pull, read.state.head, read.state.value);
  return [{ kind: 'read', head: read.state.head, value: read.state.value, truth }];
}

const limits = () => ({ deadline: new Date(Date.now() + 60_000), signal: new AbortController().signal });

const numberIn = z.object({ number: z.int() });

const mergeRefused = (row: Row, outcome: Outcome<unknown>): boolean => row.kind === 'pr.merge' && 'refused' in outcome;

async function perform(sim: Sim): Promise<readonly Observation[]> {
  const row = sim.rows.find(entry => !entry.settled);
  if (row === undefined) return [];
  const owed: Owed<unknown> = { row: row.id, task: row.task.key, kind: row.kind, payload: row.payload, marker: marker.parse(`simulated-marker-${row.id.padStart(8, '0')}`), actsAs: '1' };
  sim.fault.lost = false;
  const outcome = await sim.performers[row.kind].call(owed, limits());
  const faulted = sim.fault.lost;
  if ('failed' in outcome) return [{ kind: 'performed', action: row.kind, outcome: 'failed', faulted, detail: outcome.failed }];
  row.settled = true;
  if (mergeRefused(row, outcome)) failAttempt(row.task);
  const observations: Observation[] = [{ kind: 'performed', action: row.kind, outcome: 'done' in outcome ? 'done' : 'refused', faulted, detail: JSON.stringify(outcome) }];
  const opened = 'done' in outcome && row.kind === 'pr.open-draft' ? numberIn.safeParse(outcome.done) : undefined;
  if (opened?.success === true) {
    row.task.opened.push(opened.data.number);
    row.task.pull = opened.data.number;
    if (row.task.step === 'open' && !sim.rows.some(entry => entry.task === row.task && !entry.settled)) row.task.step = 'land';
    observations.push({ kind: 'opened', numbers: [...row.task.opened] });
  }
  return observations;
}

function implement(sim: Sim): void {
  const task = active(sim);
  if (task?.step !== 'implement') return;
  const from = sim.world.branches.get(task.branch) ?? '';
  oweRow(sim, task, 'branch.advance', { repository, branch: task.branch, from, to: commitOn(sim.world, [from]) });
  task.step = 'land';
}

function openPullOfActive(sim: Sim): FakePull | undefined {
  const task = active(sim);
  const pull = task === undefined ? undefined : pullOf(sim, task);
  return pull === undefined || pull.merged !== null || pull.closed ? undefined : pull;
}

type Move = { readonly name: string; readonly weight: number; readonly run: (sim: Sim) => Promise<readonly Observation[]> | readonly Observation[] };

const outside =
  (act: (sim: Sim, pull: FakePull) => void) =>
  (sim: Sim): readonly Observation[] => {
    const pull = openPullOfActive(sim);
    if (pull !== undefined) act(sim, pull);
    return [];
  };

function rerunOne(sim: Sim, pull: FakePull): void {
  const head = headOf(sim.world, pull);
  const name = pick(sim.random, [...checksAt(sim.world, head)].filter(([, result]) => result !== 'pending').map(([check]) => check));
  if (name !== undefined) rerun(sim.world, head, name);
}

const mergeOwed = (sim: Sim, pull: FakePull): boolean => sim.rows.some(row => !row.settled && row.kind === 'pr.merge' && row.task.pull === pull.number);

const moves: readonly Move[] = [
  { name: 'land reads the merge state', weight: 3, run: land },
  { name: 'the outbox performs a row', weight: 3, run: perform },
  {
    name: 'implement pushes a fix',
    weight: 2,
    run: sim => {
      implement(sim);
      return [];
    },
  },
  {
    name: 'someone pushes to the head',
    weight: 0.3,
    run: outside((sim, pull) => {
      const from = headOf(sim.world, pull);
      const to = commitOn(sim.world, [from]);
      moveBranch(sim.world, pull.branch, to);
    }),
  },
  {
    name: 'the required check reports',
    weight: 2,
    run: outside((sim, pull) => {
      const checks = checksAt(sim.world, headOf(sim.world, pull));
      if (!checks.has(checkNames.required)) checks.set(checkNames.required, 'pending');
    }),
  },
  {
    name: 'a check finishes',
    weight: 6,
    run: outside((sim, pull) => {
      const checks = checksAt(sim.world, headOf(sim.world, pull));
      const name = pick(sim.random, [...checks].filter(([, result]) => result === 'pending').map(([check]) => check));
      if (name !== undefined) checks.set(name, chance(sim.random, 0.9) ? 'green' : 'red');
    }),
  },
  {
    name: 'a check reruns',
    weight: 0.3,
    run: outside(rerunOne),
  },
  {
    name: 'a counted check that GitHub does not require reruns while the merge is owed',
    weight: 3,
    run: outside((sim, pull) => {
      if (mergeOwed(sim, pull)) rerun(sim.world, headOf(sim.world, pull), checkNames.counted);
    }),
  },
  {
    name: 'a reviewer submits a review',
    weight: 1.5,
    run: outside((sim, pull) => {
      if (pull.draft) return;
      sim.world.serial += 1;
      const reviewer = pick(sim.random, ['ada', 'bot', 'grace']) ?? 'ada';
      const state = chance(sim.random, 0.85) ? 'APPROVED' : 'CHANGES_REQUESTED';
      pull.reviews.push({ id: `PRR_${String(sim.world.serial)}`, reviewer, state, at: sim.world.time, body: `${reviewer} says ${state}.` });
    }),
  },
  {
    name: 'a ruleset blocks the merge',
    weight: 0.3,
    run: outside((_sim, pull) => {
      pull.ruleBlocks = true;
    }),
  },
  {
    name: 'the ruleset stops blocking the merge',
    weight: 1.5,
    run: outside((_sim, pull) => {
      pull.ruleBlocks = false;
    }),
  },
  {
    name: 'someone opens another pull request from the head branch while the merge is owed',
    weight: 0.3,
    run: outside((sim, pull) => {
      if (mergeOwed(sim, pull)) openPullRequest(sim.world, pull.branch, 'release', 'Opened by someone else.', false);
    }),
  },
  {
    name: 'the base branch conflicts',
    weight: 0.3,
    run: outside((_sim, pull) => {
      pull.conflict = true;
    }),
  },
  {
    name: 'the base branch moves ahead',
    weight: 0.3,
    run: outside((sim, pull) => {
      sim.world.branches.set(base, commitOn(sim.world, [sim.world.branches.get(base) ?? '']));
      pull.behind = true;
    }),
  },
  {
    name: 'GitHub computes mergeability',
    weight: 2,
    run: outside((_sim, pull) => {
      pull.mergeabilityKnown = true;
    }),
  },
  {
    name: 'the merge queue merges',
    weight: 2,
    run: outside((sim, pull) => {
      const queued = pull.queued;
      if (queued === null) return;
      const checks = checksAt(sim.world, queued.head);
      if (checks.get(checkNames.required) === 'green' && !pull.conflict) mergeNow(sim.world, pull, queued.head, 'queue');
      else eject(sim.world, pull, 'The required check failed in the merge queue.');
    }),
  },
  {
    name: 'the merge queue ejects',
    weight: 0.3,
    run: outside((sim, pull) => {
      eject(sim.world, pull, 'The merge group failed.');
    }),
  },
];

const totalWeight = moves.reduce((sum, move) => sum + move.weight, 0);

function chooseMove(random: () => number): Move {
  let left = random() * totalWeight;
  for (const move of moves) {
    left -= move.weight;
    if (left < 0) return move;
  }
  return moves[0] ?? { name: 'nothing', weight: 0, run: () => [] };
}

function effects(sim: Sim): readonly Observation[] {
  const { world } = sim;
  const found: Observation[] = [];
  for (const merge of world.merges.slice(sim.seenMerges)) {
    const task = sim.tasks.find(entry => entry.pull === merge.number);
    const checks = checksAt(world, merge.head);
    const countedGreen = [checkNames.required, checkNames.counted].every(name => checks.get(name) === 'green');
    found.push({ kind: 'merged', head: merge.head, judged: sim.judged.has(merge.head), countedGreen, taskStep: task?.step ?? 'none', how: merge.how });
  }
  for (const enqueue of world.enqueues.slice(sim.seenEnqueues)) {
    const task = sim.tasks.find(entry => entry.pull === enqueue.number);
    const answered = task?.answered.ejection ?? null;
    found.push({ kind: 'enqueued', head: enqueue.head, unansweredEjection: enqueue.lastEjection === null || enqueue.lastEjection === answered ? null : enqueue.lastEjection });
  }
  sim.seenMerges = world.merges.length;
  sim.seenEnqueues = world.enqueues.length;
  return found;
}

function simOf(seed: number, mutant: Mutant): Sim {
  const random = seeded(seed);
  const world = newWorld({ queue: false, requireReviews: false, strict: false });
  const rows: Row[] = [];
  const fault = { lost: false, count: 0 };
  const faults: Faults = {
    loseReply: () => {
      if (!chance(random, 0.1)) return false;
      fault.lost = true;
      fault.count += 1;
      return true;
    },
    rewrite: mutant.rewrite,
    racePush: () => chance(random, 0.1),
  };
  const client = githubClient({ token: 'simulated', baseUrl: 'https://github.invalid', pageSize: 2, fetch: fakeFetch(world, faults) });
  return {
    world,
    random,
    client,
    performers: githubPerformers({ clientFor: () => Promise.resolve(client), mergeRowOf: row => Promise.resolve(owedMerge(rows.find(entry => entry.id === row))) }, mutant.merge),
    ranks: mutant.ranks,
    tasks: [],
    rows,
    judged: new Set(),
    values: new Set(),
    fault,
    reads: 0,
    seenMerges: 0,
    seenEnqueues: 0,
  };
}

const unmutated: Mutant = { breaks: 'LandSettles', ranks: ranking, rewrite: keep, merge: mergeGuarded };

async function runSeed(seed: number, plan: Plan): Promise<Run> {
  const sim = simOf(seed, plan.mutant === undefined ? unmutated : mutants[plan.mutant]);
  let failure: Failure | undefined;
  for (let step = 1; step <= plan.steps && failure === undefined; step += 1) {
    sim.world.time = step;
    if (active(sim) === undefined) startTask(sim);
    const move = chooseMove(sim.random);
    const observations = [...(await move.run(sim)), ...effects(sim)];
    const broken = observations.flatMap(judge);
    if (broken.length > 0) failure = { step, move: move.name, broken };
  }
  return { seed, plan, failure, merged: sim.world.merges.length, settled: sim.tasks.filter(task => settledSteps.has(task.step)).length, reads: sim.reads, lostReplies: sim.fault.count, values: sim.values };
}

export async function simulate(plans: readonly Plan[]): Promise<readonly Run[]> {
  const runs: Run[] = [];
  for (const plan of plans) for (const seed of plan.seeds) runs.push(await runSeed(seed, plan));
  return runs;
}

