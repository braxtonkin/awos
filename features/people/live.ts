import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Page } from 'playwright-core';
import { open, shoot, withBrowser } from '../../tools/verify/browser.ts';
import { fail, info, pass, type Line, type Scenario } from '../../tools/verify/check.ts';
import { buildDashboard, withWorld, type Lane, type World } from '../../tools/verify/dashboard.ts';
import { actAs, actingPerson } from '../../tools/verify/screens/screens.ts';

const width = 1440;
const height = 900;
const waitMs = 30_000;
const checkedWithinMs = 60_000;
const acceptedByFakeGitHub = 'fake-github-token';
const actingRow = `[data-name="${actingPerson}"]`;
const githubSaid = `${actingRow} [data-said="github"]`;
const githubForm = `${actingRow} [data-login-form="github"]`;

const peopleView = (world: World, path: string) => ({ url: `${world.origin}${path}`, width, height, theme: 'light' as const, steps: actAs(actingPerson) });

async function replaceGithub(page: Page, world: World, token: string): Promise<{ readonly answer: string; readonly field: string; readonly said: string }> {
  await page.goto(`${world.origin}/people?login=github`, { waitUntil: 'load' });
  await page.locator(`${githubForm} [name="secret"]`).fill(token);
  await page.locator(`${githubForm} button[type="submit"]`).click();
  const answer = await page
    .locator(`${githubForm} [data-replaced="github"]`, { hasText: /\S/ })
    .waitFor({ timeout: waitMs })
    .then(
      () => page.locator(`${githubForm} [data-replaced="github"]`).innerText(),
      () => `nothing after ${String(waitMs / 1000)} s`,
    );
  return { answer: answer.trim(), field: await page.locator(`${githubForm} [name="secret"]`).inputValue(), said: (await page.locator(githubSaid).innerText()).trim() };
}

const replacerOf = async (world: World): Promise<string | null> => {
  const found = await sql<{ name: string }>`select replacer.name from credential join person owner on owner.id = credential.person_id join human_action on human_action.id = credential.action_id join person replacer on replacer.id = human_action.person_id where owner.name = ${actingPerson} and credential.connector = 'github'`.execute(world.owner);
  return found.rows[0]?.name ?? null;
};

const replacesAndChecks: Lane = {
  unit: 'u10',
  id: '3',
  seeds: ['no-tasks'],
  run: async (world, browser, shots) =>
    open(browser, peopleView(world, '/people'), async ({ page, errors }) => {
      const { answer, field, said } = await replaceGithub(page, world, acceptedByFakeGitHub);
      const works = await page
        .locator(githubSaid, { hasText: 'Works. Checked' })
        .waitFor({ timeout: checkedWithinMs })
        .then(
          () => true,
          () => false,
        );
      const after = (await page.locator(githubSaid).innerText()).trim();
      await mkdir(shots, { recursive: true });
      const path = join(shots, 'u10-replace.png');
      await shoot(page, path);
      const by = await replacerOf(world);
      return [
        (answer.startsWith('Saved') ? pass : fail)('Save answers Saved', answer),
        (field === '' ? pass : fail)('the field clears after the save', field === '' ? 'empty' : 'still holds text'),
        (/^Replaced by BK at \d\d:\d\d\. Checking\.$/.test(said) ? pass : fail)('the login reads Replaced by BK at a time, then Checking', said),
        (works ? pass : fail)('the login reads Works once the engine checks it', `${after}, ${path}`),
        (by === actingPerson ? pass : fail)('the replacement records Braxton Kinney as the actor', by ?? 'nobody'),
        (errors.length === 0 ? pass : fail)('the page raised no errors', errors.join('; ') || 'none'),
      ];
    }),
};

export const loginLanes: readonly Lane[] = [replacesAndChecks];

type Heard = { readonly where: string; readonly body: string };

const holders = (heard: readonly Heard[], value: string): readonly string[] => heard.filter(each => each.body.includes(value)).map(each => each.where);

async function neverShown(world: World, dashboardSaid: () => string): Promise<readonly Line[]> {
  const token = `made-up-token-${randomBytes(12).toString('hex')}`;
  return withBrowser(browser =>
    open(browser, peopleView(world, '/people'), async ({ page }) => {
      const responses: Promise<Heard>[] = [];
      page.on('response', response => {
        const where = `${response.request().method()} ${response.url()} ${String(response.status())}`;
        responses.push(response.text().then(body => ({ where, body }), () => ({ where, body: '' })));
      });
      const { answer, field } = await replaceGithub(page, world, token);
      await page.reload({ waitUntil: 'load' });
      const html = await page.content();
      const heard = await Promise.all(responses);
      const actions = heard.filter(each => each.where.startsWith('POST '));
      const sealed = await sql<{ ciphertext: Buffer }>`select credential.ciphertext from credential join person on person.id = credential.person_id where person.name = ${actingPerson} and credential.connector = 'github'`.execute(world.owner);
      const stored = sealed.rows[0]?.ciphertext;
      const leaks = [
        { name: "the page's HTML", found: html.includes(token) },
        { name: `${String(heard.length)} responses, ${String(actions.length)} of them server action posts`, found: holders(heard, token).length > 0 },
        { name: "the dashboard's logs", found: dashboardSaid().includes(token) },
        { name: "the engine's logs", found: world.engineSaid().includes(token) },
      ];
      await sql`update person set name = ${token} where kind = 'shared'`.execute(world.owner);
      await page.reload({ waitUntil: 'load' });
      const planted = (await page.content()).includes(token);
      return [
        (answer.startsWith('Saved') ? pass : fail)('the dashboard saved the made-up token', answer),
        (actions.length > 0 ? pass : fail)('the save went through a server action whose response was read', actions.map(each => each.where).join('; ') || 'no POST'),
        (field === '' ? pass : fail)('the field clears after the save', field === '' ? 'empty' : 'still holds text'),
        (stored !== undefined && !stored.includes(token) ? pass : fail)('Postgres holds the token sealed, not as text', stored === undefined ? 'no credential row' : `${String(stored.length)} bytes`),
        ...leaks.map(leak => (leak.found ? fail : pass)(`the token never shows in ${leak.name}`, leak.found ? `${leak.name} holds the token: ${holders(heard, token).join('; ')}` : 'not found')),
        (planted ? pass : fail)('a plant that echoes the token into the page is caught', planted ? "the search found the token once a team account's name held it" : 'the search missed a planted echo'),
      ];
    }),
  );
}

export const loginNeverShown: Scenario = {
  name: 'login-never-shown',
  summary: "replaces Braxton Kinney's GitHub token from /people with a made-up value through the running dashboard, then searches the page's HTML, every response the browser read, server action posts included, and the dashboard's and engine's logs for it, and fails on any match; a plant that writes the value into a team account's name must be caught",
  run: async () => {
    const said: string[] = [];
    const echo = (line: string): void => {
      said.push(line);
      process.stdout.write(`${line.includes('made-up-token-') ? '[a line that holds the made-up token]' : line}\n`);
    };
    const built = await buildDashboard(false, echo);
    const lines = await withWorld(['no-tasks'], echo, world => neverShown(world, () => said.filter(line => line.startsWith('dashboard: ')).join('\n')));
    return [info('next build', 'passed', built.seconds === undefined ? built.output : `${built.seconds.toFixed(1)} s`), ...lines];
  },
};
