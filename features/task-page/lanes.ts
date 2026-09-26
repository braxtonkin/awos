import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import type { Page } from 'playwright-core';
import { connect, type Database } from '../../shared/db/client.ts';
import { reduce } from '../../shared/items.ts';
import { note } from '../../shared/review.ts';
import { request } from '../../shared/requests.ts';
import { open, recording, run, shoot, type Script, type Theme, type View } from '../../tools/verify/browser.ts';
import { fail, info, pass } from '../../tools/verify/check.ts';
import type { Lane, World } from '../../tools/verify/dashboard.ts';
import { readLimits } from '../../tools/verify/screens/gates.ts';
import { actAs, actingPerson, capture, gateLines } from '../../tools/verify/screens/screens.ts';

const unit = 'u4';
const width = 1440;
const height = 900;
const waitMs = 30_000;
const stop = '[data-stop="button"]';
const said = '[data-stop="said"]';
export const localPeople = ['Braxton Kinney', 'Priya Natarajan', 'Tomás Rivera', 'Mei Chen'];

type Element = { getAttribute(name: string): string | null; closest(selector: string): Element | null };

type ItemsWindow = {
  readonly document: { querySelectorAll(selector: string): Iterable<Element>; readonly body: unknown };
  readonly MutationObserver: new (callback: () => void) => { observe(target: unknown, options: { readonly childList: boolean; readonly subtree: boolean }): void };
  itemsSeen?: Record<string, number>;
};

const watchItems: Script<ItemsWindow, null, number> = window => {
  const seen: Record<string, number> = {};
  const mark = (): void => {
    for (const element of window.document.querySelectorAll('[data-attempt] [data-item]')) {
      const key = `${element.closest('[data-attempt]')?.getAttribute('data-attempt') ?? ''}:${element.getAttribute('data-item') ?? ''}`;
      seen[key] ??= Date.now();
    }
  };
  mark();
  new window.MutationObserver(mark).observe(window.document.body, { childList: true, subtree: true });
  window.itemsSeen = seen;
  return Object.keys(seen).length;
};

const readSeen: Script<ItemsWindow, null, Record<string, number>> = window => window.itemsSeen ?? {};

const shownItems: Script<ItemsWindow, null, readonly string[]> = window =>
  [...window.document.querySelectorAll('[data-attempt] [data-item]')].map(element => `${element.closest('[data-attempt]')?.getAttribute('data-attempt') ?? ''}:${element.getAttribute('data-item') ?? ''}`);

const seenNow = async (page: Page): Promise<Readonly<Record<string, number>>> => {
  const found = await run(page, readSeen, null);
  return typeof found === 'object' && found !== null ? Object.fromEntries(Object.entries(found).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) : {};
};

const shown = async (page: Page): Promise<readonly string[]> => {
  const found = await run(page, shownItems, null);
  return Array.isArray(found) ? found.filter(each => typeof each === 'string') : [];
};

export const view = (world: World, path: string, theme: Theme, acting: boolean): View => ({ url: `${world.origin}${path}`, width, height, theme, steps: acting ? actAs(actingPerson) : [] });

export const keyOf = (world: World, seed: string): string => {
  const key = world.keys.get(seed);
  if (key === undefined) throw new Error(`local-engine printed no key for the seed ${seed}`);
  return key;
};

export async function withDatabase<T>(world: World, work: (db: Database) => Promise<T>): Promise<T> {
  const db = connect(world.ownerUrl, 2);
  try {
    return await work(db);
  } finally {
    await db.destroy();
  }
}

export async function until<T>(what: string, found: () => Promise<T | undefined>, limitMs = waitMs): Promise<T> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await found();
    if (value !== undefined) return value;
    await wait(100);
  }
  throw new Error(`${what} did not happen within ${String(limitMs / 1000)} s`);
}

const saidText = async (page: Page): Promise<string | undefined> => ((await page.locator(said).count()) === 0 ? undefined : ((await page.locator(said).textContent()) ?? undefined));

const saidIs = (page: Page, text: string) => async (): Promise<true | undefined> => ((await saidText(page)) === text ? true : undefined);

type Stored = { readonly attempt: string; readonly item: string; readonly at: Date };

