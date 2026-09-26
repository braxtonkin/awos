import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { Database } from '../../shared/db/client.ts';
import { reduce } from '../../shared/items.ts';
import { answerWithin, request } from '../../shared/requests.ts';
import { day } from '../../shared/ui/clock.ts';
import { open, recording, run, shoot, type Script } from '../../tools/verify/browser.ts';
import { fail, info, pass, type Line } from '../../tools/verify/check.ts';
import type { Lane, World } from '../../tools/verify/dashboard.ts';
import { actingPerson } from '../../tools/verify/screens/screens.ts';
import { keyOf, percentile, until, view, withDatabase } from './lanes.ts';

const unit = 'u7';
const box = 'textarea[name="message"]';
const sendButton = '[data-message="send"]';
const noteBox = 'textarea[name="note"]';
const retryButton = '[data-retry="send"]';
const stopSentence = 'Stopping keeps the work already pushed.';
const notRunning = 'The agent is not running, so it cannot read a message. Retry with a note instead.';
const starting = 'The agent is still starting, so it cannot read a message yet. Send it again in a moment.';
const stamp = /^Sent \d\d:\d\d · Received \d\d:\d\d · Acted on \d\d:\d\d$/;
const pinnedModel = 'gpt-6-luna';
const standInReply = 'Acting on your message';
const attemptStartMs = 240_000;

const bubble = (id: string): string => `[data-request="${id}"]`;

const check = (passed: boolean, name: string, detail: string): Line => (passed ? pass : fail)(name, detail);

const deliveredOf = async (page: Page, id: string): Promise<string | undefined> => (await page.locator(bubble(id)).count()) === 0 ? undefined : ((await page.locator(bubble(id)).first().getAttribute('data-delivery')) ?? undefined);

const reaches = (page: Page, id: string, state: string) => async (): Promise<true | undefined> => ((await deliveredOf(page, id)) === state ? true : undefined);

const lineOf = async (page: Page, id: string): Promise<string> => (await page.locator(`${bubble(id)} [data-delivered]`).first().textContent()) ?? '';

async function saved(page: Page, shots: string, name: string): Promise<string> {
  await mkdir(shots, { recursive: true });
  const path = join(shots, name);
  await shoot(page, path);
  return path;
}

const personId = async (db: Database, name: string): Promise<string> => (await db.selectFrom('person').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id;

const taskOf = async (db: Database, key: string): Promise<string> => (await db.selectFrom('task').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id;

const newestRequest = async (db: Database, key: string, kind: string): Promise<string | undefined> =>
  (
    await db
      .selectFrom('person_request')
      .innerJoin('task', 'task.id', 'person_request.task_id')
      .select('person_request.id')
      .where('task.key', '=', key)
      .where('person_request.kind', '=', kind)
      .orderBy('person_request.position', 'desc')
      .executeTakeFirst()
  )?.id;

const startInputAfter = async (db: Database, key: string, after: Date): Promise<{ readonly step: string; readonly input: string } | undefined> => {
  const row = await db
    .selectFrom('attempt_command')
    .innerJoin('attempt', 'attempt.id', 'attempt_command.attempt_id')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.step', 'attempt_command.input'])
    .where('task.key', '=', key)
    .where('attempt_command.kind', '=', 'turn.start')
    .where('attempt.started_at', '>=', after)
    .orderBy('attempt.id')
    .executeTakeFirst();
  return row === undefined ? undefined : { step: row.step, input: row.input ?? '' };
};

const requestsShown = async (page: Page): Promise<readonly string[]> => Promise.all((await page.locator('[data-msg="person"][data-request]').all()).map(async element => (await element.getAttribute('data-request')) ?? ''));

async function sendFromBox(page: Page, message: string): Promise<string> {
  const before = new Set(await requestsShown(page));
  await page.locator(box).fill(message);
  await page.locator(sendButton).click();
  return until('the message to show as sent', async () => (await requestsShown(page)).find(each => !before.has(each)), 10_000);
}

const regression: Lane = {
  unit,
  id: '1',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        await page.locator('[data-live="true"]').waitFor();
        const now = await until('the what-now line to name an action', async () => {
          const text = (await page.locator('[data-now] p').first().textContent()) ?? '';
          return text.includes('·') ? text : undefined;
        });
        const sentence = (await page.locator('[aria-label="Agent"] form').first().textContent()) ?? '';
        await page.locator('[data-stop="button"]').click();
        await until('the Stop button to say Stopped', async () => ((await page.locator('[data-stop="said"]').textContent()) === 'Stopped' ? true : undefined));
        await wait(500);
        const path = await saved(page, shots, 'u7-regression.png');
        const task = await db.selectFrom('task').leftJoin('human_action', 'human_action.id', 'task.stopped_by').leftJoin('person', 'person.id', 'human_action.person_id').select(['task.state', 'person.name']).where('task.key', '=', key).executeTakeFirstOrThrow();
        const event = await page.locator('[data-action="stop"]').count();
        return [
          check(task.state === 'stopped' && task.name === actingPerson, 'Stop ends the task stopped with Braxton Kinney\'s action', `${task.state} by ${task.name ?? 'nobody'}`),
          check(now.length > 0, 'the panel shows what the agent is doing now', now),
          check(sentence.includes(stopSentence), "Stop sits in the panel with its sentence", sentence),
          check(event === 1, 'the transcript shows the stop as a person\'s action with its time', `${String(event)} stop rows`),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? path : errors.join('; ')),
        ];
      }),
    );
  },
};

