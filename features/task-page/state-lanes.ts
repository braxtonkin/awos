import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { open, shoot } from '../../tools/verify/browser.ts';
import { fail, pass, type Line } from '../../tools/verify/check.ts';
import type { Lane } from '../../tools/verify/dashboard.ts';
import { actingPerson } from '../../tools/verify/screens/screens.ts';
import { keyOf, until, view, withDatabase } from './lanes.ts';

const unit = 'u8';
const seed = 'waiting-gate';
const stepsList = 'ol[aria-label="Steps"] > li';
const approveButton = '[aria-label="Open review"] [data-act="approve"]';
const movesOnMs = 60_000;

const check = (passed: boolean, name: string, detail: string): Line => (passed ? pass : fail)(name, detail);

const currentIndex = async (page: Page): Promise<number> => {
  const states = await Promise.all((await page.locator(stepsList).all()).map(async step => (await step.getAttribute('aria-current')) === 'step'));
  return states.indexOf(true);
};

const smoke: Lane = {
  unit,
  id: 'smoke',
  seeds: [seed],
  run: async (world, browser, shots) => {
    const key = keyOf(world, seed);
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        const headline = (await page.locator('[data-card="headline"]').textContent()) ?? '';
        const instruction = (await page.locator('[data-card="instruction"]').textContent()) ?? '';
        const before = await currentIndex(page);
        const waitingState = before < 0 ? null : await page.locator(stepsList).nth(before).getAttribute('data-step-state');
        await mkdir(shots, { recursive: true });
        const waitingShot = join(shots, 'u8-smoke-gate.png');
        await shoot(page, waitingShot);
        const pressedAt = new Date();
        await page.locator(approveButton).click();
        const after = await until('the stepper to move on to the next step', async () => {
          const index = await currentIndex(page);
          return index > before ? index : undefined;
        }, movesOnMs);
        const movedShot = join(shots, 'u8-smoke.png');
        await shoot(page, movedShot);
        const task = await db.selectFrom('task').select(['task.id', 'task.step', 'task.waiting_reason']).where('task.key', '=', key).executeTakeFirstOrThrow();
        const approval = await db
          .selectFrom('human_action')
          .innerJoin('person', 'person.id', 'human_action.person_id')
          .select('person.name')
          .where('human_action.task_id', '=', task.id)
          .where('human_action.kind', '=', 'approve')
          .where('human_action.at', '>=', new Date(pressedAt.getTime() - 5_000))
          .executeTakeFirst();
        const shownStep = (await page.locator(stepsList).nth(after).locator('span').first().textContent()) ?? '';
        return [
          check(headline.startsWith('Waiting for your approval of '), 'the status card reads that the task waits for your approval', headline),
          check(instruction.trim() !== '', "the card gives the engine's waiting reason as its instruction", instruction),
          check(waitingState === 'waiting', 'the stepper marks the gated step as waiting', `step ${String(before)} is ${waitingState ?? 'missing'}`),
          check(after === before + 1, 'Approve moves the stepper on to the next step', `from step ${String(before)} to step ${String(after)}`),
          check(shownStep.toLowerCase() === task.step.toLowerCase(), "the stepper's current step is the task's step in Postgres", `page ${shownStep}, Postgres ${task.step}`),
          check(approval?.name === actingPerson, 'the approval is recorded as Braxton Kinney', approval?.name ?? 'no approval'),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? `${waitingShot}, ${movedShot}` : errors.join('; ')),
        ];
      }),
    );
  },
};

export const stateLanes: readonly Lane[] = [smoke];
