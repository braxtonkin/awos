import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import type { Page } from 'playwright-core';
import { connect, type Database } from '../../shared/db/client.ts';
import { payloads, request } from '../../shared/requests.ts';
import { open, recording, run, shoot, type Script, type Theme, type View } from '../../tools/verify/browser.ts';
import { fail, info, pass, type Line } from '../../tools/verify/check.ts';
import type { Lane, World } from '../../tools/verify/dashboard.ts';
import { actAs, actingPerson } from '../../tools/verify/screens/screens.ts';

const unit = 'u6';
const width = 1440;
const height = 900;
const waitMs = 30_000;
const root = fileURLToPath(new URL('../../', import.meta.url));
export const localPeople = ['Braxton Kinney', 'Priya Natarajan', 'Tomás Rivera', 'Mei Chen'];
const madeUpPerson = 'Priya Natarajan';

const view = (world: World, path: string, theme: Theme = 'light', steps = actAs(actingPerson)): View => ({ url: `${world.origin}${path}`, width, height, theme, steps });

const keyOf = (world: World, seed: string): string => {
  const key = world.keys.get(seed);
  if (key === undefined) throw new Error(`local-engine printed no key for the seed ${seed}`);
  return key;
};

async function withDatabase<T>(world: World, work: (db: Database) => Promise<T>): Promise<T> {
  const db = connect(world.ownerUrl, 2);
  try {
    return await work(db);
  } finally {
    await db.destroy();
  }
}

async function until<T>(what: string, found: () => Promise<T | undefined>, limitMs = waitMs): Promise<T> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await found();
    if (value !== undefined) return value;
    await wait(100);
  }
  throw new Error(`${what} did not happen within ${String(limitMs / 1000)} s`);
}

const saved = async (page: Page, shots: string, name: string): Promise<string> => {
  await mkdir(shots, { recursive: true });
  const path = join(shots, name);
  await shoot(page, path);
  return path;
};

const textOf = async (page: Page, selector: string): Promise<string> => ((await page.locator(selector).count()) === 0 ? '' : ((await page.locator(selector).first().textContent()) ?? ''));

const personId = async (db: Database, name: string): Promise<string> => (await db.selectFrom('person').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id;

const taskOf = (db: Database, key: string) => db.selectFrom('task').select(['id', 'state', 'waiting_on', 'waiting_reason', 'step', 'workflow']).where('key', '=', key).executeTakeFirstOrThrow();

type RowsWindow = {
  readonly document: { querySelector(selector: string): unknown; readonly body: unknown };
  readonly MutationObserver: new (callback: () => void) => { observe(target: unknown, options: { readonly childList: boolean; readonly subtree: boolean }): void };
  rowSeen?: number | null;
};

const watchRow: Script<RowsWindow, string, boolean> = (window, selector) => {
  const shown = (): boolean => window.document.querySelector(selector) !== null;
  const already = shown();
  window.rowSeen = already ? Date.now() : null;
  new window.MutationObserver(() => {
    if (!shown()) window.rowSeen = null;
    else window.rowSeen ??= Date.now();
  }).observe(window.document.body, { childList: true, subtree: true });
  return already;
};

const rowSeenAt: Script<RowsWindow, null, number | null> = window => window.rowSeen ?? null;

type Found = { getAttribute(name: string): string | null; readonly textContent: string | null };

type QueryWindow = { readonly document: { querySelectorAll(selector: string): Iterable<Found> } };

const attributes: Script<QueryWindow, { readonly selector: string; readonly name: string }, readonly string[]> = (window, asked) =>
  [...window.document.querySelectorAll(asked.selector)].map(element => (asked.name === 'data-mark' ? `${element.getAttribute(asked.name) ?? ''}=${(element.textContent ?? '').trim()}` : (element.getAttribute(asked.name) ?? '')));

const attributesOf = async (page: Page, selector: string, name: string): Promise<readonly string[]> => {
  const found = await run(page, attributes, { selector, name });
  return Array.isArray(found) ? found.filter(each => typeof each === 'string') : [];
};

const seenAt = async (page: Page): Promise<number | undefined> => {
  const at = await run(page, rowSeenAt, null);
  return typeof at === 'number' ? at : undefined;
};

const regression: Lane = {
  unit,
  id: '1',
  seeds: ['waiting-gate'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'waiting-gate');
    return open(browser, view(world, '/'), async ({ page, errors }) => {
      const first = await page.locator('[data-row]').first().getAttribute('data-row');
      const section = await page.locator(`[data-row="${key}"]`).locator('xpath=ancestor::section[1]').getAttribute('data-section');
      const path = await saved(page, shots, 'u6-regression.png');
      await page.locator(`[data-action="${key}"]`).click();
      await page.waitForURL(`**/tasks/${key}`);
      const title = await page.locator('h1').first().textContent();
      return [
        info('trunk has no Needs you page', 'n/a', "at U4's commit / answers 404, so this lane gates the new end state"),
        first === key && section === 'gates' ? pass('the gate shows first for Braxton Kinney, under Approve', `${key}, ${path}`) : fail('the gate shows first for Braxton Kinney, under Approve', `first row ${first ?? 'none'} in ${section ?? 'no section'}`),
        page.url().endsWith(`/tasks/${key}`) && (title ?? '') !== '' ? pass("the gate's link opens the task", `${page.url()} titled ${title ?? ''}`) : fail("the gate's link opens the task", page.url()),
        errors.length === 0 ? pass('the page raised no errors', 'none') : fail('the page raised no errors', errors.join('; ')),
      ];
    });
  },
};