const steer: Lane = {
  unit,
  id: '2',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    const message = 'Also check a 503.';
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        await page.locator('[data-live="true"]').waitFor();
        const id = await sendFromBox(page, message);
        const sent = await lineOf(page, id);
        await until('the steer to reach acted on', reaches(page, id, 'acted'), 60_000);
        const reply = await until("the agent's reply after the steer", async () => ((await page.locator(`${bubble(id)} ~ li`, { hasText: standInReply }).count()) > 0 ? true : undefined), 60_000).catch(() => false);
        await wait(500);
        const line = await lineOf(page, id);
        const path = await saved(page, shots, 'u7-steer.png');
        const action = await db.selectFrom('human_action').innerJoin('person', 'person.id', 'human_action.person_id').select(['human_action.kind', 'person.name']).where('human_action.id', '=', id).executeTakeFirst();
        return [
          check(/^Sent \d\d:\d\d/.test(sent), 'the steer shows as sent at once', sent),
          check(stamp.test(line), 'the steer shows sent, received, and acted on, each with a time', line),
          check(reply, "the agent's reply follows the steer", reply ? `a later item says ${standInReply}` : 'no reply followed'),
          check(action?.kind === 'steer_task' && action.name === actingPerson, 'the steer is a steer_task action that names Braxton Kinney', JSON.stringify(action ?? null)),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? path : errors.join('; ')),
        ];
      }),
    );
  },
};

const liveAfter = async (db: Database, key: string, after: Date): Promise<{ readonly id: string; readonly turned: boolean } | undefined> => {
  const found = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .leftJoin('attempt_command', join => join.onRef('attempt_command.attempt_id', '=', 'attempt.id').on('attempt_command.kind', '=', 'turn.start'))
    .select(['attempt.id', 'attempt_command.seq'])
    .where('task.key', '=', key)
    .where('attempt.finished_at', 'is', null)
    .where('attempt.started_at', '>=', after)
    .executeTakeFirst();
  return found === undefined ? undefined : { id: found.id, turned: found.seq !== null };
};

const windowTries = 5;

