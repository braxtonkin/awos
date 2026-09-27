import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { reduce } from '../../shared/items.ts';
import { reproduction } from '../../shared/reproduction.ts';
import { reworkObligation } from '../../shared/rework.ts';
import { open, shoot } from '../../tools/verify/browser.ts';
import { fail, pass, type Line } from '../../tools/verify/check.ts';
import type { Lane } from '../../tools/verify/dashboard.ts';
import { actingPerson } from '../../tools/verify/screens/screens.ts';
import { keyOf, until, view, withDatabase } from './lanes.ts';
import { reviewOf } from './now.ts';

const unit = 'u8';
const seed = 'waiting-gate';
const conflictSeed = 'failed-after-conflict';
const redCheckSeed = 'failed-after-red-check';
const behaviorSeed = 'failed-behavior';
const redCheckStory = 'pass pass pass handed_off red_check pass pass handed_off red_check fail fail fail';
const redCheck = 'a check failed: check';
const owedCheck = 'the failed check `check`';
const pushedNothing = `Implement pushed nothing, though the task came back to fix ${owedCheck}.`;
const foundNothing = 'found nothing to change';
const stillRunning = 'Still running';
const retryButton = '[data-retry="send"]';
const claimMs = 120_000;
const runsMs = 8 * 60_000;
const catchUpMs = 10_000;
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
        const reply = await replyOf(db, attempts.at(-1));
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
          check(headline.includes(foundNothing), 'the status card says the agent found nothing to change', card),
          check(reply !== undefined && card.includes(`“${reply}”`), "the status card quotes the agent's own last message", `${card} | the agent said: ${reply ?? 'nothing'}`),
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

type Stored = { readonly id: string; readonly step: string; readonly verdict: string | null; readonly finished: boolean; readonly owes: string | null };