async function firstStored(db: Database, key: string): Promise<readonly Stored[]> {
  const rows = await db
    .selectFrom('attempt_event')
    .innerJoin('attempt', 'attempt.id', 'attempt_event.attempt_id')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(eb => ['attempt_event.attempt_id as attempt', 'attempt_event.item_id as item', eb.fn.min('attempt_event.stored_at').as('at')])
    .where('task.key', '=', key)
    .where('attempt_event.item_id', 'is not', null)
    .groupBy(['attempt_event.attempt_id', 'attempt_event.item_id'])
    .execute();
  return rows.flatMap(row => (row.item === null ? [] : [{ attempt: row.attempt, item: row.item, at: new Date(row.at) }]));
}

async function storedTranscripts(db: Database, key: string): Promise<readonly string[]> {
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

const stoppedBy = async (db: Database, key: string): Promise<{ readonly state: string; readonly by: string | null }> => {
  const row = await db
    .selectFrom('task')
    .leftJoin('human_action', 'human_action.id', 'task.stopped_by')
    .leftJoin('person', 'person.id', 'human_action.person_id')
    .select(['task.state', 'person.name'])
    .where('task.key', '=', key)
    .executeTakeFirstOrThrow();
  return { state: row.state, by: row.name };
};

const requestsOf = (db: Database, key: string) =>
  db.selectFrom('person_request').innerJoin('task', 'task.id', 'person_request.task_id').select(['person_request.id', 'person_request.answer', 'person_request.reason', 'person_request.answered_at']).where('task.key', '=', key).orderBy('person_request.position').execute();

export const percentile = (values: readonly number[], share: number): number => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(share * values.length))] ?? Number.NaN;

const regression: Lane = {
  unit,
  id: '1',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        const afterPicking = errors.length;
        const watchedFrom = Date.now();
        const before = Number(await run(page, watchItems, null));
        const seen = await until('10 new items on the page', async () => {
          const now = await seenNow(page);
          return Object.keys(now).length >= before + 10 ? now : undefined;
        }, 60_000);
        const stored = (await firstStored(db, key)).filter(each => each.at.getTime() > watchedFrom);
        const late = stored.flatMap(each => {
          const at = seen[`${each.attempt}:${each.item}`];
          return at === undefined || at - each.at.getTime() <= 1000 ? [] : [`${each.item} ${String(at - each.at.getTime())} ms`];
        });
        const fresh = stored.filter(each => seen[`${each.attempt}:${each.item}`] !== undefined);
        const missing = stored.filter(each => seen[`${each.attempt}:${each.item}`] === undefined && Date.now() - each.at.getTime() > 1000);
        await page.locator(stop).click();
        await until('the Stop button to say Stopped', saidIs(page, 'Stopped'));
        await wait(500);
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-regression.png'));
        const task = await stoppedBy(db, key);
        return [
          info('trunk has no dashboard', 'n/a', 'the task page is new, so this lane gates the new behavior'),
          late.length === 0 && missing.length === 0 ? pass('every stored item shows within 1 s of its storage', `${String(fresh.length)} items stored and shown while watched, the slowest ${String(Math.max(0, ...fresh.map(each => (seen[`${each.attempt}:${each.item}`] ?? 0) - each.at.getTime())))} ms`) : fail('every stored item shows within 1 s of its storage', [...late, ...missing.map(each => `${each.item} never showed`)].join(', ')),
          task.state === 'stopped' && task.by === actingPerson ? pass('Stop ends the task stopped with Braxton Kinney\'s action', `${task.state} by ${task.by}`) : fail('Stop ends the task stopped with Braxton Kinney\'s action', `${task.state} by ${task.by ?? 'nobody'}`),
          errors.length === 0 ? pass('the page raised no errors', join(shots, 'u4-regression.png')) : fail('the page raised no errors', `${String(afterPicking)} while picking the person: ${errors.join('; ')}`),
        ];
      }),
    );
  },
};

const notFound: Lane = {
  unit,
  id: '2',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const response = await fetch(`${world.origin}/tasks/NOPE-1`);
    const html = await response.text();
    const limits = await readLimits();
    const taken = await capture(browser, { name: 'u4-not-found', url: `${world.origin}/tasks/NOPE-1`, steps: actAs(actingPerson), height, names: localPeople }, limits, shots);
    await copyFile(taken.shots.light, join(shots, 'u4-not-found.png'));
    return [
      response.status === 404 ? pass('the status is 404', '404') : fail('the status is 404', String(response.status)),
      html.includes('No task has that key') ? pass('the page says no task has that key', 'No task has that key') : fail('the page says no task has that key', html.slice(0, 200)),
      ...gateLines(taken, limits),
    ];
  },
};