async function startingWindow(db: Database, key: string): Promise<readonly Line[]> {
  const name = 'a steer while the agent starts gets its own sentence';
  const person = await personId(db, actingPerson);
  const task = await taskOf(db, key);
  const missed: string[] = [];
  for (let tried = 1; tried <= windowTries; tried += 1) {
    const retried = new Date();
    await request(db, { id: randomUUID(), person, at: retried, kind: 'retry', target: task, payload: { note: null } });
    const deadline = Date.now() + attemptStartMs;
    let live = await liveAfter(db, key, retried);
    while (live === undefined && Date.now() < deadline) {
      await wait(5);
      live = await liveAfter(db, key, retried);
    }
    if (live === undefined) return [fail(name, 'Retry started no attempt')];
    const id = randomUUID();
    await request(db, { id, person, at: new Date(), kind: 'steer', target: task, payload: { message: 'Check the retry budget too.' } });
    const answer = await answerWithin(db, id, 30_000);
    const told = answer !== undefined && answer !== 'waiting' && 'refused' in answer ? answer.refused : JSON.stringify(answer ?? null);
    if (told === starting) return [pass(name, `${told} (try ${String(tried)})`)];
    if (told === notRunning) return [fail(name, `it got the not-running sentence: ${told}`)];
    missed.push(`try ${String(tried)}: ${live.turned ? 'the first turn was already numbered' : 'the first turn was numbered before the engine applied the steer'}, answered ${told}`);
    await request(db, { id: randomUUID(), person, at: new Date(), kind: 'stop', target: task, payload: {} });
    await until('the task to stop again', async () => ((await db.selectFrom('task').select('state').where('id', '=', task).executeTakeFirstOrThrow()).state === 'stopped' ? true : undefined));
  }
  return [info(name, 'n/a', `the window was missed ${String(windowTries)} times: ${missed.join('; ')}`)];
}

const steerLate: Lane = {
  unit,
  id: '3',
  seeds: ['running', 'stopped'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    const message = 'Please also check the error path.';
    return withDatabase(world, async db => {
      const late = await open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await page.locator('[data-live="true"]').waitFor();
        await page.locator(box).fill(message);
        await request(db, { id: randomUUID(), person: await personId(db, 'Priya Natarajan'), at: new Date(), kind: 'stop', target: await taskOf(db, key), payload: {} });
        await until('the page to show the task stopped', async () => ((await page.locator('[data-now="muted"]').count()) > 0 ? true : undefined));
        await page.locator(sendButton).click();
        const told = await until('the refusal under the box', async () => ((await page.locator('[data-message="refused"]').count()) > 0 ? ((await page.locator('[data-message="refused"]').textContent()) ?? undefined) : undefined));
        const kept = await page.locator(box).inputValue();
        const path = await saved(page, shots, 'u7-steer-late.png');
        return [
          check(told === notRunning, 'a steer after the attempt ended shows a plain refusal', told),
          check(kept === message, 'the text stays in the box', kept),
          check((await page.locator('[data-msg="person"][data-delivery]').count()) === 0, 'the refused steer adds no message to the transcript', path),
        ];
      });
      const stoppedKey = keyOf(world, 'stopped');
      const early = await startingWindow(db, stoppedKey);
      return [...late, ...early];
    });
  },
};

const question: Lane = {
  unit,
  id: '4',
  seeds: ['question'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'question');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        await page.locator('[data-question="open"]').waitFor();
        const radio = page.locator('[data-question="open"] input[type="radio"]').last();
        const option = (await radio.getAttribute('value')) ?? '';
        const answeredAt = new Date();
        await radio.check();
        const id = await until('the answer request', () => newestRequest(db, key, 'answer'));
        await until('the answer to be received', async () => ((await page.locator(`[data-question="open"] [data-msg="person"][data-delivery="received"]`).count()) > 0 ? true : undefined));
        const asked = await saved(page, shots, 'u7-question-answered.png');
        await page.locator('[data-act="approve"]').click();
        await until('the answer to reach acted on', reaches(page, id, 'acted'), attemptStartMs);
        const line = await lineOf(page, id);
        const path = await saved(page, shots, 'u7-question.png');
        const start = await startInputAfter(db, key, answeredAt);
        const holds = start?.input.includes(`"option":"${option}"`) ?? false;
        return [
          check(stamp.test(line), 'the answer shows sent, received, and acted on', line),
          check(holds, "the next attempt's first turn holds the picked option", `${option} in the ${start?.step ?? 'missing'} prompt: ${String(holds)}`),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? `${asked}, ${path}` : errors.join('; ')),
        ];
      }),
    );
  },
};

