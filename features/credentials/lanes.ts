import { randomUUID } from 'node:crypto';
import { connect, type Database } from '../../shared/db/client.ts';
import { neverStops } from '../../shared/loop.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { checkLoop, loginForJob, triesInWindow, type CheckLoopSettings } from './check-loop.ts';
import type { Checked } from './kinds.ts';
import { replace, writeBack } from './store.ts';
import { epoch, fakeLogin, fakeRefreshToken, newKey } from './world.ts';

type Lane = { readonly db: Database; readonly owner: string; readonly settings: (verdicts: () => Checked) => CheckLoopSettings; readonly at: (ms: number) => Date };

const minute = 60_000;

const hour = 60 * minute;

const jobLimitMs = 4 * hour;

async function inLane(postgres: TestPostgres, expiresInMs: number, work: (lane: Lane) => Promise<Check>): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const key = newKey(1);
  let time = epoch;
  try {
    const { id: owner } = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada', kind: 'person' }).returning('id').executeTakeFirstOrThrow();
    const login = fakeLogin(new Date(epoch + expiresInMs), fakeRefreshToken()).text;
    const stored = await replace(db, key, { action: randomUUID(), by: owner, at: new Date(epoch), owner, secret: { connector: 'codex', login, madeForAutoWorker: true } });
    if ('refused' in stored) throw new Error(stored.reason);
    const settings = (verdicts: () => Checked): CheckLoopSettings => ({
      everyMs: minute,
      leaseMs: 5 * minute,
      key,
      checks: {
        codex: { rotates: () => true, run: () => Promise.resolve(verdicts()) },
        github: { rotates: () => false, run: () => Promise.resolve(verdicts()) },
        jira: { rotates: () => false, run: () => Promise.resolve(verdicts()) },
      },
      checker: 'lane',
      now: () => new Date(time),
      writeBack,
    });
    const at = (ms: number): Date => {
      time = epoch + ms;
      return new Date(time);
    };
    return await work({ db, owner, settings, at });
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const apiError: Checked = { verdict: 'unknown', cause: 'Codex exited with code 1: the API answered 503', expiresAt: null, refresh: { kind: 'unused' } };

const passes = 6;

function unknownIsRetried(postgres: TestPostgres): Promise<Check> {
  return inLane(postgres, 4 * minute, async ({ db, settings, at }) => {
    const loop = checkLoop(settings(() => apiError));
    for (let index = 0; index < passes; index += 1) await loop.pass(db, { now: at(index * minute), late: () => false, stop: neverStops });
    const runs = await db.selectFrom('credential_check').select('outcome').execute();
    const name = `an unknown verdict inside the refresh window is retried, at most ${String(triesInWindow)} times`;
    const detail = `${String(passes)} passes a minute apart, starting 4 minutes before the login expires, ran ${String(runs.length)} checks: ${runs.map(run => run.outcome ?? 'live').join(', ')}`;
    return runs.length === triesInWindow ? pass(name, detail) : fail(name, detail);
  });
}

function shortLoginRefused(postgres: TestPostgres): Promise<Check> {
  return inLane(postgres, hour, async ({ db, owner, settings }) => {
    const given = await loginForJob(db, settings(() => ({ verdict: 'valid', cause: 'ack', expiresAt: null, refresh: { kind: 'unused' } })), owner, jobLimitMs);
    const name = 'loginForJob refuses a login that expires before the Job could reach its time limit, and says so';
    const said = 'refused' in given ? `${given.refused}: ${given.reason}` : `gave a login that expires at ${given.expiresAt.toISOString()}`;
    return 'refused' in given && given.refused === 'expires-too-soon' ? pass(name, said) : fail(name, said);
  });
}

function longLoginGiven(postgres: TestPostgres): Promise<Check> {
  return inLane(postgres, 5 * hour, async ({ db, owner, settings }) => {
    const given = await loginForJob(db, settings(() => ({ verdict: 'valid', cause: 'ack', expiresAt: null, refresh: { kind: 'unused' } })), owner, jobLimitMs);
    const name = 'loginForJob checks and gives a login that outlasts the Job time limit';
    return 'login' in given ? pass(name, `gave an access-only login that expires at ${given.expiresAt.toISOString()}`) : fail(name, `${given.refused}: ${given.reason}`);
  });
}

export async function laneChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  return [await unknownIsRetried(postgres), await shortLoginRefused(postgres), await longLoginGiven(postgres)];
}