const noPerson: Lane = {
  unit,
  id: '3',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', false), async ({ page }) => {
        await page.locator(stop).click();
        await until('the Stop button to ask who you are', saidIs(page, 'Pick who you are first'));
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-no-person.png'));
        const rows = await requestsOf(db, key);
        return [
          pass('the button says Pick who you are first', 'Pick who you are first'),
          rows.length === 0 ? pass('no request row exists', '0 rows') : fail('no request row exists', `${String(rows.length)} rows`),
        ];
      }),
    );
  },
};

const doubleStop: Lane = {
  unit,
  id: '4',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await page.locator(stop).click();
        await wait(50);
        await page.locator(stop).click();
        const rows = await until('both requests answered', async () => {
          const found = await requestsOf(db, key);
          return found.length >= 2 && found.every(row => row.answer !== null) ? found : undefined;
        });
        await until('the button to settle', async () => ((await page.locator(stop).count()) === 0 ? true : undefined));
        await wait(500);
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-double-stop.png'));
        const actions = await db.selectFrom('human_action').innerJoin('task', 'task.id', 'human_action.task_id').select('human_action.id').where('task.key', '=', key).where('human_action.kind', '=', 'stop_task').execute();
        const [first, second] = rows;
        return [
          rows.length === 2 && first?.answer === 'recorded' ? pass('one request is recorded', `${String(rows.length)} requests, the first ${first.answer}`) : fail('one request is recorded', JSON.stringify(rows)),
          second?.answer === 'refused' ? pass('the second is answered as already stopped', second.reason ?? '') : fail('the second is answered as already stopped', JSON.stringify(second)),
          actions.length === 1 ? pass('one human_action exists', actions.map(each => each.id).join(', ')) : fail('one human_action exists', String(actions.length)),
          info('the button says', 'n/a', (await saidText(page)) ?? 'nothing'),
        ];
      }),
    );
  },
};

const engineDown: Lane = {
  unit,
  id: '5',
  alone: true,
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await world.holdEngine();
        await page.locator(stop).click();
        await until('the button to wait for the engine', saidIs(page, 'Waiting for the engine'));
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-engine-down.png'));
        await wait(5000);
        await world.releaseEngine();
        await until('the button to say Stopped', saidIs(page, 'Stopped'), 120_000);
        const paintedAt = Date.now();
        await shoot(page, join(shots, 'u4-engine-up.png'));
        const [row] = await requestsOf(db, key);
        const answeredAt = row?.answered_at === null || row?.answered_at === undefined ? undefined : new Date(row.answered_at).getTime();
        const gap = answeredAt === undefined ? undefined : paintedAt - answeredAt;
        return [
          pass('the button shows Waiting for the engine while the engine is down', join(shots, 'u4-engine-down.png')),
          gap !== undefined && gap <= 2000 ? pass('the button shows Stopped within 2 s of the engine\'s first pass', `${String(gap)} ms after the engine answered`) : fail('the button shows Stopped within 2 s of the engine\'s first pass', gap === undefined ? 'the request has no answer' : `${String(gap)} ms`),
        ];
      }),
    );
  },
};

const reconnect: Lane = {
  unit,
  id: '6',
  alone: true,
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await wait(3000);
        await page.context().setOffline(true);
        await wait(10_000);
        await page.context().setOffline(false);
        await wait(5000);
        await world.holdEngine();
        await wait(3000);
        const onPage = await shown(page);
        const stored = await storedTranscripts(db, key);
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-reconnect.png'));
        const twice = onPage.filter((each, index) => onPage.indexOf(each) !== index);
        const same = JSON.stringify(onPage) === JSON.stringify(stored);
        return [
          same ? pass('the items on the page equal reduce over the stored lines', `${String(onPage.length)} items`) : fail('the items on the page equal reduce over the stored lines', `page ${String(onPage.length)}, stored ${String(stored.length)}, missing ${stored.filter(each => !onPage.includes(each)).slice(0, 5).join(', ')}`),
          twice.length === 0 ? pass('no item shows twice', 'none') : fail('no item shows twice', twice.join(', ')),
        ];
      }),
    );
  },
};