const retryNote: Lane = {
  unit,
  id: '5',
  seeds: ['failed-behavior'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'failed-behavior');
    const note = 'Round half up to the cent before you add the totals.';
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        const reason = (await page.locator('[data-card="headline"]').textContent()) ?? '';
        const tried = (await page.locator('[data-card="note"]').first().textContent()) ?? '';
        const repeated = await page.locator('[aria-label="Agent"]').getByText(reason.trim(), { exact: true }).count();
        const before = await saved(page, shots, 'u7-failed.png');
        const waiting = await db.selectFrom('task').select('waiting_reason').where('key', '=', key).executeTakeFirstOrThrow();
        const retried = new Date();
        await page.locator(noteBox).fill(note);
        await page.locator(retryButton).click();
        const id = await until('the retry request', () => newestRequest(db, key, 'retry'));
        await until('the note to show as sent', async () => ((await page.locator(bubble(id)).count()) > 0 ? true : undefined), 10_000);
        await until('the note to reach acted on', reaches(page, id, 'acted'), attemptStartMs);
        const line = await lineOf(page, id);
        const path = await saved(page, shots, 'u7-retry-note.png');
        const start = await startInputAfter(db, key, retried);
        const named = /Retry starts again at (\w+)/.exec(waiting.waiting_reason ?? '')?.[1]?.toLowerCase();
        return [
          check(/^[^.]+\.$/.test(reason.trim()), 'the reason the task failed is one sentence', reason),
          check(tried.startsWith('What it tried: '), 'the status card says what the agent tried', tried),
          check(repeated === 0, 'the agent panel does not repeat the reason', `${String(repeated)} copies in the panel`),
          check(stamp.test(line), 'the note shows sent, received, and acted on', line),
          check(start?.input.includes(note) ?? false, "the next attempt's first turn holds the note", `${start?.step ?? 'no attempt'} prompt holds the note: ${String(start?.input.includes(note) ?? false)}`),
          check(named === undefined || start?.step === named, 'the note reaches the step the waiting reason names', `reason names ${named ?? 'no step'}, the attempt ran ${start?.step ?? 'nothing'}`),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? `${before}, ${path}` : errors.join('; ')),
        ];
      }),
    );
  },
};

const environment: Lane = {
  unit,
  id: '6',
  seeds: ['failed-environment'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'failed-environment');
    return open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
      const reason = (await page.locator('[data-card="headline"]').textContent()) ?? '';
      const path = await saved(page, shots, 'u7-env.png');
      return [check(reason.includes('the environment broke, not the change'), 'the reason says the environment broke, not the change', `${reason} (${path})`)];
    });
  },
};

const tool: Lane = {
  unit,
  id: '7',
  seeds: ['failed-behavior'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'failed-behavior');
    return open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
      const command = page.locator('details:has([data-command])').last();
      await command.scrollIntoViewIfNeeded();
      const closed = (await command.getAttribute('open')) === null && (await command.locator('pre').count()) === 0;
      const label = (await command.locator('[data-command]').textContent()) ?? '';
      await command.locator('summary').click();
      await command.locator('pre').waitFor();
      const output = (await command.locator('pre').textContent()) ?? '';
      const path = await saved(page, shots, 'u7-tool.png');
      return [
        check(closed, 'a command starts collapsed', closed ? 'closed with no output shown' : 'it was open'),
        check(label.startsWith('Ran ') && !label.endsWith('a command'), 'the summary names the command', label),
        check(output.trim() !== '', 'one click shows its output', `${output.trim().slice(0, 120)} (${path})`),
      ];
    });
  },
};

type Shown = { readonly document: { querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null; closest(selector: string): { getAttribute(name: string): string | null } | null }> } };

const shownItems: Script<Shown, null, readonly string[]> = window =>
  [...window.document.querySelectorAll('[data-attempt] [data-item]')].map(element => `${element.closest('[data-attempt]')?.getAttribute('data-attempt') ?? ''}:${element.getAttribute('data-item') ?? ''}`);

async function storedItems(db: Database, key: string): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('attempt_event')
    .innerJoin('attempt', 'attempt.id', 'attempt_event.attempt_id')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt_event.attempt_id as attempt', 'attempt_event.body'])
    .where('task.key', '=', key)
    .where('attempt_event.kind', '=', 'app')
    .orderBy('attempt_event.attempt_id')
    .orderBy('attempt_event.seq')
    .execute();
  return [...Map.groupBy(rows, row => row.attempt)].flatMap(([attempt, lines]) => reduce(lines).items.map(item => `${attempt}:${item.id}`));
}

