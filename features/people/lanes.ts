import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Page } from 'playwright-core';
import { open, run, shoot, type Script, type Step } from '../../tools/verify/browser.ts';
import { fail, info, pass } from '../../tools/verify/check.ts';
import type { Lane, World } from '../../tools/verify/dashboard.ts';
import { readLimits } from '../../tools/verify/screens/gates.ts';
import { actAs, actingPerson, capture, gateLines } from '../../tools/verify/screens/screens.ts';

const unit = 'u5';
const width = 1440;
const height = 900;
const waitMs = 30_000;
const menu = 'summary[aria-label="Acting as"]';
const stop = '[data-stop="button"]';
const said = '[data-stop="said"]';
const madeUp = { name: 'Ada Quinn', email: 'ada.quinn@example.com' };

export const seededAccounts = [
  { name: 'Braxton Kinney', kind: 'Person' },
  { name: 'Mei Chen', kind: 'Person' },
  { name: 'Priya Natarajan', kind: 'Person' },
  { name: 'Tomás Rivera', kind: 'Person' },
  { name: 'Release team', kind: 'Team account' },
] as const;

export const seededNames = seededAccounts.map(account => account.name);

const keyOf = (world: World, seed: string): string => {
  const key = world.keys.get(seed);
  if (key === undefined) throw new Error(`local-engine printed no key for the seed ${seed}`);
  return key;
};

const opened = (world: World, path: string, steps: readonly Step[], wide = width) => ({ url: `${world.origin}${path}`, width: wide, height, theme: 'light' as const, steps });

const menuText = async (page: Page): Promise<string> => (await page.locator(menu).innerText()).replace(/\s+/g, ' ').trim();

async function snap(page: Page, shots: string, name: string): Promise<string> {
  await mkdir(shots, { recursive: true });
  const path = join(shots, `${name}.png`);
  await shoot(page, path);
  return path;
}

async function pressStop(page: Page, expected: string): Promise<string> {
  await page.locator(stop).click();
  const answered = await page
    .locator(said, { hasText: expected })
    .waitFor({ timeout: waitMs })
    .then(() => true, () => false);
  return answered ? expected : `${(await page.locator(said).textContent()) ?? 'nothing'} after ${String(waitMs / 1000)} s`;
}

const stopperOf = async (world: World, key: string): Promise<string | null> => {
  const found = await sql<{ name: string | null }>`select person.name from task left join human_action on human_action.id = task.stopped_by left join person on person.id = human_action.person_id where task.key = ${key}`.execute(world.owner);
  return found.rows[0]?.name ?? null;
};

const requestCount = async (world: World, key: string): Promise<number> => {
  const found = await sql<{ count: string }>`select count(*)::text as count from person_request join task on task.id = person_request.task_id where task.key = ${key}`.execute(world.owner);
  return Number(found.rows[0]?.count ?? 'NaN');
};

const withoutInitials = (text: string): string => text.replace(/^\s*[A-Z]{1,2}\s*(?=[A-Z])/, '').trim();

const menuNames = async (page: Page): Promise<readonly string[]> => (await page.locator('[role="menuitemradio"]').allTextContents()).map(withoutInitials);

const regression: Lane = {
  unit,
  id: '1',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    return open(browser, opened(world, `/tasks/${key}`, actAs(actingPerson)), async ({ page, errors }) => {
      const answer = await pressStop(page, 'Stopped');
      const path = await snap(page, shots, 'u5-regression');
      const by = await stopperOf(world, key);
      return [
        info('the trunk side is U4', 'n/a', 'run npm run verify -- dashboard-lane u4 1 at the U4 commit to record the stop under Braxton Kinney there'),
        (answer === 'Stopped' ? pass : fail)('Stop answers Stopped', answer),
        (by === actingPerson ? pass : fail)('the stop is recorded under Braxton Kinney', by ?? 'nobody'),
        (errors.length === 0 ? pass : fail)('the page raised no errors', errors.length === 0 ? path : errors.join('; ')),
      ];
    });
  },
};