const owedOf = (obligation: unknown): string | null => {
  const owed = reworkObligation.safeParse(obligation).data;
  if (owed === undefined) return null;
  return owed.kind === 'check' ? `the failed check ${owed.checks.map(each => `\`${each.name}\``).join(', ')}` : `a ${owed.kind}`;
};

const storedAttempts = async (db: Database, key: string): Promise<readonly Stored[]> =>
  (await db.selectFrom('attempt').innerJoin('task', 'task.id', 'attempt.task_id').select(['attempt.id', 'attempt.step', 'attempt.verdict', 'attempt.finished_at', 'attempt.obligation']).where('task.key', '=', key).orderBy('attempt.id').execute()).map(row => ({
    id: row.id,
    step: row.step,
    verdict: row.verdict,
    finished: row.finished_at !== null,
    owes: owedOf(row.obligation),
  }));

const replyOf = async (db: Database, attempt: { readonly id: string } | undefined): Promise<string | undefined> => {
  if (attempt === undefined) return undefined;
  const lines = await db.selectFrom('attempt_event').select('body').where('attempt_event.attempt_id', '=', attempt.id).where('attempt_event.kind', '=', 'app').orderBy('attempt_event.seq').execute();
  const text = reduce(lines).items.findLast(item => item.type === 'agentMessage' && item.status === 'completed')?.text;
  return text === undefined ? undefined : reviewOf(text)?.summary;
};

const recordedEvidence = (db: Database, key: string) => db.selectFrom('evidence').innerJoin('task', 'task.id', 'evidence.task_id').select('evidence.attempt_id').where('task.key', '=', key).orderBy('evidence.attempt_id').execute();

const rowsDisagree = (rows: ReadonlyMap<string, string>, stored: readonly Stored[]): readonly string[] => [
  ...stored.filter(each => !rows.has(each.id)).map(each => `no row for attempt ${each.id}, ${each.step} ${each.verdict ?? 'running'}`),
  ...stored.filter(each => each.finished && (rows.get(each.id) ?? '').includes(stillRunning)).map(each => `row ${each.id} says ${stillRunning}, though it ended ${each.verdict ?? 'without a verdict'}`),
  ...[...rows.keys()].filter(id => !stored.some(each => each.id === id)).map(id => `row ${id} is not in Postgres`),
];

async function agreed(page: Page, db: Database, key: string): Promise<{ readonly rows: ReadonlyMap<string, string>; readonly stored: readonly Stored[] }> {
  const read = async () => ({ rows: await textsOf(page, 'data-attempt-row'), stored: await storedAttempts(db, key) });
  return until('the Attempts tab to match Postgres', async () => {
    const seen = await read();
    return rowsDisagree(seen.rows, seen.stored).length === 0 ? seen : undefined;
  }, catchUpMs).catch(read);
}

const cardOf = async (page: Page): Promise<{ readonly headline: string; readonly text: string }> => ({
  headline: oneLine((await page.locator('[data-card="headline"]').allInnerTexts()).join(' ')),
  text: oneLine((await page.locator('[aria-label="Status"]').allInnerTexts()).join(' ')),
});

const live: Lane = {
  unit,
  id: 'live',
  seeds: [redCheckSeed],
  run: async (world, browser, shots) => {
    const key = keyOf(world, redCheckSeed);
    await mkdir(shots, { recursive: true });
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}?tab=attempts`, 'light', true), async ({ page, errors }) => {
        const saved = async (name: string): Promise<string> => {
          const path = join(shots, name);
          await shoot(page, path);
          return path;
        };
        const shotPaths = [await saved('u8-live-seeded.png')];
        const task = await db.selectFrom('task').select(['task.state', 'task.step', 'task.waiting_on', 'task.waiting_reason']).where('task.key', '=', key).executeTakeFirstOrThrow();
        const seeded = await storedAttempts(db, key);
        const seededReply = await replyOf(db, seeded.at(-1));
        const before = await cardOf(page);
        const repeats = before.headline === '' ? 0 : await page.locator('[aria-label="Agent"]').getByText(before.headline, { exact: true }).count();
        await page.locator(retryButton).click();
        await until('Retry to start Implement again', async () => (await storedAttempts(db, key)).find(each => !seeded.some(old => old.id === each.id)), claimMs);
        const parked = await until('the task to wait for Retry again', async () => {
          const now = await db.selectFrom('task').select(['task.state', 'task.waiting_reason']).where('task.key', '=', key).executeTakeFirstOrThrow();
          return now.state === 'waiting' && (await storedAttempts(db, key)).every(each => each.finished) ? now : undefined;
        }, runsMs);
        const { rows, stored } = await agreed(page, db, key);
        const ran = stored.filter(each => !seeded.some(old => old.id === each.id));
        const newestReply = await replyOf(db, stored.at(-1));
        const unshown = (await Promise.all(ran.map(async each => ((await page.locator(`[aria-label="Agent"] [data-attempt="${each.id}"]`).count()) === 0 ? [each.id] : [])))).flat();
        const after = await cardOf(page);
        await page.locator('[data-attempt-row]').last().scrollIntoViewIfNeeded();
        shotPaths.push(await saved('u8-live-after-rows.png'));
        await page.locator('[aria-label="Status"]').scrollIntoViewIfNeeded();
        shotPaths.push(await saved('u8-live-after.png'));
        const disagree = rowsDisagree(rows, stored);
        const reworks = seeded.filter(each => each.owes !== null);
        const retried = `${ran.map(each => `${each.step} ${each.id} ${each.verdict ?? 'live'} owes ${each.owes ?? 'nothing'}`).join(', ')}; waiting: ${parked.waiting_reason ?? ''}`;
        const named = task.state === 'waiting' && task.waiting_on === 'retry' && (task.waiting_reason ?? '').startsWith(failedThrice) && seeded.map(each => each.verdict ?? 'live').join(' ') === redCheckStory;
        const taken = shotPaths.join(', ');
        return [
          check(named, 'the seed reads back as SBX-60 did', `${key} ${task.state} at ${task.step}: ${task.waiting_reason ?? ''}; attempts: ${seeded.map(each => `${each.step} ${each.verdict ?? 'live'}`).join(', ')}`),
          check(reworks.length > 0 && reworks.every(each => each.owes === owedCheck), 'each seeded rework owes the failed check that sent it back', reworks.map(each => `${each.step} ${each.id} owes ${each.owes ?? 'nothing'}`).join(', ')),
          check(before.headline.includes(foundNothing), 'the status card says the agent found nothing to change', before.text),
          check(seededReply !== undefined && before.text.includes(`“${seededReply}”`), "the status card quotes the agent's own last message", `${before.text} | the agent said: ${seededReply ?? 'nothing'}`),
          check(before.text.includes(redCheck), "the status card names the send-back's reason", before.text),
          check(/^[^.]+\.$/.test(before.headline), "the status card's headline is one sentence", before.headline),
          check(before.headline !== '' && repeats === 0, 'the agent panel does not repeat the headline', `${String(repeats)} copies in the panel`),
          check(ran.length === 1 && ran[0]?.owes === owedCheck && (parked.waiting_reason ?? '').startsWith(pushedNothing), 'Retry runs Implement once, owing the failed check, and the task waits again because it pushed nothing', retried),
          check(ran.length > 0 && disagree.length === 0, 'the Attempts tab shows the attempt Retry started, without a reload', disagree.length === 0 ? ran.map(each => rows.get(each.id) ?? '').join(' | ') : disagree.join('; ')),
          check(newestReply !== undefined && after.text.includes(`“${newestReply}”`) && after.text.includes(owedCheck), 'the status card quotes the newest attempt and names the failed check, without a reload', `${after.text} | the agent said: ${newestReply ?? 'nothing'}`),
          check(ran.length > 0 && unshown.length === 0, 'the agent panel shows the attempt that ran while the page was open', unshown.length === 0 ? ran.map(each => each.id).join(', ') : `missing ${unshown.join(', ')}`),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? taken : `${errors.join('; ')} (${taken})`),
        ];
      }),
    );
  },
};

