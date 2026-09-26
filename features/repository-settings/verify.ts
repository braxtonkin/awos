import type { Batch } from '../../tools/verify/batch.ts';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Page } from 'playwright-core';
import { connect, type Database } from '../../shared/db/client.ts';
import { request } from '../../shared/requests.ts';
import { open, shoot, type Theme, type View } from '../../tools/verify/browser.ts';
import { fail, info, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import type { Lane, World } from '../../tools/verify/dashboard.ts';
import { actAs, actingPerson, type Screen } from '../../tools/verify/screens/screens.ts';
import { saveFrom } from './form.ts';

const localPeople = ['Braxton Kinney', 'Priya Natarajan', 'Tomás Rivera', 'Mei Chen'];

const formOf = (fields: Readonly<Record<string, string>>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries({ repository: '1', branch: 'main', verifyProvider: 'tests-only', draftLeaves: 'when-green', ...fields })) form.set(name, value);
  return form;
};

const cases: readonly { readonly name: string; readonly form: FormData; readonly expected: unknown }[] = [
  {
    name: 'an edit with blank commands and two lines of checks parses to nulls and a list',
    form: formOf({ fastTestCommand: '  ', image: '', ignorableChecks: 'lint-docs\n\n  spell \n', ignoredReviewers: '' }),
    expected: {
      saving: {
        target: '1',
        save: {
          github: null,
          branch: 'main',
          image: null,
          fastTestCommand: null,
          setupCommand: null,
          verifyProvider: 'tests-only',
          ignorableChecks: ['lint-docs', 'spell'],
          draftLeaves: 'when-green',
          ignoredReviewers: [],
        },
      },
    },
  },
  {
    name: 'a new repository names no target and carries its owner and name in the save',
    form: formOf({ repository: '', github: ' example/other ' }),
    expected: {
      saving: {
        target: null,
        save: { github: 'example/other', branch: 'main', image: null, fastTestCommand: null, setupCommand: null, verifyProvider: 'tests-only', ignorableChecks: [], draftLeaves: 'when-green', ignoredReviewers: [] },
      },
    },
  },
  {
    name: 'a tagged image is refused on the image field with the shape of a digest',
    form: formOf({ image: 'registry.example.com/ci/node:20' }),
    expected: { problems: { image: 'must name the image by its sha256 digest, as name@sha256:<64 hex digits>, because a tag can move' } },
  },
  {
    name: "a new repository without an owner is refused on the repository field in the field's own words",
    form: formOf({ repository: '', github: 'sandbox' }),
    expected: { problems: { github: 'must name an owner and a repository, such as example/sandbox' } },
  },
  {
    name: 'a blank branch is refused on the branch field',
    form: formOf({ branch: ' ' }),
    expected: { problems: { branch: 'must not be blank' } },
  },
];

const formChecks = (): Promise<readonly Check[]> =>
  Promise.resolve(
    cases.map(({ name, form, expected }) => {
      const got = saveFrom(form);
      return isDeepStrictEqual(got, expected) ? pass(name, JSON.stringify(got)) : fail(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }),
  );

export const scenarios: readonly Scenario[] = [
  {
    name: 'repository-form',
    summary: "parses the repository settings form as the dashboard's save action does, and checks each literal form against the save or the field problems it must give",
    run: formChecks,
  },
];

const settings = (name: string, path: string, steps: Screen['steps'] = []): Screen => ({ name, group: 'settings', path, seed: 'running', steps, height: 900, names: localPeople });

export const screens: readonly Screen[] = [
  settings('repositories-list', '/repositories'),
  settings('repository-settings', '/repositories/1'),
  settings('repository-new', '/repositories/new'),
  settings('repository-digest', '/repositories/1', [{ fill: '#image', text: 'registry.example.com/ci/node:20' }, { click: '[data-save="button"]' }, { waitFor: '[data-problem="image"]' }]),
];

const unit = 'u11';
const width = 1440;
const height = 900;
const waitMs = 30_000;
const verifyWaitMs = 300_000;
const save = '[data-save="button"]';
const said = '[data-save="said"]';

const view = (world: World, path: string, theme: Theme): View => ({ url: `${world.origin}${path}`, width, height, theme, steps: actAs(actingPerson) });

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
    await wait(250);
  }
  throw new Error(`${what} did not happen within ${String(limitMs / 1000)} s`);
}

