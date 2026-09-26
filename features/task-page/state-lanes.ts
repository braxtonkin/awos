import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { reproduction } from '../../shared/reproduction.ts';
import { open, shoot } from '../../tools/verify/browser.ts';
import { fail, pass, type Line } from '../../tools/verify/check.ts';
import type { Lane } from '../../tools/verify/dashboard.ts';
import { actingPerson } from '../../tools/verify/screens/screens.ts';
import { keyOf, until, view, withDatabase } from './lanes.ts';

const unit = 'u8';
const seed = 'waiting-gate';
const conflictSeed = 'failed-after-conflict';
const stepsList = 'ol[aria-label="Steps"] > li';
const approveButton = '[aria-label="Open review"] [data-act="approve"]';
const movesOnMs = 60_000;
const failedThrice = 'The Implement step failed 3 times in a row.';
const story = 'pass pass pass handed_off red_check fail fail fail';
const reproduced = 'The reproduction failed on the base commit (exit 1) and passed on the change (exit 0).';
const noChange = 'The agent made no change.';
const conflict = 'conflicts with its base branch';
const laterResults = 'Passed, Sent back';
const recorded = z.object({ summary: z.string(), blocks: z.array(z.unknown()) });
const textBlock = z.object({ kind: z.literal('text'), body: z.string() });
const closedToggle = 'details:not([open]) > summary';
const openLimit = 40;

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

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const textsOf = async (page: Page, attribute: string): Promise<ReadonlyMap<string, string>> =>
  new Map(await Promise.all((await page.locator(`[${attribute}]`).all()).map(async element => [(await element.getAttribute(attribute)) ?? '', oneLine(await element.innerText())] as const)));

async function showTab(page: Page, tab: string): Promise<void> {
  await page.locator(`[data-tab="${tab}"]`).click();
  await page.locator(`[data-tab="${tab}"][aria-selected="true"]`).waitFor();
}

async function openAll(page: Page, scope: string): Promise<void> {
  const closed = page.locator(`${scope} ${closedToggle}`);
  for (let opened = 0; opened < openLimit && (await closed.count()) > 0; opened += 1) await closed.first().click();
  const unrendered = page.locator(`${scope} details[open]:not(:has(> :not(summary)))`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await unrendered.count()) > 0) await page.waitForTimeout(50);
}

const wordsOf = (output: unknown): readonly string[] => {
  const parsed = recorded.safeParse(output);
  return parsed.success ? [parsed.data.summary, ...parsed.data.blocks.flatMap(block => textBlock.safeParse(block).data?.body ?? [])].map(oneLine).filter(words => words !== '') : [];
};