const needsYou: Lane = {
  unit,
  id: '2',
  seeds: ['all'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'waiting-gate');
    return open(browser, view(world, '/'), async ({ page }) => {
      const path = await saved(page, shots, 'u6-needs-you.png');
      const row = page.locator(`[data-section="gates"] [data-row="${key}"]`);
      const box = (await row.count()) === 0 ? null : await row.boundingBox();
      const heading = await textOf(page, '[data-section="gates"] h2');
      const action = await textOf(page, `[data-action="${key}"]`);
      const sections = await attributesOf(page, '[data-section]', 'data-section');
      return [
        box !== null && box.y + box.height <= height ? pass('the task that needs your approval shows above the fold under Approve', `${key} at y ${String(Math.round(box.y))} under "${heading}", ${path}`) : fail('the task that needs your approval shows above the fold under Approve', box === null ? 'no gate row' : `its row ends at y ${String(Math.round(box.y + box.height))}`),
        action === 'Approve' ? pass('its action link says Approve', action) : fail('its action link says Approve', action),
        JSON.stringify(sections) === JSON.stringify(['waiting', 'gates', 'logins', 'running']) ? pass('Needs you orders waiting tasks, gates, logins, then running work', sections.join(', ')) : fail('Needs you orders waiting tasks, gates, logins, then running work', sections.join(', ')),
        ...(await Promise.all(
          seenWhere.map(async ([seed, section, what]) => {
            const found = section === 'logins' ? '[data-row="login-github"]' : `[data-row="${keyOf(world, seed)}"]`;
            const shown = (await page.locator(`[data-section="${section}"] ${found}`).count()) === 1;
            return (shown ? pass : fail)(`${what} shows under ${section} for Braxton Kinney`, shown ? found : `${found} is missing from ${section}`);
          }),
        )),
      ];
    });
  },
};

const seenWhere: readonly (readonly [string, string, string])[] = [
  ['question', 'waiting', 'the question'],
  ['failed-behavior', 'waiting', 'the failed task'],
  ['login-expired', 'logins', 'the broken login'],
  ['running', 'running', 'the running task'],
];

const answeredAt = async (db: Database, id: string): Promise<Date | undefined> => {
  const row = await db.selectFrom('person_request').select(['answer', 'answered_at']).where('id', '=', id).executeTakeFirst();
  return row?.answer === 'recorded' && row.answered_at !== null ? row.answered_at : undefined;
};

async function stopAndRetry(db: Database, page: Page, key: string, pauseMs: number): Promise<Date> {
  const person = await personId(db, actingPerson);
  const task = await taskOf(db, key);
  await request(db, { id: randomUUID(), person, at: new Date(), kind: 'stop', target: task.id, payload: payloads.stop.parse({}) });
  await until('the stopped gate to leave Needs you', async () => ((await page.locator(`[data-row="${key}"]`).count()) === 0 ? true : undefined));
  await wait(pauseMs);
  const retry = randomUUID();
  await request(db, { id: retry, person, at: new Date(), kind: 'retry', target: task.id, payload: payloads.retry.parse({ note: null }) });
  return until('the engine to apply Retry', () => answeredAt(db, retry), 60_000);
}

