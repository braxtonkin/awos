import { review } from '../../shared/review.ts';
import type { Database } from '../../shared/db/client.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import type { GitHub } from './github.ts';
import { checksPass, favicon, forbidden, stillWrongSign, untouchable, type RehearsalName } from './solutions.ts';

export type Reworked = { readonly db: Database; readonly ticket: string; readonly github: GitHub; readonly branch: string };

type Fact = { readonly holds: boolean; readonly said: string };

type Attempt = { readonly id: string; readonly step: string; readonly verdict: string | null; readonly output: unknown; readonly pushed: string | null; readonly prompt: string };

const conflictSentBack = 'the pull request conflicts with its base branch';

export const reworkCheckNames: Readonly<Record<RehearsalName, string>> = {
  'red-check': 'red check fixed from its log',
  'still-wrong': 'behavior fixed from its evidence',
  'ticket-conflict': 'rework asked about the ticket',
  'pushes-nothing': 'rework ended once',
  'stays-red': 'checks stayed red three times',
};

const checksFailedThrice = 'Retry starts again at Implement, because checks on the pull request failed three times.';

function factsCheck(name: string, facts: readonly Fact[]): Check {
  const detail = facts.map(fact => fact.said).join('; ');
  return facts.every(fact => fact.holds) ? pass(name, detail) : fail(name, detail);
}

async function attemptsOf(db: Database, ticket: string): Promise<readonly Attempt[]> {
  const rows = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .leftJoin('attempt_command', join => join.onRef('attempt_command.attempt_id', '=', 'attempt.id').on('attempt_command.kind', '=', 'turn.start'))
    .select(['attempt.id', 'attempt.step', 'attempt.verdict', 'attempt.output', 'attempt.last_pushed', 'attempt_command.input'])
    .where('task.key', '=', ticket)
    .orderBy('attempt.id')
    .execute();
  return rows.map(row => ({ id: row.id, step: row.step, verdict: row.verdict, output: row.output, pushed: row.last_pushed, prompt: row.input ?? '' }));
}

const listed = (attempts: readonly Attempt[]): string => attempts.map(attempt => `${attempt.id} ${attempt.step} ${attempt.verdict ?? 'live'}`).join(', ') || 'none';

const after = (attempts: readonly Attempt[], sender: Attempt): readonly Attempt[] => attempts.filter(attempt => attempt.step === 'implement' && Number(attempt.id) > Number(sender.id));

const sentBackForRed = (attempt: Attempt): boolean => attempt.step === 'land' && attempt.verdict === 'red_check' && !JSON.stringify(attempt.output).includes(conflictSentBack);

const redSendBack = (attempts: readonly Attempt[]): Attempt | undefined => attempts.find(sentBackForRed);

const stillWrong = (attempts: readonly Attempt[]): Attempt | undefined => attempts.find(attempt => attempt.step === 'verify' && attempt.verdict === 'behavior_fail');

async function taskOf(db: Database, ticket: string) {
  return db.selectFrom('task').select(['task.state', 'task.step', 'task.waiting_on', 'task.waiting_reason', 'task.review_attempt']).where('task.key', '=', ticket).executeTakeFirst();
}

async function redCheckFixed({ db, ticket, github, branch }: Reworked): Promise<Check> {
  const name = reworkCheckNames['red-check'];
  const attempts = await attemptsOf(db, ticket);
  const land = redSendBack(attempts);
  if (land === undefined) return factsCheck(name, [{ holds: false, said: `no Land attempt sent the task back for a red check; attempts: ${listed(attempts)}` }]);
  const rework = after(attempts, land)[0];
  if (rework === undefined) return factsCheck(name, [{ holds: false, said: `no Implement attempt followed Land attempt ${land.id}` }]);
  const told = ['`sandbox`', 'Run npm test', 'favicon.ico'].filter(part => !rework.prompt.includes(part));
  const task = await taskOf(db, ticket);
  const head = await github.branchHead(branch);
  const held = head === undefined ? false : (await github.blobs((await github.commit(head)).tree)).has(favicon);
  return factsCheck(name, [
    { holds: true, said: `Land attempt ${land.id} sent the task back for a red check` },
    { holds: told.length === 0, said: `Implement attempt ${rework.id}'s prompt ${told.length === 0 ? 'names the check `sandbox`, its failing step Run npm test, and the log line about favicon.ico' : `lacks ${told.join(', ')}`}` },
    { holds: rework.verdict === 'pass' && rework.pushed !== null, said: `Implement attempt ${rework.id} ended ${rework.verdict ?? 'live'} and pushed ${rework.pushed ?? 'nothing'}` },
    { holds: task?.state === 'done', said: `the task is ${task?.state ?? 'missing'}` },
    { holds: held, said: `${branch} ${held ? 'holds' : 'lacks'} ${favicon}` },
  ]);
}

