import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { address } from '../../features/tasks/advance.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { answerOf, answerWithin, message, request, type Asked, type RequestAnswer } from '../../shared/requests.ts';
import { answer, note } from '../../shared/review.ts';

const settings = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });

const usage = [
  'Usage: node services/engine/act.ts <action> <task key or routine name> --as <email> [options], with DATABASE_URL set.',
  '  Pass --id <uuid> to make a rerun record nothing new. It exits 3 when the engine has not answered within 10 s.',
  '  approve <key> --step <step> --as <email>',
  '  send-back <key> --step <step> --note <text> --as <email>',
  '  answer <key> --step <step> --answer <json> --as <email>',
  '  stop <key> --as <email>',
  '  retry <key> [--note <text>] --as <email>',
  '  steer <key> --message <text> --as <email>',
  '  pause <routine> --as <email>',
  '  resume <routine> --as <email>',
  '  run-now <routine> --as <email>',
].join('\n');

const onTask = ['approve', 'send-back', 'answer', 'stop', 'retry', 'steer'] as const;

const onRoutine = ['pause', 'resume', 'run-now'] as const;

const needsStep: readonly string[] = ['approve', 'send-back', 'answer'];

type Action = (typeof onTask)[number] | (typeof onRoutine)[number];

const isRoutineAction = (kind: Action): kind is (typeof onRoutine)[number] => onRoutine.some(action => action === kind);

const waitingExitCode = 3;

const answerWaitMs = 10_000;

const command = z
  .object({
    positionals: z.tuple([z.enum([...onTask, ...onRoutine]), z.string().min(1)]),
    values: z.object({
      as: z.email(),
      id: z.uuid().optional(),
      step: z.string().min(1).optional(),
      note: note.optional(),
      message: message.optional(),
      answer: z
        .string()
        .transform((text, context) => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            context.addIssue({ code: 'custom', message: '--answer must be JSON' });
            return z.NEVER;
          }
        })
        .pipe(answer)
        .optional(),
    }),
  })
  .refine(({ positionals: [kind], values }) => !needsStep.includes(kind) || values.step !== undefined, {
    message: 'approve, send-back, and answer need --step, so an action never lands on a review its person did not name.',
  });

type Command = z.infer<typeof command>;

type Who = { readonly id: string; readonly person: string; readonly at: Date };

type Target = { readonly target: string; readonly person: string; readonly review: string | null };

async function routineNamed(db: Database, name: string, email: string): Promise<Target | string> {
  const routines = await db
    .selectFrom('routine_version as version')
    .select('version.routine_id')
    .where('version.name', '=', name)
    .where(eb => eb('version.version', '=', eb.selectFrom('routine_version as newest').select(inner => inner.fn.max('newest.version').as('version')).whereRef('newest.routine_id', '=', 'version.routine_id')))
    .orderBy('version.routine_id')
    .execute();
  const [found, ...more] = routines;
  if (found === undefined) return `No routine is named ${name}.`;
  if (more.length > 0) return `${String(routines.length)} routines are named ${name}, so act.ts cannot tell which one to act on.`;
  const person = await db.selectFrom('person').select('person.id').where('person.email', '=', email.toLowerCase()).executeTakeFirst();
  if (person === undefined) return `No person has the email ${email}.`;
  return { target: found.routine_id, person: person.id, review: null };
}

async function targetOf(db: Database, { positionals: [kind, name], values }: Command): Promise<Target | string> {
  if (isRoutineAction(kind)) return routineNamed(db, name, values.as);
  const found = await address(db, name, values.as, values.step ?? null);
  return typeof found === 'string' ? found : { target: found.task, person: found.person, review: found.review };
}

function askedOf({ positionals: [kind], values }: Command, found: Target, who: Who): Asked | string {
  const base = { ...who, target: found.target };
  if (kind === 'stop') return { ...base, kind: 'stop', payload: {} };
  if (kind === 'retry') return { ...base, kind: 'retry', payload: { note: values.note ?? null } };
  if (kind === 'steer') return values.message === undefined ? 'steer needs --message.' : { ...base, kind: 'steer', payload: { message: values.message } };
  if (kind === 'pause') return { ...base, kind: 'pause', payload: {} };
  if (kind === 'resume') return { ...base, kind: 'resume', payload: {} };
  if (kind === 'run-now') return { ...base, kind: 'run_now', payload: {} };
  const { review } = found;
  if (review === null) return 'The task waits on no review, so there is nothing to approve, send back, or answer.';
  if (kind === 'approve') return { ...base, kind: 'approve', payload: { review } };
  if (kind === 'send-back') return values.note === undefined ? 'send-back needs --note.' : { ...base, kind: 'send_back', payload: { review, note: values.note } };
  return values.answer === undefined ? 'answer needs --answer.' : { ...base, kind: 'answer', payload: { review, answer: values.answer } };
}

type Said = { readonly line: string; readonly waiting: boolean };

const reported = (reply: RequestAnswer | undefined, kind: Action, on: string, id: string): Said => {
  if (reply === undefined) throw new Error(`The request ${id} is gone.`);
  if (reply === 'waiting') return { line: `Sent ${kind} on ${on} as request ${id}. The engine has not answered yet. The request waits for it.`, waiting: true };
  if ('refused' in reply) throw new Error(`AutoWorker refused ${kind} on ${on}: ${reply.refused}`);
  return { line: `Recorded ${kind} on ${on} as action ${reply.recorded}.`, waiting: false };
};

async function run(given: Command): Promise<Said> {
  const env = settings.safeParse(process.env);
  if (!env.success) throw new Error(`DATABASE_URL must be a postgres:// URL. ${z.prettifyError(env.error)}`);
  const db = connect(env.data.DATABASE_URL, 1);
  try {
    const [kind, name] = given.positionals;
    const on = `${isRoutineAction(kind) ? 'routine' : 'task'} ${name}`;
    const { id } = given.values;
    if (id !== undefined && (await answerOf(db, id)) !== undefined) return reported(await answerWithin(db, id, answerWaitMs), kind, on, id);
    const found = await targetOf(db, given);
    if (typeof found === 'string') throw new Error(found);
    const asked = askedOf(given, found, { id: id ?? randomUUID(), person: found.person, at: new Date() });
    if (typeof asked === 'string') throw new Error(asked);
    const sent = await request(db, asked);
    if ('refused' in sent) throw new Error(`AutoWorker refused ${kind} on ${on}: another request already has the id ${asked.id}.`);
    return reported(await answerWithin(db, asked.id, answerWaitMs), kind, on, asked.id);
  } finally {
    await db.destroy();
  }
}

const options = { as: { type: 'string' }, id: { type: 'string' }, step: { type: 'string' }, note: { type: 'string' }, message: { type: 'string' }, answer: { type: 'string' } } as const;

function argsOf(args: readonly string[]): unknown {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const given = argsOf(process.argv.slice(2));
const parsed = command.safeParse(given);
if (!parsed.success) {
  process.stderr.write(`${usage}\n${typeof given === 'string' ? given : z.prettifyError(parsed.error)}\n`);
  process.exitCode = 2;
} else {
  await run(parsed.data).then(
    ({ line, waiting }) => {
      process.stdout.write(`${line}\n`);
      if (waiting) process.exitCode = waitingExitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