const live: Lane = {
  unit,
  id: '3',
  seeds: ['waiting-gate'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'waiting-gate');
    return withDatabase(world, db =>
      open(browser, view(world, '/'), async ({ page }) => {
        const selector = `[data-section="gates"] [data-row="${key}"]`;
        const before = await run(page, watchRow, selector);
        const waitingAgain = await stopAndRetry(db, page, key, 0);
        const shown = await until('the gate row on the page', () => seenAt(page), 30_000).catch(() => undefined);
        const path = await saved(page, shots, 'u6-live.png');
        const task = await taskOf(db, key);
        const delay = shown === undefined ? undefined : shown - waitingAgain.getTime();
        return [
          info('the stand-in never asks its question twice', 'n/a', 'Retry hands the stand-in its last review, so it plans instead of asking, and this lane watches a gate begin to wait again'),
          before === true ? pass('the gate showed before the lane stopped it', key) : fail('the gate showed before the lane stopped it', 'it was missing'),
          task.waiting_on === 'approval' ? pass('Retry returned the task to waiting for approval', task.waiting_reason ?? '') : fail('Retry returned the task to waiting for approval', `${task.state} on ${task.waiting_on ?? 'nothing'}`),
          delay !== undefined && delay <= 5000 ? pass('a task that begins to wait appears within 5 s with no reload', `${String(delay)} ms after the engine recorded it, ${path}`) : fail('a task that begins to wait appears within 5 s with no reload', delay === undefined ? 'it never appeared' : `${String(delay)} ms`),
        ];
      }),
    );
  },
};

const failedWaiting: Lane = {
  unit,
  id: '4',
  seeds: ['failed-behavior'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'failed-behavior');
    return withDatabase(world, async db => {
      const task = await taskOf(db, key);
      return open(browser, view(world, '/'), async ({ page }) => {
        const path = await saved(page, shots, 'u6-failed-waiting.png');
        const labels = await attributesOf(page, `[data-row="${key}"] [data-mark]`, 'data-mark');
        const reason = await textOf(page, `[data-row="${key}"]`);
        return [
          labels.join() === 'failed=Failed,needs-you=Needs you' ? pass('a red Failed mark sits beside the amber Needs you mark, each with its word', labels.join(', ')) : fail('a red Failed mark sits beside the amber Needs you mark, each with its word', labels.join(', ')),
          task.waiting_reason !== null && reason.includes(task.waiting_reason) ? pass('the waiting reason shows as written', task.waiting_reason) : fail('the waiting reason shows as written', reason),
          info('the screenshot', 'passed', path),
        ];
      });
    });
  },
};

const scannedFolders = ['features/overview', 'services/dashboard/app'];

function sourceFiles(folder: string): readonly string[] {
  return readdirSync(join(root, folder), { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path) && !path.startsWith('.next') && path !== 'verify.ts' && path !== 'lanes.ts')
    .map(path => join(folder, path));
}

const board: Lane = {
  unit,
  id: '5',
  seeds: ['waiting-gate', 'failed-behavior', 'running', 'question', 'stopped'],
  run: async (world, browser, shots) =>
    withDatabase(world, async db => {
      const openTasks = await db.selectFrom('task').select(['key', 'workflow', 'step']).where('state', '!=', 'done').execute();
      const steps = await db.selectFrom('published_workflow_step').select('name').execute();
      const named = scannedFolders.flatMap(sourceFiles).flatMap(file => {
          const text = readFileSync(join(root, file), 'utf8');
          return steps.filter(step => text.includes(`'${step.name}'`) || text.includes(`"${step.name}"`)).map(step => `${file} names ${step.name}`);
        });
      return open(browser, view(world, '/board'), async ({ page }) => {
        const path = await saved(page, shots, 'u6-board.png');
        const misplaced: string[] = [];
        for (const task of openTasks) {
          const found = await page.locator(`[data-workflow="${task.workflow}"] [data-step="${task.step}"] [data-task="${task.key}"]`).count();
          if (found !== 1) misplaced.push(`${task.key} at ${task.step} shows ${String(found)} times in its column`);
        }
        return [
          misplaced.length === 0 ? pass("every seeded task sits in its step's column", `${String(openTasks.length)} tasks, ${path}`) : fail("every seeded task sits in its step's column", misplaced.join('; ')),
          named.length === 0 ? pass("no step name is written in the page's code", `${String(steps.length)} published step names, none in ${scannedFolders.join(' or ')}`) : fail("no step name is written in the page's code", named.join('; ')),
        ];
      });
    }),
};