const secondAttempt: Lane = {
  unit,
  id: '7',
  seeds: ['stopped'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'stopped');
    return withDatabase(world, async db => {
      const person = await db.selectFrom('person').select('id').where('name', '=', actingPerson).executeTakeFirstOrThrow();
      const task = await db.selectFrom('task').select('id').where('key', '=', key).executeTakeFirstOrThrow();
      await request(db, { id: randomUUID(), person: person.id, at: new Date(), kind: 'retry', target: task.id, payload: { note: note.parse('Try again from the start.') } });
      return open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page }) => {
        await until('a second attempt with items', async () => ((await page.locator('[data-attempt]').count()) >= 2 && (await page.locator('[data-attempt]:nth-of-type(2) [data-item]').count()) >= 3 ? true : undefined), 180_000);
        const live = await shown(page);
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-second-attempt.png'));
        await page.reload();
        await page.locator('[data-attempt]').nth(1).waitFor();
        const reloaded = await shown(page);
        const attempts = new Set(live.map(each => each.split(':')[0]));
        const kept = live.every(each => reloaded.includes(each));
        return [
          attempts.size === 2 ? pass('both attempts show their items under their own attempt', [...attempts].join(', ')) : fail('both attempts show their items under their own attempt', [...attempts].join(', ')),
          kept ? pass('a reload shows the same items', `${String(live.length)} before, ${String(reloaded.length)} after`) : fail('a reload shows the same items', live.filter(each => !reloaded.includes(each)).join(', ')),
        ];
      });
    });
  },
};

const noScript: Lane = {
  unit,
  id: '8',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return withDatabase(world, async db => {
      const stored = await storedTranscripts(db, key);
      const title = await db.selectFrom('task').select('title').where('key', '=', key).executeTakeFirstOrThrow();
      const html = await (await fetch(`${world.origin}/tasks/${key}`)).text();
      const inHtml = stored.filter(each => html.includes(`data-item="${each.split(':')[1] ?? ''}"`));
      await open(browser, { ...view(world, `/tasks/${key}`, 'light', false), scripts: false }, async ({ page }) => {
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u4-no-script.png'));
      });
      return [
        html.includes(title.title) ? pass('the header is in the HTML', title.title) : fail('the header is in the HTML', 'the title is missing'),
        inHtml.length === stored.length ? pass('the stored items are in the HTML', `${String(inHtml.length)} items`) : fail('the stored items are in the HTML', `${String(inHtml.length)} of ${String(stored.length)}`),
      ];
    });
  },
};

const dark: Lane = {
  unit,
  id: '9',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    const limits = await readLimits();
    const taken = await capture(browser, { name: 'u4-dark', url: `${world.origin}/tasks/${key}`, steps: actAs(actingPerson), height, names: localPeople }, limits, shots);
    await copyFile(taken.shots.dark, join(shots, 'u4-dark.png'));
    return gateLines(taken, limits);
  },
};

const video: Lane = {
  unit,
  id: 'video',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    const folder = join(shots, '..', 'review');
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'u4-review.webm');
    await recording(browser, view(world, `/tasks/${key}`, 'light', true), file, async ({ page }) => {
      await wait(25_000);
      await page.locator(stop).click();
      await until('the Stop button to say Stopped', saidIs(page, 'Stopped'));
      await wait(8000);
    });
    return [pass('the review video shows the task streaming and Stop', file)];
  },
};

async function insertLines(db: Database, key: string, count: number, everyMs: number): Promise<ReadonlyMap<string, number>> {
  const live = await db.selectFrom('attempt').innerJoin('task', 'task.id', 'attempt.task_id').select('attempt.id').where('task.key', '=', key).where('attempt.finished_at', 'is', null).executeTakeFirstOrThrow();
  const top = await db.selectFrom('attempt_event').select(eb => eb.fn.max<string | null>('seq').as('seq')).where('attempt_id', '=', live.id).executeTakeFirstOrThrow();
  const start = Number(top.seq ?? 0);
  const storedAt = new Map<string, number>();
  for (let n = 1; n <= count; n += 1) {
    const item = `perf-${String(start + n)}`;
    const at = new Date();
    storedAt.set(`${live.id}:${item}`, at.getTime());
    const body = { method: 'item/completed', params: { turnId: 'perf', item: { id: item, type: 'agentMessage', text: `Line ${String(n)} of ${String(count)}` } } };
    await db.insertInto('attempt_event').values({ attempt_id: live.id, seq: String(start + n), kind: 'app', method: 'item/completed', item_id: item, fragment: false, body: JSON.stringify(body), stored_at: at }).execute();
    if (everyMs > 0) await wait(everyMs);
  }
  return storedAt;
}