async function replayOf(world: World, db: Database, browser: Parameters<Lane['run']>[1], key: string, shots: string, name: string): Promise<{ readonly same: boolean; readonly detail: string; readonly page: string }> {
  return open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
    const found = await run(page, shownItems, null);
    const onPage = Array.isArray(found) ? found.filter(each => typeof each === 'string') : [];
    const stored = await storedItems(db, key);
    const path = await saved(page, shots, name);
    return { same: JSON.stringify(onPage) === JSON.stringify(stored), detail: `page ${String(onPage.length)} items, stored ${String(stored.length)}`, page: (await page.locator('[aria-label="Agent"]').textContent()) ?? path };
  });
}

const replay: Lane = {
  unit,
  id: '8',
  seeds: ['done', 'expired', 'failed-behavior'],
  run: async (world, browser, shots) =>
    withDatabase(world, async db => {
      const done = await replayOf(world, db, browser, keyOf(world, 'done'), shots, 'u7-replay.png');
      const finished = await replayOf(world, db, browser, keyOf(world, 'failed-behavior'), shots, 'u7-replay-finished.png');
      const expiredKey = keyOf(world, 'expired');
      const ended = await db.selectFrom('attempt').innerJoin('task', 'task.id', 'attempt.task_id').select(eb => eb.fn.max('attempt.finished_at').as('at')).where('task.key', '=', expiredKey).executeTakeFirstOrThrow();
      const endedAt = new Date(ended.at ?? 0).getTime();
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const expected = `The transcript expired on ${day(new Date(endedAt + 30 * 86_400_000).toISOString(), zone)}. Attempts and evidence stay until ${day(new Date(endedAt + 180 * 86_400_000).toISOString(), zone)}.`;
      const expired = await open(browser, view(world, `/tasks/${expiredKey}`, 'light', true), async ({ page }) => {
        const text = (await page.locator('[data-expired]').textContent().catch(() => null)) ?? '';
        await saved(page, shots, 'u7-replay-expired.png');
        return text;
      });
      return [
        check(done.same, 'the done replay equals reduce over the stored lines', done.detail),
        check(finished.same, 'a finished task with a transcript replays exactly what reduce gives', finished.detail),
        check(!done.page.includes('Send') && !done.page.includes('Retry'), 'the replay is read-only', 'no Send or Retry in the panel'),
        check(expired === expected, 'the expired task shows both dates', expired),
      ];
    }),
};

const models = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.flatMap(models);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, inner]) => (name === 'model' && typeof inner === 'string' ? [inner] : models(inner)));
};

const real: Lane = {
  unit,
  id: '9',
  agent: 'real',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    const message = 'Before you finish, name the files you read in one line.';
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await page.locator('[data-live="true"]').waitFor({ timeout: attemptStartMs });
        await until('the agent to start its turn', async () => ((await page.locator('[data-attempt] [data-item]').count()) >= 2 ? true : undefined), attemptStartMs);
        const id = await sendFromBox(page, message);
        await until('the steer to reach acted on', reaches(page, id, 'acted'), 300_000);
        const replied = await until("the agent's next message", async () => {
          const later = page.locator(`${bubble(id)} ~ li[data-item]`);
          return (await later.count()) > 0 ? ((await later.last().textContent()) ?? undefined) : undefined;
        }, 300_000).catch(() => undefined);
        await wait(2000);
        const line = await lineOf(page, id);
        const path = await saved(page, shots, 'u7-real.png');
        const rows = await db.selectFrom('attempt_event').innerJoin('attempt', 'attempt.id', 'attempt_event.attempt_id').innerJoin('task', 'task.id', 'attempt.task_id').select('attempt_event.body').where('task.key', '=', key).execute();
        const seen = [...new Set(rows.flatMap(row => models(row.body)))];
        await page.locator('[data-stop="button"]').click().catch(() => undefined);
        return [
          check(stamp.test(line), 'the steer reaches acted on in a real Codex turn', line),
          check(replied !== undefined, "the agent's next message follows the steer", (replied ?? 'none').slice(0, 200)),
          check(seen.length > 0 && seen.every(model => model === pinnedModel), `every model the stored events name is ${pinnedModel}`, `${seen.join(', ') || 'none'} (${path})`),
        ];
      }),
    );
  },
};

