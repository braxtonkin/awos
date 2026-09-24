import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { act, address, note, type PersonAction } from '../../features/tasks/advance.ts';
import { connect } from '../../shared/db/client.ts';
import { answer } from '../../shared/review.ts';
import { workflows } from './workflows.ts';

const settings = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });

const usage = [
  'Usage: node services/engine/act.ts <action> <task key> --as <email> [options], with DATABASE_URL set.',
  '  Pass --id <uuid> to make a rerun record nothing new.',
  '  approve <key> --step <step> --as <email>',
  '  send-back <key> --step <step> --note <text> --as <email>',
  '  answer <key> --step <step> --answer <json> --as <email>',
  '  stop <key> --as <email>',
  '  retry <key> [--note <text>] --as <email>',
].join('\n');

const command = z.object({
  positionals: z.tuple([z.enum(['approve', 'send-back', 'answer', 'stop', 'retry']), z.string().min(1)]),
  values: z.object({
    as: z.email(),
    id: z.uuid().optional(),
    step: z.string().min(1).optional(),
    note: note.optional(),
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
}).refine(({ positionals: [kind], values }) => kind === 'stop' || kind === 'retry' || values.step !== undefined, { message: 'approve, send-back, and answer need --step, so an action never lands on a review its person did not name.' });

type Command = z.infer<typeof command>;

function actionOf({ positionals: [kind], values }: Command, review: string | null): PersonAction | string {
  if (kind === 'stop') return { kind: 'stop' };
  if (kind === 'retry') return { kind: 'retry', note: values.note ?? null };
  if (review === null) return 'The task waits on no review, so there is nothing to approve, send back, or answer.';
  if (kind === 'approve') return { kind: 'approve', review };
  if (kind === 'send-back') return values.note === undefined ? 'send-back needs --note.' : { kind: 'send_back', review, note: values.note };
  return values.answer === undefined ? 'answer needs --answer.' : { kind: 'answer', review, answer: values.answer };
}

async function run(given: Command): Promise<string> {
  const env = settings.safeParse(process.env);
  if (!env.success) throw new Error(`DATABASE_URL must be a postgres:// URL. ${z.prettifyError(env.error)}`);
  const db = connect(env.data.DATABASE_URL, 1);
  try {
    const [kind, key] = given.positionals;
    const found = await address(db, key, given.values.as, given.values.step ?? null);
    if (typeof found === 'string') throw new Error(found);
    const action = actionOf(given, found.review);
    if (typeof action === 'string') throw new Error(action);
    const id = given.values.id ?? randomUUID();
    const acted = await act(db, workflows, found.task, { id, person: found.person, at: new Date() }, action);
    if ('refused' in acted) throw new Error(`AutoWorker refused ${kind} on task ${key}: ${acted.refused}.`);
    return `Recorded ${kind} on task ${key} as action ${acted.recorded}.`;
  } finally {
    await db.destroy();
  }
}

const options = { as: { type: 'string' }, id: { type: 'string' }, step: { type: 'string' }, note: { type: 'string' }, answer: { type: 'string' } } as const;

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
    line => {
      process.stdout.write(`${line}\n`);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