async function paintLatencies(db: Database, page: Page, key: string): Promise<readonly number[]> {
  await run(page, watchItems, null);
  const storedAt = await insertLines(db, key, 500, 50);
  await wait(3000);
  const seen = await seenNow(page);
  return [...storedAt].map(([id, at]) => (seen[id] ?? Number.POSITIVE_INFINITY) - at);
}

type ScriptsWindow = { readonly performance: { getEntriesByType(type: string): Iterable<{ readonly initiatorType?: string; readonly encodedBodySize?: number; readonly name: string }> } };

const scriptBytes: Script<ScriptsWindow, null, number> = window => [...window.performance.getEntriesByType('resource')].filter(entry => entry.initiatorType === 'script').reduce((total, entry) => total + (entry.encodedBodySize ?? 0), 0);

const commits = async (db: Database): Promise<number> => {
  const found = await sql<{ readonly commits: string }>`select xact_commit::text as commits from pg_stat_database where datname = current_database()`.execute(db);
  return Number(found.rows[0]?.commits ?? Number.NaN);
};

const perf: Lane = {
  unit,
  id: 'perf',
  alone: true,
  seeds: ['running'],
  run: async (world, browser) => {
    const key = keyOf(world, 'running');
    await world.holdEngine();
    return withDatabase(world, async db => {
      const paint = await open(browser, view(world, `/tasks/${key}`, 'light', true), ({ page }) => paintLatencies(db, page, key));
      await insertLines(db, key, 1500, 0);
      const firsts: number[] = [];
      for (let n = -2; n < 20; n += 1) {
        const started = performance.now();
        const response = await fetch(`${world.origin}/tasks/${key}`);
        if (n >= 0) firsts.push(performance.now() - started);
        await response.arrayBuffer();
      }
      const bytes = Number(await open(browser, view(world, `/tasks/${key}`, 'light', false), ({ page }) => run(page, scriptBytes, null)));
      await wait(statsSettleMs);
      const idle = await perSecond(db, 10_000);
      const contexts = await Promise.all(Array.from({ length: 20 }, () => browser.newContext()));
      const pages = await (async () => {
        try {
          await Promise.all(contexts.map(async context => (await context.newPage()).goto(`${world.origin}/tasks/${key}`)));
          await wait(statsSettleMs);
          return await perSecond(db, 20_000);
        } finally {
          await Promise.all(contexts.map(context => context.close()));
        }
      })();
      const paintP95 = percentile(paint, 0.95);
      const ttfbP95 = percentile(firsts, 0.95);
      const queries = pages - idle;
      return [
        paintP95 <= 1000 ? pass('paint p95 of 500 lines at 20 a second is at most 1 s', `${paintP95.toFixed(0)} ms`) : fail('paint p95 of 500 lines at 20 a second is at most 1 s', `${paintP95.toFixed(0)} ms`),
        (ttfbP95 <= 500 ? pass : fail)('time to first byte p95 with 2,000 lines is at most 500 ms', `p95 ${ttfbP95.toFixed(0)} ms, median ${percentile(firsts, 0.5).toFixed(0)} ms, over 20 loads after 2 to warm up: ${firsts.map(each => each.toFixed(0)).join(' ')}`),
        bytes <= 250_000 ? pass('the page loads at most 250 kB of compressed JavaScript first', `${(bytes / 1000).toFixed(1)} kB`) : fail('the page loads at most 250 kB of compressed JavaScript first', `${(bytes / 1000).toFixed(1)} kB`),
        queries <= 200 ? pass('20 open pages cost at most 200 queries a second', `${queries.toFixed(1)} a second above ${idle.toFixed(1)} idle`) : fail('20 open pages cost at most 200 queries a second', `${queries.toFixed(1)} a second`),
      ];
    });
  },
};

const statsSettleMs = 15_000;

async function perSecond(db: Database, ms: number): Promise<number> {
  const before = await commits(db);
  await wait(ms);
  return (await commits(db) - before - 2) / (ms / 1000);
}

export const lanes: readonly Lane[] = [regression, notFound, noPerson, doubleStop, engineDown, reconnect, secondAttempt, noScript, dark, video, perf];