const saidText = async (page: Page): Promise<string | undefined> => ((await page.locator(said).count()) === 0 ? undefined : ((await page.locator(said).textContent()) ?? undefined));

const saidIs = (page: Page, text: string) => async (): Promise<true | undefined> => ((await saidText(page)) === text ? true : undefined);

const sandbox = async (db: Database): Promise<string> => (await db.selectFrom('repository').select('id').where('github', '=', 'example/sandbox').executeTakeFirstOrThrow()).id;

async function shot(page: Page, shots: string, name: string): Promise<string> {
  await mkdir(shots, { recursive: true });
  const path = join(shots, `${name}.png`);
  await shoot(page, path);
  return path;
}

async function saveAndWait(page: Page): Promise<string> {
  const started = performance.now();
  await page.locator(save).click();
  await until('the page to say Saved', saidIs(page, 'Saved'));
  return `${(performance.now() - started).toFixed(0)} ms`;
}

const actionsOn = (db: Database, repository: string) =>
  db
    .selectFrom('human_action')
    .innerJoin('person', 'person.id', 'human_action.person_id')
    .select(['human_action.id', 'human_action.kind', 'person.name', 'human_action.at'])
    .where('human_action.repository_id', '=', repository)
    .orderBy('human_action.at')
    .execute();

async function nextVerifyPrompt(db: Database, key: string, after: string): Promise<string> {
  return until(
    'the next Verify attempt to receive its prompt',
    async () => {
      const row = await db
        .selectFrom('attempt_command')
        .innerJoin('attempt', 'attempt.id', 'attempt_command.attempt_id')
        .innerJoin('task', 'task.id', 'attempt.task_id')
        .select('attempt_command.input')
        .where('task.key', '=', key)
        .where('attempt.step', '=', 'verify')
        .where('attempt.id', '>', after)
        .where('attempt_command.kind', '=', 'turn.start')
        .orderBy('attempt.id')
        .executeTakeFirst();
      return row?.input ?? undefined;
    },
    verifyWaitMs,
  );
}

const regression: Lane = {
  unit,
  id: '1',
  alone: true,
  seeds: ['failed-behavior'],
  run: async (world, browser, shots) => {
    const key = world.keys.get('failed-behavior');
    if (key === undefined) throw new Error('local-engine printed no key for the seed failed-behavior');
    const command = `npm run test:fast -- --run ${String(Date.now())}`;
    return withDatabase(world, async db => {
      const repository = await sandbox(db);
      const task = await db.selectFrom('task').select('id').where('key', '=', key).executeTakeFirstOrThrow();
      const newest = await db.selectFrom('attempt').select(eb => eb.fn.max('id').as('id')).where('task_id', '=', task.id).executeTakeFirstOrThrow();
      const { took, path } = await open(browser, view(world, `/repositories/${repository}`, 'light'), async ({ page }) => {
        await page.locator('#fastTestCommand').fill(command);
        const ms = await saveAndWait(page);
        return { took: ms, path: await shot(page, shots, 'u11-regression') };
      });
      const actions = await actionsOn(db, repository);
      const edited = actions.at(-1);
      const braxton = await db.selectFrom('person').select('id').where('name', '=', actingPerson).executeTakeFirstOrThrow();
      const retried = await request(db, { id: randomUUID(), person: braxton.id, at: new Date(), kind: 'retry', target: task.id, payload: { note: null } });
      const prompt = await nextVerifyPrompt(db, key, newest.id);
      return [
        info('trunk has no repositories page', 'n/a', 'at trunk the same change goes through the setup file, which the setup scenario proves records edit_repository'),
        pass('saving a new fast test command shows Saved', `${took}, ${path}`),
        edited?.kind === 'edit_repository' && edited.name === actingPerson ? pass("the save records Braxton Kinney's edit_repository", edited.id) : fail("the save records Braxton Kinney's edit_repository", JSON.stringify(edited)),
        'sent' in retried ? info('Retry sent as Braxton Kinney', 'passed', retried.sent) : fail('Retry sent as Braxton Kinney', 'the request id was taken'),
        prompt.includes(command) ? pass("the next Verify attempt's prompt holds the command", command) : fail("the next Verify attempt's prompt holds the command", prompt.slice(0, 400)),
      ];
    });
  },
};

export const lanes: readonly Lane[] = [regression];

export const batch: Batch = { scenarios: [['repository-form']], engine: [['setup'], ['requests-sim', '--mutant', 'all']] };