const filter: Lane = {
  unit,
  id: '6',
  seeds: ['stopped', 'running', 'done'],
  run: async (world, browser, shots) => {
    const stopped = keyOf(world, 'stopped');
    return withDatabase(world, async db => {
      const person = await personId(db, madeUpPerson);
      await db.updateTable('person').set({ jira_account_id: 'lane-made-up-person' }).where('id', '=', person).execute();
      await db.updateTable('task').set({ assignee_account_id: 'lane-made-up-person' }).where('key', '=', stopped).execute();
      return open(browser, view(world, '/tasks'), async ({ page }) => {
        await page.locator('select[name="person"]').selectOption(person);
        await page.locator('select[name="state"]').selectOption('stopped');
        await page.locator('form[aria-label="Filter tasks"] button[type="submit"]').click();
        await page.waitForURL(url => url.searchParams.get('person') === person);
        const url = new URL(page.url());
        const shown = await attributesOf(page, '[data-task]', 'data-task');
        const path = await saved(page, shots, 'u6-filter.png');
        await page.goto(`${world.origin}/tasks?person=${person}`);
        const personOnly = await attributesOf(page, '[data-task]', 'data-task');
        return [
          url.searchParams.get('state') === 'stopped' && url.searchParams.get('person') === person ? pass('the URL holds the filters', url.search) : fail('the URL holds the filters', url.search),
          shown.join() === stopped ? pass(`only the stopped task of ${madeUpPerson} shows`, `${stopped}, ${path}`) : fail(`only the stopped task of ${madeUpPerson} shows`, shown.join(', ')),
          personOnly.join() === stopped ? pass(`filtering by ${madeUpPerson} alone shows only her task`, stopped) : fail(`filtering by ${madeUpPerson} alone shows only her task`, personOnly.join(', ')),
        ];
      });
    });
  },
};

const emptyPages = ['/', '/tasks', '/board'] as const;

const sentences = (text: string): number => text.split(/(?<=\.)\s+/).filter(each => each.trim() !== '').length;

const empty = (id: string, seed: 'no-routines' | 'no-tasks', shot: string): Lane => ({
  unit,
  id,
  seeds: [seed],
  run: async (world, browser, shots) => {
    const lines: Line[] = [];
    for (const path of emptyPages) {
      lines.push(
        ...(await open(browser, view(world, path), async ({ page }) => {
          const said = await textOf(page, `[data-empty="${seed}"] p`);
          const file = path === '/' ? await saved(page, shots, shot) : '';
          const name = `${path} with ${seed} says what to do next in one sentence`;
          return [said !== '' && sentences(said) === 1 ? pass(name, `${said}${file === '' ? '' : ` ${file}`}`) : fail(name, said === '' ? 'no empty state' : said)];
        })),
      );
    }
    return lines;
  },
});

const login: Lane = {
  unit,
  id: '8',
  seeds: ['login-expired'],
  run: async (world, browser, shots) =>
    open(browser, view(world, '/'), async ({ page }) => {
      const row = '[data-section="logins"] [data-row="login-github"]';
      const said = await textOf(page, row);
      const href = (await page.locator(`${row} a`).count()) === 0 ? null : await page.locator(`${row} a`).getAttribute('href');
      const path = await saved(page, shots, 'u6-login.png');
      const fix = 'GitHub no longer accepts your login, so replace it with a new one.';
      return [
        said.includes(fix) ? pass('the login shows in Needs you with the exact fix', fix) : fail('the login shows in Needs you with the exact fix', said),
        href === '/people?login=github' ? pass('its link goes to the login on the People page', `${href}, ${path}`) : fail('its link goes to the login on the People page', href ?? 'no link'),
      ];
    }),
};