async function behaviorFixed({ db, ticket }: Reworked): Promise<Check> {
  const name = reworkCheckNames['still-wrong'];
  const attempts = await attemptsOf(db, ticket);
  const verify = stillWrong(attempts);
  if (verify === undefined) return factsCheck(name, [{ holds: false, said: `no Verify attempt found the behavior still wrong; attempts: ${listed(attempts)}` }]);
  const rework = after(attempts, verify)[0];
  if (rework === undefined) return factsCheck(name, [{ holds: false, said: `no Implement attempt followed Verify attempt ${verify.id}` }]);
  const task = await taskOf(db, ticket);
  return factsCheck(name, [
    { holds: true, said: `Verify attempt ${verify.id} found the behavior still wrong` },
    { holds: rework.prompt.includes(stillWrongSign), said: `Implement attempt ${rework.id}'s prompt ${rework.prompt.includes(stillWrongSign) ? 'holds' : 'lacks'} Verify's failing assertion` },
    { holds: rework.verdict === 'pass', said: `Implement attempt ${rework.id} ended ${rework.verdict ?? 'live'}` },
    { holds: task?.state === 'done', said: `the task is ${task?.state ?? 'missing'}` },
  ]);
}

const questionOf = (output: unknown): string => {
  const parsed = review.safeParse(output);
  return parsed.success ? parsed.data.blocks.flatMap(block => (block.kind === 'choice' ? [block.question] : [])).join(' ') : '';
};

async function askedAboutTicket({ db, ticket }: Reworked): Promise<Check> {
  const name = reworkCheckNames['ticket-conflict'];
  const attempts = await attemptsOf(db, ticket);
  const verify = stillWrong(attempts);
  if (verify === undefined) return factsCheck(name, [{ holds: false, said: `no Verify attempt found the behavior still wrong; attempts: ${listed(attempts)}` }]);
  const reworks = after(attempts, verify);
  const asked = reworks[0];
  const question = asked === undefined ? '' : questionOf(asked.output);
  const task = await taskOf(db, ticket);
  return factsCheck(name, [
    { holds: true, said: `Verify attempt ${verify.id} found the behavior still wrong` },
    { holds: reworks.length === 1 && asked?.verdict === 'needs_input', said: `Implement attempts after it: ${listed(reworks)}` },
    { holds: question.includes(untouchable) && question.includes(forbidden), said: question === '' ? 'the rework asked no question' : `the rework asked: ${question}` },
    {
      holds: task?.state === 'waiting' && task.waiting_on === 'answer' && task.review_attempt === asked?.id,
      said: `the task is ${task?.state ?? 'missing'} on ${task?.waiting_on ?? 'nothing'} with review ${task?.review_attempt ?? 'none'}`,
    },
  ]);
}

async function endedOnce({ db, ticket }: Reworked): Promise<Check> {
  const name = reworkCheckNames['pushes-nothing'];
  const attempts = await attemptsOf(db, ticket);
  const land = redSendBack(attempts);
  if (land === undefined) return factsCheck(name, [{ holds: false, said: `no Land attempt sent the task back for a red check; attempts: ${listed(attempts)}` }]);
  const reworks = after(attempts, land);
  const task = await taskOf(db, ticket);
  const reason = task?.waiting_reason ?? '';
  const quoted = reason.includes(checksPass.slice(0, 30));
  return factsCheck(name, [
    { holds: true, said: `Land attempt ${land.id} sent the task back for a red check` },
    { holds: reworks.length === 1 && reworks[0]?.verdict === 'fail' && reworks[0].pushed === null, said: `Implement attempts after it: ${listed(reworks)}` },
    { holds: task?.state === 'waiting' && task.waiting_on === 'retry' && task.step === 'implement', said: `the task is ${task?.state ?? 'missing'} on ${task?.waiting_on ?? 'nothing'} at ${task?.step ?? 'no step'}` },
    { holds: reason.includes('`sandbox`') && quoted, said: `the waiting reason ${reason.includes('`sandbox`') ? 'names the check `sandbox`' : 'does not name the check'} and ${quoted ? 'quotes' : 'does not quote'} the agent: ${reason}` },
  ]);
}

async function stayedRed({ db, ticket }: Reworked): Promise<Check> {
  const name = reworkCheckNames['stays-red'];
  const attempts = await attemptsOf(db, ticket);
  const red = attempts.filter(sentBackForRed);
  const task = await taskOf(db, ticket);
  const reason = task?.waiting_reason ?? '';
  return factsCheck(name, [
    { holds: red.length === 3, said: `Land sent the task back for a red check ${String(red.length)} times: ${listed(red)}` },
    { holds: task?.state === 'waiting' && task.waiting_on === 'retry' && task.step === 'land', said: `the task is ${task?.state ?? 'missing'} on ${task?.waiting_on ?? 'nothing'} at ${task?.step ?? 'no step'}` },
    { holds: reason.startsWith(checksFailedThrice), said: `the waiting reason is: ${reason || 'none'}` },
  ]);
}

export const reworkChecks: Readonly<Record<RehearsalName, (reworked: Reworked) => Promise<Check>>> = {
  'red-check': redCheckFixed,
  'still-wrong': behaviorFixed,
  'ticket-conflict': askedAboutTicket,
  'pushes-nothing': endedOnce,
  'stays-red': stayedRed,
};