const switchPerson: Lane = {
  unit,
  id: '2',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    const other = 'Priya Natarajan';
    return open(browser, opened(world, `/tasks/${key}`, [...actAs(actingPerson), ...actAs(other)]), async ({ page }) => {
      const shown = await menuText(page);
      const answer = await pressStop(page, 'Stopped');
      const path = await snap(page, shots, 'u5-switch');
      const by = await stopperOf(world, key);
      return [
        (shown.includes('PN') && shown.includes(other) ? pass : fail)('the top bar names the picked person with their initials', shown),
        (answer === 'Stopped' ? pass : fail)('Stop answers Stopped', answer),
        (by === other ? pass : fail)('the human_action names the picked person', `${by ?? 'nobody'}, ${path}`),
      ];
    });
  },
};

const peopleListed: Lane = {
  unit,
  id: '4',
  seeds: ['no-tasks'],
  run: async (world, browser, shots) => {
    const limits = await readLimits();
    const taken = await capture(browser, { name: 'u5-people-gates', url: `${world.origin}/people`, steps: actAs(actingPerson), height, names: seededNames }, limits, shots);
    await copyFile(taken.shots.light, join(shots, 'u5-people.png'));
    return open(browser, opened(world, '/people', actAs(actingPerson)), async ({ page, errors }) => {
      const bar = await menuText(page);
      const rows = await page.locator('[data-people="table"] tbody tr').all();
      const stored = await sql<{ name: string }>`select name from person order by name`.execute(world.owner);
      const byName = new Map(await Promise.all(rows.map(async row => [(await row.getAttribute('data-name')) ?? '', (await row.locator('td').last().innerText()).trim()] as const)));
      const wrongKinds = seededAccounts.flatMap(account => (byName.get(account.name) === account.kind ? [] : [`${account.name} shows ${byName.get(account.name) ?? 'nothing'}, not ${account.kind}`]));
      const missing = stored.rows.filter(row => !byName.has(row.name)).map(row => row.name);
      return [
        (bar.includes('BK') && bar.includes(actingPerson) ? pass : fail)('the top bar reads Acting as BK', bar),
        (missing.length === 0 && rows.length === stored.rows.length ? pass : fail)('/people lists every person the database holds', missing.length === 0 ? `${String(rows.length)} rows: ${[...byName.keys()].join(', ')}` : `missing ${missing.join(', ')}`),
        (wrongKinds.length === 0 ? pass : fail)('each seeded person shows their kind in words, and the team account is marked', wrongKinds.length === 0 ? seededAccounts.map(account => `${account.name}: ${account.kind}`).join(', ') : wrongKinds.join('; ')),
        (errors.length === 0 ? pass : fail)('the page raised no errors', errors.length === 0 ? join(shots, 'u5-people.png') : errors.join('; ')),
        ...gateLines(taken, limits),
      ];
    });
  },
};

const gone: Lane = {
  unit,
  id: '5',
  seeds: ['running'],
  run: async (world, browser, shots) => {
    const key = keyOf(world, 'running');
    await sql`insert into person (email, name) values (${madeUp.email}, ${madeUp.name})`.execute(world.owner);
    return open(browser, opened(world, `/tasks/${key}`, actAs(madeUp.name)), async ({ page }) => {
      await sql`delete from person where email = ${madeUp.email}`.execute(world.owner);
      await page.reload({ waitUntil: 'load' });
      const shown = await menuText(page);
      const answer = await pressStop(page, 'Pick who you are first');
      const path = await snap(page, shots, 'u5-gone');
      const requests = await requestCount(world, key);
      return [
        (shown.includes('Pick who you are') ? pass : fail)('the menu asks who you are once the picked person is gone', shown),
        (answer === 'Pick who you are first' ? pass : fail)('Stop asks who you are instead of acting', answer),
        (requests === 0 ? pass : fail)('no request was sent', `${String(requests)} requests, ${path}`),
      ];
    });
  },
};

const noTeam: Lane = {
  unit,
  id: '6',
  seeds: ['no-tasks'],
  run: async (world, browser, shots) =>
    open(browser, opened(world, '/people', [...actAs(actingPerson), { click: menu }]), async ({ page }) => {
      const offered = await menuNames(page);
      const path = await snap(page, shots, 'u5-no-team');
      const stored = await sql<{ name: string; kind: string }>`select name, kind::text as kind from person order by name`.execute(world.owner);
      const people = stored.rows.filter(row => row.kind === 'person').map(row => row.name);
      const teams = stored.rows.filter(row => row.kind === 'shared').map(row => row.name);
      return [
        (teams.length > 0 ? pass : fail)('the world holds a team account to leave out', teams.join(', ') || 'none'),
        (offered.every(name => !teams.includes(name)) ? pass : fail)('no team account is offered', offered.join(', ')),
        (JSON.stringify(offered) === JSON.stringify(people) ? pass : fail)('the menu offers every person, in order', `${offered.join(', ')}, ${path}`),
      ];
    }),
};