const mergeTime: Lane = {
  unit,
  id: '9',
  seeds: ['done'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'done');
    return withDatabase(world, async db => {
      const span = await db
        .selectFrom('attempt')
        .innerJoin('task', 'task.id', 'attempt.task_id')
        .select(eb => [eb.fn.min('attempt.started_at').as('first'), eb.fn.max('attempt.finished_at').as('last')])
        .where('task.key', '=', key)
        .executeTakeFirstOrThrow();
      const expected = span.last === null ? undefined : new Date(span.last).getTime() - new Date(span.first).getTime();
      return open(browser, view(world, '/tasks?state=landed'), async ({ page }) => {
        const cell = page.locator(`[data-task="${key}"] [data-time]`);
        const shown = (await cell.count()) === 0 ? null : await cell.getAttribute('data-time');
        const said = await textOf(page, `[data-task="${key}"] [data-time]`);
        const path = await saved(page, shots, 'u6-merge-time.png');
        return [
          expected !== undefined && shown === String(expected) ? pass("the done task's time from start to merge matches its attempts in Postgres", `${said}, ${String(expected)} ms from the first attempt's start to the last one's finish, ${path}`) : fail("the done task's time from start to merge matches its attempts in Postgres", `page ${shown ?? 'nothing'}, Postgres ${String(expected)}`),
        ];
      });
    });
  },
};

const video: Lane = {
  unit,
  id: 'video',
  seeds: ['waiting-gate', 'question', 'running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'waiting-gate');
    const folder = join(shots, '..', 'review');
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'u6-review.webm');
    return withDatabase(world, async db => {
      await recording(browser, view(world, '/'), file, async ({ page }) => {
        await wait(6000);
        await stopAndRetry(db, page, key, 5000);
        await until('the gate to come back', async () => ((await page.locator(`[data-section="gates"] [data-row="${key}"]`).count()) === 1 ? true : undefined));
        await wait(5000);
        await page.locator(`[data-action="${key}"]`).hover();
        await wait(1500);
        await page.locator(`[data-action="${key}"]`).click();
        await page.waitForURL(`**/tasks/${key}`);
        await wait(8000);
      });
      return [pass('the review video shows Needs you updating live and a click through to the task', file)];
    });
  },
};

const percentile = (values: readonly number[], share: number): number => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(share * values.length))] ?? Number.NaN;

const perfTasks = 1000;
const perfWaiting = 40;