const video: Lane = {
  unit,
  id: 'video',
  seeds: ['running', 'failed-behavior'],
  run: async (world, browser, shots) => {
    const folder = join(shots, '..', 'review');
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'u7-review.webm');
    await recording(browser, view(world, `/tasks/${keyOf(world, 'running')}`, 'light', true), file, async ({ page }) => {
      await page.locator('[data-live="true"]').waitFor();
      await wait(3000);
      await page.locator(box).pressSequentially('Also check a 503.', { delay: 60 });
      await wait(500);
      await page.locator(sendButton).click();
      const id = await until('the steer bubble', async () => (await page.locator('[data-msg="person"][data-request]').last().getAttribute('data-request')) ?? undefined, 10_000);
      await until('the steer to reach acted on', reaches(page, id, 'acted'), 60_000);
      await wait(6000);
      await page.goto(`${world.origin}/tasks/${keyOf(world, 'failed-behavior')}`);
      await wait(4000);
      await page.locator(noteBox).pressSequentially('Round half up to the cent before you add the totals.', { delay: 40 });
      await page.locator(retryButton).click();
      await until('the note bubble', async () => ((await page.locator('[data-msg="person"][data-delivery="received"], [data-msg="person"][data-delivery="acted"]').count()) > 0 ? true : undefined), 20_000);
      await until('the note to reach acted on', async () => ((await page.locator('[data-msg="person"][data-delivery="acted"]').count()) > 0 ? true : undefined), attemptStartMs);
      await wait(5000);
    });
    return [pass('the review video shows a steer reaching acted on, then a Retry with a note', file)];
  },
};

type Stamps = Record<string, Record<string, number>>;

type Watched = {
  readonly document: { querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null }>; querySelector(selector: string): { click(): void } | null; readonly body: unknown };
  readonly MutationObserver: new (callback: () => void) => { observe(target: unknown, options: { readonly childList: boolean; readonly subtree: boolean; readonly attributes: boolean }): void };
  deliveries?: Stamps;
  clickedAt?: number[];
};

const watchDeliveries: Script<Watched, null, number> = window => {
  const seen: Stamps = {};
  const mark = (): void => {
    for (const element of window.document.querySelectorAll('[data-msg="person"][data-request]')) {
      const id = element.getAttribute('data-request') ?? '';
      const state = element.getAttribute('data-delivery') ?? '';
      seen[id] ??= {};
      seen[id][state] ??= Date.now();
    }
  };
  mark();
  new window.MutationObserver(mark).observe(window.document.body, { childList: true, subtree: true, attributes: true });
  window.deliveries = seen;
  window.clickedAt = [];
  return 0;
};

const clickSend: Script<Watched, null, number> = window => {
  const at = Date.now();
  window.clickedAt?.push(at);
  window.document.querySelector('[data-message="send"]')?.click();
  return at;
};

const readStamps: Script<Watched, null, Stamps> = window => window.deliveries ?? {};

type Navigation = { readonly performance: { getEntriesByType(type: string): readonly { readonly responseStart: number; readonly loadEventEnd: number; readonly domContentLoadedEventEnd: number }[] } };

const navigation: Script<Navigation, null, readonly number[]> = window => {
  const entry = window.performance.getEntriesByType('navigation')[0];
  return entry === undefined ? [] : [entry.responseStart, entry.domContentLoadedEventEnd, entry.loadEventEnd];
};

async function insertReplay(db: Database, key: string, count: number): Promise<void> {
  const live = await db.selectFrom('attempt').innerJoin('task', 'task.id', 'attempt.task_id').select('attempt.id').where('task.key', '=', key).where('attempt.finished_at', 'is', null).executeTakeFirstOrThrow();
  const top = Number((await db.selectFrom('attempt_event').select(eb => eb.fn.max<string | null>('seq').as('seq')).where('attempt_id', '=', live.id).executeTakeFirstOrThrow()).seq ?? 0);
  const rows = Array.from({ length: count }, (_, index) => {
    const item = `replay-${String(index + 1)}`;
    const body = { method: 'item/completed', params: { turnId: 'replay', item: { id: item, type: 'agentMessage', text: `Replayed line ${String(index + 1)} of ${String(count)}` } } };
    return { attempt_id: live.id, seq: String(top + index + 1), kind: 'app' as const, method: 'item/completed', item_id: item, fragment: false, body: JSON.stringify(body), stored_at: new Date() };
  });
  for (let start = 0; start < rows.length; start += 500) await db.insertInto('attempt_event').values(rows.slice(start, start + 500)).execute();
}

