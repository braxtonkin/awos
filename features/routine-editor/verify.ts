import type { Batch } from '../../tools/verify/batch.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { connect, type Database } from '../../shared/db/client.ts';
import { open, shoot } from '../../tools/verify/browser.ts';
import { fail, pass, type Scenario } from '../../tools/verify/check.ts';
import type { Lane, World } from '../../tools/verify/dashboard.ts';
import { actAs, actingPerson, type Screen } from '../../tools/verify/screens/screens.ts';

const localPeople = ['Braxton Kinney', 'Priya Natarajan', 'Tomás Rivera', 'Mei Chen'];

const routinesScreen = (name: string, path: string, seed: string): Screen => ({ name, group: 'routines', path, seed, steps: [], height: 900, names: localPeople });

export const screens: readonly Screen[] = [
  routinesScreen('routines-list', '/routines', 'no-tasks'),
  routinesScreen('routine-editor', '/routines/1', 'no-tasks'),
  routinesScreen('routine-new', '/routines/new', 'no-tasks'),
];

export const scenarios: readonly Scenario[] = [];

const waitMs = 30_000;

const runMs = 120_000;

async function until<T>(what: string, found: () => Promise<T | undefined>, limitMs = waitMs): Promise<T> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const value = await found();
    if (value !== undefined) return value;
    await wait(250);
  }
  throw new Error(`${what} did not happen within ${String(limitMs / 1000)} s`);
}

const saidIs = (page: Page, selector: string, text: string) => async (): Promise<true | undefined> => {
  const said = page.locator(selector);
  return (await said.count()) > 0 && (await said.first().textContent()) === text ? true : undefined;
};

async function withDatabase<T>(world: World, work: (db: Database) => Promise<T>): Promise<T> {
  const db = connect(world.ownerUrl, 2);
  try {
    return await work(db);
  } finally {
    await db.destroy();
  }
}

const firstGoal = 'Write the release notes for the sandbox.';

const secondGoal = 'Write the release notes for the sandbox, and list each changed file.';

const savedAsVersionTwo: Lane = {
  unit: 'u9',
  id: 'smoke',
  seeds: ['no-tasks'],
  run: async (world, browser, shots) =>
    withDatabase(world, db =>
      open(browser, { url: `${world.origin}/routines/new`, width: 1440, height: 900, theme: 'light', steps: actAs(actingPerson) }, async ({ page, errors }) => {
        await page.locator('#routine-name').fill('Release notes');
        await page.locator('#routine-goal').fill(firstGoal);
        await page.locator('#routine-source').selectOption('schedule');
        await page.locator('#routine-every').fill('60');
        await page.locator('[data-save="button"]').click();
        await until('the new routine to say Saved as version 1', saidIs(page, '[data-save="said"]', 'Saved as version 1'));
        const routine = /\/routines\/(\d+)/.exec(page.url())?.[1];
        if (routine === undefined) throw new Error(`the save went to ${page.url()}, not to the new routine's page`);
        await page.locator('#routine-goal').fill(secondGoal);
        await page.locator('[data-save="button"]').click();
        await until('the editor to say Saved as version 2', saidIs(page, '[data-save="said"]', 'Saved as version 2'));
        await mkdir(shots, { recursive: true });
        await shoot(page, join(shots, 'u9-saved.png'));
        await page.locator('[data-press="run_now"]').click();
        await until('Run now to say it runs on the next pass', saidIs(page, '[data-press="said"]', 'Runs on the next pass'));
        const version = await db
          .selectFrom('routine_version')
          .innerJoin('human_action', 'human_action.id', 'routine_version.action_id')
          .innerJoin('person', 'person.id', 'human_action.person_id')
          .select(['routine_version.goal', 'human_action.kind', 'person.name'])
          .where('routine_version.routine_id', '=', routine)
          .where('routine_version.version', '=', 2)
          .executeTakeFirst();
        const found = await until(
          'the Run now run to find its task',
          async () => {
            const tasks = await db
              .selectFrom('routine_run')
              .innerJoin('task', 'task.routine_id', 'routine_run.routine_id')
              .select(['routine_run.id as run', 'routine_run.version', 'task.key', 'task.found_version'])
              .where('routine_run.routine_id', '=', routine)
              .where('routine_run.reason', '=', 'run_now')
              .where('routine_run.finished_at', 'is not', null)
              .whereRef('task.found_at', '>=', 'routine_run.started_at')
              .execute();
            return tasks.length > 0 ? tasks : undefined;
          },
          runMs,
        );
        const underTwo = found.every(each => each.version === 2 && each.found_version === 2);
        return [
          pass('saving a changed goal shows Saved as version 2', join(shots, 'u9-saved.png')),
          version?.goal === secondGoal && version.kind === 'edit_routine' && version.name === actingPerson
            ? pass("version 2 holds the new goal under Braxton Kinney's edit_routine action", `${version.kind} by ${version.name}`)
            : fail("version 2 holds the new goal under Braxton Kinney's edit_routine action", JSON.stringify(version)),
          underTwo ? pass('the next run records its tasks under version 2', found.map(each => `run ${each.run} version ${String(each.version)}: ${each.key} found under version ${String(each.found_version)}`).join('; ')) : fail('the next run records its tasks under version 2', JSON.stringify(found)),
          errors.length === 0 ? pass('the pages raised no errors', 'none') : fail('the pages raised no errors', errors.join('; ')),
        ];
      }),
    ),
};

export const lanes: readonly Lane[] = [savedAsVersionTwo];

export const batch: Batch = { scenarios: [], engine: [['setup'], ['requests-sim', '--mutant', 'all'], ['routines-sim', '--mutant', 'all']] };