async function plantTasks(db: Database): Promise<void> {
  const version = await db
    .selectFrom('routine_version')
    .select(['routine_id', 'version', 'workflow', 'needs_repository', 'repository_id'])
    .orderBy('routine_id')
    .limit(1)
    .executeTakeFirstOrThrow();
  const first = await db.selectFrom('published_workflow_step').select('name').where('workflow', '=', version.workflow).orderBy('position').limit(1).executeTakeFirstOrThrow();
  await sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, workflow, needs_repository, step, state, waiting_on, waiting_reason)
    select ${version.routine_id}, ${version.version}, ${version.repository_id}, 'PERF-' || n, 'Perf task ' || n, now() - n * interval '1 minute', ${version.workflow}, ${version.needs_repository}, ${first.name},
      case when n <= ${perfWaiting} then 'waiting'::task_state else 'done'::task_state end,
      case when n <= ${perfWaiting} then 'retry'::waiting_on end,
      case when n <= ${perfWaiting} then 'Nobody to run this task as.' end
    from generate_series(1, ${perfTasks}) as n`.execute(db);
}

async function timings(url: string, times: number, person: string): Promise<readonly number[]> {
  const taken: number[] = [];
  for (let n = -2; n < times; n += 1) {
    const started = performance.now();
    const response = await fetch(url, { headers: { cookie: `autoworker-person=${person}` } });
    await response.arrayBuffer();
    if (n >= 0) taken.push(performance.now() - started);
  }
  return taken;
}

type Base = { readonly origin: string; readonly stop: () => Promise<void> };

async function startBase(folder: string, databaseUrl: string): Promise<Base | undefined> {
  const next = join(folder, 'node_modules/next/dist/bin/next');
  const dashboard = join(folder, 'services/dashboard');
  if (!existsSync(next)) return undefined;
  if (!existsSync(join(dashboard, '.next/BUILD_ID'))) {
    const build = spawn(process.execPath, [next, 'build', dashboard], { cwd: folder, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'inherit' });
    await once(build, 'exit');
    if (build.exitCode !== 0) throw new Error(`next build of the base in ${folder} exited with ${String(build.exitCode)}`);
  }
  const port = 4851;
  const child = spawn(process.execPath, [next, 'start', dashboard, '-p', String(port), '-H', '127.0.0.1'], { cwd: folder, env: { ...process.env, DATABASE_URL: databaseUrl, NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${String(port)}`;
  await until('the base dashboard answering', () => fetch(`${origin}/tasks/NOPE-1`).then(response => (response.status === 404 ? true : undefined), () => undefined), 60_000);
  return {
    origin,
    stop: async () => {
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}

async function waitingPaint(db: Database, world: World, browser: Parameters<Lane['run']>[1]): Promise<number | undefined> {
  return open(browser, view(world, '/'), async ({ page }) => {
    const key = 'PERF-NEW';
    await run(page, watchRow, `[data-row="${key}"]`);
    const template = await db.selectFrom('task').selectAll().where('key', '=', 'PERF-1').executeTakeFirstOrThrow();
    const storedAt = Date.now();
    await db
      .insertInto('task')
      .values({ routine_id: template.routine_id, found_version: template.found_version, repository_id: template.repository_id, key, title: 'A task that just began to wait', found_at: new Date(), workflow: template.workflow, needs_repository: template.needs_repository, step: template.step, state: 'waiting', waiting_on: 'retry', waiting_reason: 'Nobody to run this task as.' })
      .execute();
    const seen = await until('the new waiting task on the page', () => seenAt(page), 10_000).catch(() => undefined);
    return seen === undefined ? undefined : seen - storedAt;
  });
}

const perf: Lane = {
  unit,
  id: 'perf',
  seeds: ['running'],
  run: async (world, browser) => {
    const key = keyOf(world, 'running');
    await world.holdEngine();
    return withDatabase(world, async db => {
      await plantTasks(db);
      const person = await personId(db, actingPerson);
      const count = await db.selectFrom('task').select(eb => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
      const needs = await timings(`${world.origin}/`, 20, person);
      const list = await timings(`${world.origin}/tasks`, 20, person);
      const delay = await waitingPaint(db, world, browser);
      const baseFolder = process.env['BASE_DASHBOARD'];
      const base = baseFolder === undefined ? undefined : await startBase(baseFolder, world.ownerUrl);
      const head: number[] = [];
      const atBase: number[] = [];
      try {
        for (let n = -2; n < 20; n += 1) {
          const [one] = await timings(`${world.origin}/tasks/${key}`, 1, person);
          const [two] = base === undefined ? [] : await timings(`${base.origin}/tasks/${key}`, 1, person);
          if (n >= 0 && one !== undefined) head.push(one);
          if (n >= 0 && two !== undefined) atBase.push(two);
        }
      } finally {
        await base?.stop();
      }
      const summary = (values: readonly number[]): string => `p95 ${percentile(values, 0.95).toFixed(0)} ms, median ${percentile(values, 0.5).toFixed(0)} ms`;
      const slower = atBase.length === 0 ? undefined : percentile(head, 0.5) / percentile(atBase, 0.5) - 1;
      return [
        info('tasks in Postgres', 'n/a', count.count),
        (percentile(needs, 0.95) <= 400 ? pass : fail)('Needs you time to first byte p95 with 1,000 tasks is at most 400 ms', summary(needs)),
        (percentile(list, 0.95) <= 400 ? pass : fail)('the task list time to first byte p95 with 1,000 tasks is at most 400 ms', summary(list)),
        delay !== undefined && delay <= 5000 ? pass('a new waiting task appears within 5 s', `${String(delay)} ms`) : fail('a new waiting task appears within 5 s', delay === undefined ? 'it never appeared' : `${String(delay)} ms`),
        info('/tasks/<key> at head', 'n/a', summary(head)),
        slower === undefined
          ? info("/tasks/<key> slows by at most 10% against U4's commit", 'n/a', 'set BASE_DASHBOARD to a checkout of the base to compare')
          : (slower <= 0.1 ? pass : fail)("/tasks/<key> slows by at most 10% against U4's commit", `head median ${percentile(head, 0.5).toFixed(0)} ms, base median ${percentile(atBase, 0.5).toFixed(0)} ms (${summary(atBase)}), ${(slower * 100).toFixed(1)}%`),
      ];
    });
  },
};

export const lanes: readonly Lane[] = [regression, needsYou, live, failedWaiting, board, filter, empty('7', 'no-routines', 'u6-empty-no-routines.png'), empty('7b', 'no-tasks', 'u6-empty.png'), login, mergeTime, video, perf];