async function replayRender(world: World, browser: Parameters<Lane['run']>[1], key: string, loads: number): Promise<readonly number[]> {
  const times: number[] = [];
  for (let n = -2; n < loads; n += 1) {
    const measured = await open(browser, view(world, `/tasks/${key}`, 'light', false), async ({ page }) => {
      await page.locator('[data-item="replay-2000"]').waitFor();
      const found = await run(page, navigation, null);
      return Array.isArray(found) && typeof found[2] === 'number' ? found[2] : Number.NaN;
    });
    if (n >= 0) times.push(measured);
  }
  return times;
}

const perf: Lane = {
  unit,
  id: 'perf',
  alone: true,
  seeds: ['running'],
  run: async (world, browser) =>
    withDatabase(world, async db => {
      const key = keyOf(world, 'running');
      const sends = await open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await page.locator('[data-live="true"]').waitFor();
        await run(page, watchDeliveries, null);
        const clicks: { readonly at: number; readonly id: string }[] = [];
        for (let n = 1; n <= 20; n += 1) {
          const before = new Set(Object.keys((await run(page, readStamps, null)) as Stamps));
          await page.locator(box).fill(`Perf steer ${String(n)} of 20.`);
          const at = Number(await run(page, clickSend, null));
          const id = await until(`steer ${String(n)} to show`, async () => Object.keys((await run(page, readStamps, null)) as Stamps).find(each => !before.has(each)), 10_000);
          clicks.push({ at, id });
          await until(`steer ${String(n)} to be acted on`, reaches(page, id, 'acted'), 30_000);
        }
        await wait(1000);
        return { clicks, stamps: (await run(page, readStamps, null)) as Stamps };
      });
      const received = await db.selectFrom('attempt_command').select(['action_id', 'received_at']).where('action_id', 'in', sends.clicks.map(each => each.id)).execute();
      const sentMs = sends.clicks.map(each => (sends.stamps[each.id]?.['sent'] ?? Math.min(...Object.values(sends.stamps[each.id] ?? {}))) - each.at);
      const receivedLag = received.map(row => {
        const seen = sends.stamps[row.action_id ?? ''] ?? {};
        const shown = Math.min(seen['received'] ?? Number.POSITIVE_INFINITY, seen['acted'] ?? Number.POSITIVE_INFINITY);
        return shown - (row.received_at?.getTime() ?? Number.NaN);
      });
      await world.holdEngine();
      await insertReplay(db, key, 2000);
      const renders = await replayRender(world, browser, key, 10);
      const sentP95 = percentile(sentMs, 0.95);
      const receivedP95 = percentile(receivedLag, 0.95);
      return [
        check(sentP95 <= 300, 'pressing Send shows Sent within 300 ms at p95', `p95 ${sentP95.toFixed(0)} ms over ${String(sentMs.length)}: ${sentMs.map(each => each.toFixed(0)).join(' ')}`),
        check(receivedP95 <= 1000, 'Received shows within 1 s of the stored receipt at p95', `p95 ${receivedP95.toFixed(0)} ms over ${String(receivedLag.length)}: ${receivedLag.map(each => each.toFixed(0)).join(' ')}`),
        info('the 2,000-item replay renders', 'n/a', `median ${percentile(renders, 0.5).toFixed(0)} ms, p95 ${percentile(renders, 0.95).toFixed(0)} ms to the load event over 10 loads after 2 to warm up: ${renders.map(each => each.toFixed(0)).join(' ')}`),
      ];
    }),
};

export const agentLanes: readonly Lane[] = [regression, steer, steerLate, question, retryNote, environment, tool, replay, real, video, perf];