type FocusWindow = { readonly document: { readonly activeElement: { readonly tagName: string; readonly textContent: string | null } | null }; getComputedStyle(element: unknown): { readonly outlineStyle: string; readonly outlineWidth: string } };

type Focused = { readonly tag: string; readonly text: string; readonly visible: boolean };

const focused: Script<FocusWindow, null, Focused> = window => {
  const element = window.document.activeElement;
  if (element === null) return { tag: 'none', text: '', visible: false };
  const style = window.getComputedStyle(element);
  return { tag: element.tagName, text: (element.textContent ?? '').trim(), visible: style.outlineStyle !== 'none' && style.outlineWidth !== '0px' };
};

const readFocus = async (page: Page): Promise<Focused> => {
  const found = await run(page, focused, null);
  return typeof found === 'object' && found !== null && 'tag' in found && 'text' in found && 'visible' in found ? { tag: String(found.tag), text: String(found.text), visible: found.visible === true } : { tag: 'unknown', text: '', visible: false };
};

async function tabTo(page: Page, wanted: (focus: Focused) => boolean, steps: Focused[]): Promise<boolean> {
  for (let presses = 0; presses < 30; presses += 1) {
    await page.keyboard.press('Tab');
    const focus = await readFocus(page);
    steps.push(focus);
    if (wanted(focus)) return true;
  }
  return false;
}

const keyboard: Lane = {
  unit,
  id: '7',
  seeds: ['no-tasks'],
  run: async (world, browser, shots) =>
    open(browser, opened(world, '/people', []), async ({ page }) => {
      const steps: Focused[] = [];
      const onMenu = await tabTo(page, focus => focus.tag === 'SUMMARY', steps);
      await page.keyboard.press('Enter');
      const onPerson = await tabTo(page, focus => focus.tag === 'BUTTON' && focus.text.endsWith(actingPerson), steps);
      await page.keyboard.press('Enter');
      await page.locator(`${menu}:has-text("${actingPerson}")`).waitFor({ timeout: waitMs });
      const path = await snap(page, shots, 'u5-keyboard');
      const hidden = steps.filter(focus => !focus.visible).map(focus => `${focus.tag} ${focus.text}`);
      return [
        (onMenu ? pass : fail)('Tab reaches the Acting as menu', steps.map(focus => focus.tag).join(' ')),
        (onPerson ? pass : fail)('Tab reaches Braxton Kinney in the open menu', steps.map(focus => focus.text).join(' | ')),
        (hidden.length === 0 ? pass : fail)('focus is visible at every step', hidden.length === 0 ? `${String(steps.length)} steps` : hidden.join('; ')),
        pass('Enter picks the person', `${await menuText(page)}, ${path}`),
      ];
    }),
};

type WidthWindow = { readonly document: { readonly documentElement: { readonly scrollWidth: number; readonly clientWidth: number } } };

const overflow: Script<WidthWindow, null, number> = window => window.document.documentElement.scrollWidth - window.document.documentElement.clientWidth;

const narrow: Lane = {
  unit,
  id: '8',
  seeds: ['no-tasks'],
  run: async (world, browser, shots) => {
    const wide = 1024;
    const limits = await readLimits();
    const taken = await capture(browser, { name: 'u5-narrow-gates', url: `${world.origin}/people`, steps: actAs(actingPerson), height, names: seededNames }, { ...limits, width: wide }, shots);
    await copyFile(taken.shots.light, join(shots, 'u5-narrow.png'));
    const sideways = await open(browser, opened(world, '/people', actAs(actingPerson), wide), async ({ page }) => Number(await run(page, overflow, null)));
    return [(sideways <= 0 ? pass : fail)('nothing overflows sideways at 1024 pixels', `${String(sideways)} px past the viewport`), ...gateLines(taken, limits)];
  },
};

export const lanes: readonly Lane[] = [regression, switchPerson, peopleListed, gone, noTeam, keyboard, narrow];