const reasons: Lane = {
  unit,
  id: 'reasons',
  seeds: [conflictSeed],
  run: async (world, browser, shots) => {
    const key = keyOf(world, conflictSeed);
    await mkdir(shots, { recursive: true });
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}`, 'light', true), async ({ page, errors }) => {
        const saved = async (name: string): Promise<string> => {
          const path = join(shots, name);
          await shoot(page, path);
          return path;
        };
        const shotPaths = [await saved('u8-reasons.png')];
        const card = oneLine((await page.locator('[aria-label="Status"]').allInnerTexts()).join(' '));
        const headline = oneLine((await page.locator('[data-card="headline"]').allInnerTexts()).join(' '));
        const repeats = headline === '' ? 0 : await page.locator('[aria-label="Agent"]').getByText(headline, { exact: true }).count();
        const shownBar = await Promise.all((await page.locator(stepsList).all()).map(async step => ({ state: await step.getAttribute('data-step-state'), label: oneLine(await step.locator(':scope > span').last().innerText()) })));
        await showTab(page, 'attempts');
        shotPaths.push(await saved('u8-reasons-attempts.png'));
        const closedRows = await textsOf(page, 'data-attempt-row');
        await openAll(page, '[data-attempt-row]');
        shotPaths.push(await saved('u8-reasons-attempts-open.png'));
        const openedRows = await textsOf(page, 'data-attempt-row');
        await showTab(page, 'evidence');
        shotPaths.push(await saved('u8-reasons-evidence.png'));
        const closedArticles = await textsOf(page, 'data-evidence');
        await openAll(page, '[data-evidence]');
        shotPaths.push(await saved('u8-reasons-evidence-open.png'));
        const openedArticles = await textsOf(page, 'data-evidence');
        const task = await db.selectFrom('task').select(['task.id', 'task.state', 'task.step', 'task.waiting_on', 'task.waiting_reason', 'task.workflow']).where('task.key', '=', key).executeTakeFirstOrThrow();
        const attempts = await db.selectFrom('attempt').select(['attempt.id', 'attempt.step', 'attempt.verdict', 'attempt.output', 'attempt.finished_at']).where('attempt.task_id', '=', task.id).orderBy('attempt.id').execute();
        const steps = await db.selectFrom('published_workflow_step').select('published_workflow_step.name').where('published_workflow_step.workflow', '=', task.workflow).orderBy('published_workflow_step.position').execute();
        const evidence = await db.selectFrom('evidence').select(['evidence.attempt_id', 'evidence.body']).where('evidence.task_id', '=', task.id).orderBy('evidence.attempt_id').execute();
        const reason = task.waiting_reason ?? '';
        const named = task.state === 'waiting' && task.waiting_on === 'retry' && reason.startsWith(failedThrice) && task.step === attempts.at(-1)?.step && attempts.map(each => each.verdict ?? 'live').join(' ') === story;
        const tried = new Set(attempts.map(each => each.step));
        const current = steps.findIndex(each => each.name === task.step);
        const bar = steps.map((each, index) => ({ tried: tried.has(each.name), after: index > current, state: shownBar[index]?.state ?? null, label: shownBar[index]?.label ?? '' }));
        const barText = bar.map((each, index) => `${steps[index]?.name ?? '?'} ${each.label} [${each.state ?? 'missing'}]`).join(', ');
        const later = bar.filter(each => each.tried && each.after).map(each => each.label).join(', ');
        const expectedClosed = attempts.flatMap(each => (each.verdict === 'red_check' ? [{ id: each.id, says: conflict }] : each.verdict === 'fail' ? [{ id: each.id, says: noChange }] : []));
        const unsaid = expectedClosed.filter(each => !(closedRows.get(each.id) ?? '').toLowerCase().includes(each.says.toLowerCase()));
        const reddened = [...closedRows.values(), ...openedRows.values()].filter(row => /a check on the pull request went red/i.test(row));
        const recordedWords = attempts.filter(each => each.finished_at !== null).map(each => ({ id: each.id, words: wordsOf(each.output) }));
        const unshown = recordedWords.flatMap(each => each.words.filter(words => !(openedRows.get(each.id) ?? '').includes(words)).map(words => `row ${each.id} lacks "${words}"`));
        const ran = evidence.flatMap(each => {
          const parsed = reproduction.safeParse(each.body);
          return parsed.success && parsed.data.state === 'ran' ? [{ id: each.attempt_id, data: parsed.data }] : [];
        });
        const reproducedAt = ran[0];
        const closedArticle = reproducedAt === undefined ? '' : (closedArticles.get(reproducedAt.id) ?? '');
        const openedArticle = reproducedAt === undefined ? '' : (openedArticles.get(reproducedAt.id) ?? '');
        const details = reproducedAt === undefined ? [] : [oneLine(reproducedAt.data.script), reproducedAt.data.base.commit, reproducedAt.data.change.commit];
        const undisclosed = details.filter(each => !openedArticle.includes(each));
        const taken = shotPaths.join(', ');
        return [
          check(named, 'the seed reads back as named', `${key} ${task.state} at ${task.step}, waiting on ${task.waiting_on ?? 'nothing'}: ${reason}; attempts: ${attempts.map(each => `${each.step} ${each.verdict ?? 'live'}`).join(', ')}`),
          check(card.toLowerCase().includes(noChange.toLowerCase()), 'the status card says the agent made no change', card),
          check(card.includes(conflict), 'the status card names the conflict with the base branch', card),
          check(card !== '' && !/a check on the pull request/i.test(card), 'the status card does not call the conflict a red check', card),
          check(/^[^.]+\.$/.test(headline), "the status card's headline is one sentence", headline),
          check(headline !== '' && repeats === 0, 'the agent panel does not repeat the headline', `${String(repeats)} copies in the panel`),
          check(bar.length > 0 && bar.every(each => !each.tried || (each.state !== null && each.state !== 'next')), 'the step bar marks no step that has an attempt as not yet', barText),
          check(later === laterResults, 'the step bar shows the last result of each step that ran after the current one', `${later === '' ? 'nothing' : later}, expected ${laterResults}; ${barText}`),
          check(expectedClosed.length > 0 && unsaid.length === 0, 'a closed row says why its attempt failed or sent the task back', unsaid.length === 0 ? expectedClosed.map(each => `row ${each.id}: ${closedRows.get(each.id) ?? ''}`).join('; ') : unsaid.map(each => `row ${each.id} "${closedRows.get(each.id) ?? ''}" lacks "${each.says}"`).join('; ')),
          check(closedRows.size > 0 && reddened.length === 0, 'no attempt row says a check on the pull request went red', reddened.length === 0 ? `${String(closedRows.size)} rows, none says it` : reddened.join('; ')),
          check(recordedWords.some(each => each.words.length > 0) && unshown.length === 0, "each finished attempt's row, opened, shows its stored summary and body", unshown.length === 0 ? `${String(recordedWords.length)} rows show their words` : unshown.join('; ')),
          check(closedArticle.includes(reproduced), 'the evidence says the reproduction failed on the base commit and passed on the change', closedArticle === '' ? 'no reproduction article' : closedArticle),
          check(closedArticle !== '' && !closedArticle.includes('›'), 'the evidence shows no key paths', closedArticle === '' ? 'no reproduction article' : closedArticle),
          check(details.length > 0 && undisclosed.length === 0, "the reproduction's details show the script and both commits", undisclosed.length === 0 ? 'script, base commit, and change commit shown' : `missing ${undisclosed.join(', ')}`),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? taken : `${errors.join('; ')} (${taken})`),
        ];
      }),
    );
  },
};

export const stateLanes: readonly Lane[] = [smoke, reasons];
