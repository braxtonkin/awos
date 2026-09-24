import { asInfo, fail, isCheck, pass, type Check, type Line } from '../../tools/verify/check.ts';
import { teamAccount, type Fault, type RunAs } from './autoworker.ts';
import type { Inspect } from './harness.ts';

const nobodyToRunAs = 'Nobody to run this task as.';

const noAssigneeInspect: Inspect = async ({ database, clean, ticket }) => {
  const task = await database.selectFrom('task').select(['id', 'state', 'waiting_reason']).where('key', '=', ticket).executeTakeFirst();
  const attempts = task === undefined ? 0 : (await database.selectFrom('attempt').select('id').where('task_id', '=', task.id).execute()).length;
  const jobs = (await clean.cluster.batch.listNamespacedJob({ namespace: clean.cluster.namespace })).items.length;
  return [
    task?.state === 'waiting' && (task.waiting_reason ?? '').startsWith(nobodyToRunAs)
      ? pass('lane 4: the task waits with the decided note', task.waiting_reason ?? '')
      : fail('lane 4: the task waits with the decided note', task === undefined ? 'no task row' : `state ${task.state}, note ${task.waiting_reason ?? 'none'}`),
    attempts === 0 ? pass('lane 4: no attempt row exists', '0 attempts') : fail('lane 4: no attempt row exists', `${String(attempts)} attempts`),
    jobs === 0 ? pass('lane 4: no Job starts', `0 Jobs in ${clean.cluster.namespace}`) : fail('lane 4: no Job starts', `${String(jobs)} Jobs in ${clean.cluster.namespace}`),
  ];
};

export type Lane = {
  readonly number: number;
  readonly slug: string;
  readonly procedure: string;
  readonly runs: number;
  readonly fault: Fault | undefined;
  readonly runAs: RunAs;
  readonly assigned: boolean;
  readonly timeoutSeconds: number;
  readonly inspect: Inspect | undefined;
  readonly decidedBy: (name: string) => boolean;
  readonly before: string | undefined;
};

const everyCheck = (): boolean => true;

type Deciders = { readonly exactly: readonly string[]; readonly counted?: readonly string[] };

const named =
  ({ exactly, counted = [] }: Deciders) =>
  (name: string): boolean =>
    exactly.includes(name) || counted.some(prefix => name.startsWith(`${prefix} `));

const run = { runs: 1, fault: undefined, runAs: 'assignee', assigned: true, timeoutSeconds: 2700, inspect: undefined, before: undefined } as const;

export const lanes: readonly Lane[] = [
  {
    ...run,
    number: 1,
    slug: 'regression',
    runs: 3,
    procedure: 'Run one AutoWorker run at the base, which has no clean step, then three runs in a row at head. Pass when the base run reaches merged and all three head runs reach clean within 45 minutes each.',
    decidedBy: everyCheck,
    before: 'At the base commit 17df340: docker compose run --rm live npm run verify -- e2e --driver autoworker',
  },
  {
    ...run,
    number: 2,
    slug: 'engine-restart',
    fault: 'engine-restart',
    procedure: 'Kill the engine at the first stored event of Implement, wait 10 s, and start it again. Pass when the attempt continues, its events have no gap or duplicate, one pull request exists, and no Jira comment repeats.',
    decidedBy: named({ exactly: ['engine restarted', 'attempt continued', 'clean'], counted: ['pull requests', 'duplicate comments'] }),
  },
  {
    ...run,
    number: 3,
    slug: 'lost-job',
    fault: 'lost-job',
    procedure: "Delete the Implement attempt's pod mid-step. Pass when the reaper marks the attempt lost, the next attempt starts in a fresh pod with the lost attempt's summary in its prompt, the run reaches clean, and one pull request exists.",
    decidedBy: named({ exactly: ['pod deleted mid-step', 'lost attempt replaced', 'clean'], counted: ['pull requests'] }),
  },
  {
    ...run,
    number: 4,
    slug: 'no-assignee',
    assigned: false,
    timeoutSeconds: 300,
    inspect: noAssigneeInspect,
    procedure: 'File the ticket with no assignee. Pass when the claim is refused, the task waits with the decided note, no attempt row exists, and no Job starts.',
    decidedBy: named({ exactly: ['ticket filed', 'task recorded'], counted: ['lane 4:'] }),
  },
  {
    ...run,
    number: 5,
    slug: 'run-as',
    runAs: 'team',
    assigned: false,
    procedure: "Give the routine a team account to run as, holding the owner's logins, and leave the ticket unassigned. Pass when the first attempt records the team account as its run-as identity and its Job starts.",
    decidedBy: named({ exactly: ['ticket filed', 'task recorded', 'plan posted', `record: every attempt ran as ${teamAccount}`] }),
  },
  {
    ...run,
    number: 6,
    slug: 'verify',
    procedure: "Read the Verify attempt's environment row and evidence. Pass when the tests-only environment started and stopped once, and the evidence holds the reproduction script and its two runs, failing first and passing second.",
    decidedBy: named({ exactly: ['record: each Verify attempt started and stopped its environment once', 'record: Verify evidence holds the reproduction script and its two runs, failing first and passing second'] }),
  },
  {
    ...run,
    number: 7,
    slug: 'report',
    procedure: "Read the run's report comment back from Jira. Pass when it holds a timeline with each step's duration, input tokens per step, and links to the ticket, the pull request, the merge commit, and both CI runs.",
    decidedBy: named({ exactly: ['report posted', 'the report comment reads back from Jira with its timeline, input tokens per step, and every link'] }),
  },
  {
    ...run,
    number: 8,
    slug: 'replay',
    procedure: "Replay each finished attempt's stored events through shared/items.ts. Pass when the replayed items match the finished items stored during the run, one for one.",
    decidedBy: named({ exactly: ['record: replay through shared/items.ts matches the stored finished items one for one', 'clean'] }),
  },
  {
    ...run,
    number: 9,
    slug: 'clean-negative',
    procedure: 'After a passing run, plant a Secret labeled for a finished attempt and rerun the clean check. Pass when the check fails and names the Secret.',
    decidedBy: named({ exactly: ['clean', 'the clean check fails on a planted Secret and names it'] }),
  },
];

export const allCommands = ['npm run check', 'npm run verify -- guardrails', 'npm run verify -- models', 'npm test'] as const;

export const laneTen = `Lane 10 runs ${allCommands.join(', ')} at head in the verify service, and passes when each exits 0.`;

const decides = (lane: Lane, line: Line): boolean => lane.decidedBy(line.name.replace(/^run \d+: /, ''));

const deciding = (line: Line): Check => (isCheck(line) ? line : fail(line.name, `${line.observed}: ${line.detail}, and this lane expects it`));

export function laneLines(lane: Lane, lines: readonly Line[]): readonly Line[] {
  const decided = lines.filter(line => decides(lane, line)).map(deciding);
  const passed = decided.filter(check => check.passed).length;
  const name = `lane ${String(lane.number)} ${lane.slug}: ${String(passed)} of ${String(decided.length)} deciding checks passed`;
  const summary = decided.length > 0 && passed === decided.length ? pass(name, '') : fail(name, decided.filter(check => !check.passed).map(check => check.name).join('; ') || 'no check decides this lane');
  return [...lines.filter(line => !decides(lane, line)).map(line => (isCheck(line) ? asInfo(line) : line)), ...decided, summary];
}