const liveEvidence: Lane = {
  unit,
  id: 'live-evidence',
  seeds: [behaviorSeed],
  run: async (world, browser, shots) => {
    const key = keyOf(world, behaviorSeed);
    await mkdir(shots, { recursive: true });
    return withDatabase(world, db =>
      open(browser, view(world, `/tasks/${key}?tab=evidence`, 'light', true), async ({ page, errors }) => {
        const seen = new Set((await recordedEvidence(db, key)).map(row => row.attempt_id));
        await page.locator(retryButton).click();
        const added = await until('a Verify attempt to record its evidence', async () => (await recordedEvidence(db, key)).find(row => !seen.has(row.attempt_id)), runsMs);
        const shown = await until('the Evidence tab to show it', async () => ((await page.locator(`[data-evidence="${added.attempt_id}"]`).count()) > 0 ? true : undefined), catchUpMs).catch(() => false);
        const path = join(shots, 'u8-live-evidence.png');
        await page.locator('#panel-evidence').scrollIntoViewIfNeeded();
        await shoot(page, path);
        await showTab(page, 'attempts');
        const { rows, stored } = await agreed(page, db, key);
        const disagree = rowsDisagree(rows, stored);
        return [
          check(shown, 'the Evidence tab shows the evidence a Verify attempt recorded while the page was open', `attempt ${added.attempt_id} ${shown ? 'shows' : 'never showed'}; articles: ${[...(await textsOf(page, 'data-evidence')).keys()].join(', ')}`),
          check(disagree.length === 0, 'the Attempts tab lists the attempts that ran while the page was open', disagree.length === 0 ? `${String(stored.length)} rows` : disagree.join('; ')),
          check(errors.length === 0, 'the page raised no errors', errors.length === 0 ? path : errors.join('; ')),
        ];
      }),
    );
  },
};

export const stateLanes: readonly Lane[] = [smoke, reasons, live, liveEvidence];
