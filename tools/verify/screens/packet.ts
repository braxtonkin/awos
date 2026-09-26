import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { open, shoot, withBrowser } from '../browser.ts';
import { fail, info, pass, type Line, type Scenario } from '../check.ts';
import { judge, readLimits, verdict } from './gates.ts';
import { capture, captureDeclared, fixtures, fixtureTarget, groups, renders, shotsOf, type Capture, type Group, type Screen } from './screens.ts';

const scored = ['clutter', 'hierarchy', 'findability', 'state', 'actionability', 'language', 'spacing', 'agent'] as const;

const states = ['empty', 'busy', 'waiting', 'error'] as const;

const score = z.number().int().min(1).max(5);

const box = z.array(z.number().min(0)).length(4).describe("[x, y, w, h] in the screenshot's own pixels, measured from its top-left corner.");

const reviewSchema = z
  .strictObject({
    group: z.enum(groups).describe('The group this packet is for, such as task.'),
    reviewer: z.string().regex(/^r[1-9]$/).describe('r1, r2, and so on. Each reviewer works alone and never sees another review.'),
    screens: z
      .array(
        z.strictObject({
          screen: z.string().min(1).describe('A screen name from this packet, such as task-a-revised.'),
          scores: z.strictObject({
            clutter: score,
            hierarchy: score,
            findability: score,
            state: score,
            actionability: score,
            language: score,
            spacing: score,
            agent: score.nullable().describe('Communication with the agent, or null when the screen shows no agent.'),
          }),
        }),
      )
      .min(1)
      .describe('Scores for every screen in the packet, each screen exactly once.'),
    problems: z
      .array(
        z.strictObject({
          screen: z.string().min(1).describe('The screen whose screenshot the box is on.'),
          dimension: z.enum([...scored, 'consistency']),
          box,
          problem: z.string().min(1).max(200).describe('What is wrong, in one sentence.'),
          fix: z.string().min(1).max(200).describe('The fix, in one sentence.'),
        }),
      )
      .describe('One entry per problem. Every score below 5, including the consistency score, needs at least one.'),
    consistency: score.describe('The same thing looks and behaves the same across the group’s screens.'),
    coverage: z
      .array(
        z.strictObject({
          state: z.enum(states),
          canHappen: z.boolean().describe('Whether this state can happen anywhere in the group.'),
          screen: z.string().nullable().describe('The screen that shows this state, or null.'),
          confirmed: z.boolean().describe('True when that screen does show the state, or when the state truly cannot happen.'),
          note: z.string().max(200).optional(),
        }),
      )
      .length(4)
      .describe('One entry per state: empty, busy, waiting, and error.'),
    find: z
      .array(
        z.strictObject({
          question: z.string().min(1).describe('The question id from find-questions.json.'),
          answer: z.string().max(300).describe('The answer as read from the screenshot, or an empty string when it cannot be found.'),
          screen: z.string().nullable().describe('The screen where the answer was found, or null.'),
          box: box.optional(),
          path: z.array(z.string().min(1).max(120)).describe('Each look or click from landing on the screen to the answer, in order.'),
          needs: z.array(z.enum(['scroll', 'tab', 'guess'])).describe('What the path needed beyond a glance. An empty list means a glance was enough.'),
        }),
      )
      .min(1)
      .describe("One answer for each of the group's find questions, answered from the screenshots alone."),
  })
  .describe('One reviewer’s review of one group. Scores run from 1 to 5: 5 means nothing to fix, 4 minor polish only, 3 a real problem a user would notice, 2 it gets in the way, and 1 broken.');

type Review = z.infer<typeof reviewSchema>;

const questionsFile = z.strictObject({ ownerSays: z.string(), groups: z.record(z.string(), z.array(z.strictObject({ id: z.string(), question: z.string() }))) });

const packetFile = z.strictObject({ group: z.enum(groups), reviewers: z.number().int().positive(), screens: z.record(z.string(), z.strictObject({ w: z.number(), h: z.number() })) });

type Packet = z.infer<typeof packetFile>;

const here = (file: string): URL => new URL(file, import.meta.url);

function crossCheck(review: Review, file: string, packet: Packet, questions: readonly string[]): readonly string[] {
  const out: string[] = [];
  const members = Object.keys(packet.screens);
  const inGroup = (name: string | null): boolean => name !== null && members.includes(name);
  const fits = (screen: string, where: readonly number[], at: string): void => {
    const size = packet.screens[screen];
    const [x = 0, y = 0, w = 0, h = 0] = where;
    if (size !== undefined && (w <= 0 || h <= 0 || x + w > size.w || y + h > size.h)) out.push(`${at}: box [${where.join(', ')}] is not inside the ${String(size.w)}x${String(size.h)} screenshot of ${screen}`);
  };
  if (file !== `${review.group}.${review.reviewer}.json`) out.push(`the file must be named ${review.group}.${review.reviewer}.json`);
  if (review.group !== packet.group) out.push(`group is ${review.group}, but the packet is for ${packet.group}`);
  const named = review.screens.map(each => each.screen);
  for (const name of members) if (!named.includes(name)) out.push(`${name} has no scores`);
  for (const name of new Set(named)) {
    if (!inGroup(name)) out.push(`${name} is not in the packet`);
    if (named.filter(each => each === name).length > 1) out.push(`${name} is scored more than once`);
  }
  const hasProblem = (screen: string | null, dimension: string): boolean => review.problems.some(p => p.dimension === dimension && (dimension === 'consistency' || p.screen === screen));
  for (const each of review.screens) {
    for (const dimension of scored) {
      const given = each.scores[dimension];
      if (given !== null && given < 5 && !hasProblem(each.screen, dimension)) out.push(`${each.screen} ${dimension} scored ${String(given)} with no problem`);
    }
  }
  if (review.consistency < 5 && !hasProblem(null, 'consistency')) out.push(`consistency scored ${String(review.consistency)} with no problem`);
  review.problems.forEach((p, index) => {
    if (inGroup(p.screen)) fits(p.screen, p.box, `problems[${String(index)}]`);
    else out.push(`problems[${String(index)}] is on ${p.screen}, which is not in the packet`);
  });
  for (const state of states) if (review.coverage.filter(c => c.state === state).length !== 1) out.push(`coverage must list ${state} exactly once`);
  for (const c of review.coverage) if (c.screen !== null && !inGroup(c.screen)) out.push(`coverage ${c.state} names ${c.screen}, which is not in the packet`);
  const asked = review.find.map(f => f.question);
  if (questions.length !== asked.length || questions.some(id => !asked.includes(id))) out.push(`find must answer exactly ${questions.join(', ')}`);
  for (const f of review.find) {
    if (f.screen === null) continue;
    if (!inGroup(f.screen)) out.push(`find ${f.question} names ${f.screen}, which is not in the packet`);
    else if (f.box !== undefined) fits(f.screen, f.box, `find ${f.question}`);
  }
  return out;
}

const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function indexPage(group: Group, reviewers: number, captures: readonly Capture[], lines: readonly string[], questions: readonly { readonly id: string; readonly question: string }[]): string {
  const names = Array.from({ length: reviewers }, (_, index) => `${group}.r${String(index + 1)}.json`);
  const screensHtml = captures
    .map(
      each => `<section><h2>${escape(each.name)}</h2><div class="shots"><figure><img src="${escape(each.name)}.light.png" alt="${escape(each.name)} in the light theme"><figcaption>Light</figcaption></figure><figure><img src="${escape(each.name)}.dark.png" alt="${escape(each.name)} in the dark theme"><figcaption>Dark</figcaption></figure></div></section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Screen review: ${escape(group)}</title>
<style>
body { margin: 0; padding: 32px; font: 14px/20px Arial, 'Liberation Sans', sans-serif; color: #16161a; background: #f6f6f7; }
h1 { font-size: 24px; line-height: 32px; margin: 0 0 16px; }
h2 { font-size: 17px; margin: 24px 0 8px; }
ol, ul { margin: 0 0 16px; padding-left: 20px; }
pre { font: 12px/16px ui-monospace, monospace; background: #ffffff; border: 1px solid #dddde1; padding: 12px; white-space: pre-wrap; }
.shots { display: flex; gap: 16px; }
figure { margin: 0; flex: 1; }
img { width: 100%; border: 1px solid #dddde1; }
</style>
</head>
<body>
<h1>Screen review of the ${escape(group)} group</h1>
<p>You are one of ${String(reviewers)} reviewers who never see each other. Read rubric.md, look at every screenshot below, and read metrics.json for the objective gates.</p>
<ol>
<li>Score every screen on every scored dimension, from 1 to 5.</li>
<li>For every score below 5, name the problem, give its box on the screenshot in pixels, and propose a fix in one sentence.</li>
<li>Answer each find question from the screenshots alone.</li>
<li>Fill the coverage checklist for the empty, busy, waiting, and error states.</li>
<li>Save your review as one of ${names.map(name => `<code>${escape(name)}</code>`).join(', ')}, matching review.schema.json.</li>
</ol>
<h2>Find questions</h2>
<ul>${questions.map(q => `<li><code>${escape(q.id)}</code> ${escape(q.question)}</li>`).join('')}</ul>
<h2>Gates</h2>
<pre>${escape(lines.join('\n'))}</pre>
${screensHtml}
</body>
</html>
`;
}

async function write(group: Group, useFixtures: boolean, declared: readonly Screen[]): Promise<readonly Line[]> {
  const limits = await readLimits();
  const folder = join(shotsOf('screen-review'), group);
  const questions = questionsFile.parse(JSON.parse(await readFile(here('find-questions.json'), 'utf8')));
  const asked = questions.groups[group] ?? [];
  const chosen = fixtures.filter(each => each.group === group);
  const screens = declared.filter(each => each.group === group);
  if ((useFixtures ? chosen : screens).length === 0) throw new Error(`no ${useFixtures ? 'fixture' : 'declared screen'} is in the ${group} group`);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  return withBrowser(async browser => {
    const captures: Capture[] = [];
    if (useFixtures) for (const fixture of chosen) captures.push(await capture(browser, fixtureTarget(fixture), limits, folder));
    else captures.push(...(await captureDeclared(browser, screens, limits, folder)));
    const gateText = captures.flatMap(each => judge(each.captured, limits).map(judged => `${judged.passed ? 'PASS' : 'FAIL'}  ${each.name} ${judged.id}  ${verdict(judged)}`));
    const packet: Packet = { group, reviewers: limits.reviewers, screens: Object.fromEntries(captures.map(each => [each.name, each.size])) };
    await writeFile(join(folder, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`);
    await writeFile(join(folder, 'metrics.json'), `${JSON.stringify(Object.fromEntries(captures.map(each => [each.name, { size: each.size, gates: judge(each.captured, limits), light: each.captured.light, dark: each.captured.dark }])), null, 2)}\n`);
    await writeFile(join(folder, 'find-questions.json'), `${JSON.stringify({ ownerSays: questions.ownerSays, questions: asked }, null, 2)}\n`);
    await writeFile(join(folder, 'review.schema.json'), `${JSON.stringify(z.toJSONSchema(reviewSchema), null, 2)}\n`);
    await copyFile(here('rubric.md'), join(folder, 'rubric.md'));
    await writeFile(join(folder, 'index.html'), indexPage(group, limits.reviewers, captures, gateText, asked));
    const indexShot = join(folder, 'index.png');
    await open(browser, { url: 'http://packet.test/index.html', width: 1440, height: 900, theme: 'light', steps: [], served: { origin: 'http://packet.test', read: path => readFile(join(folder, path)).catch(() => undefined) } }, async ({ page }) => {
      await shoot(page, indexShot);
    });
    return [
      ...captures.map(renders),
      pass(`the packet for ${group} holds the rubric, ${String(asked.length)} find questions, the review schema, the metrics, and screenshots of ${captures.map(each => each.name).join(', ')}`, folder),
      pass(`the packet's index page renders`, indexShot),
      info(`the packet waits for ${String(limits.reviewers)} reviews`, 'n/a', `save them in ${folder}, then run screen-review ${group} --judge`),
    ];
  });
}

async function judgeReviews(group: Group): Promise<readonly Line[]> {
  const folder = join(shotsOf('screen-review'), group);
  const packet = packetFile.parse(JSON.parse(await readFile(join(folder, 'packet.json'), 'utf8')));
  const questions = questionsFile.parse(JSON.parse(await readFile(here('find-questions.json'), 'utf8'))).groups[group] ?? [];
  const expected = Array.from({ length: packet.reviewers }, (_, index) => `${group}.r${String(index + 1)}.json`);
  const present = new Set((await readdir(folder)).filter(file => /^[a-z]+\.r[1-9]\.json$/.test(file)));
  const lines: Line[] = [];
  const reviews: Review[] = [];
  for (const file of expected) {
    const name = `${file} parses against review.schema.json and fits the packet`;
    if (!present.has(file)) {
      lines.push(fail(name, 'the file is missing'));
      continue;
    }
    const parsed = reviewSchema.safeParse(JSON.parse(await readFile(join(folder, file), 'utf8')));
    if (!parsed.success) {
      lines.push(fail(name, parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')));
      continue;
    }
    const problems = crossCheck(parsed.data, file, packet, questions.map(q => q.id));
    lines.push(problems.length === 0 ? pass(name, `scores ${parsed.data.screens.map(each => each.screen).join(', ')} and names ${String(parsed.data.problems.length)} problems`) : fail(name, problems.slice(0, 5).join('; ')));
    if (problems.length === 0) reviews.push(parsed.data);
  }
  const complete = reviews.length === packet.reviewers;
  const screenPasses = Object.keys(packet.screens).map(screen => {
    const low = reviews.flatMap(review => review.screens.filter(each => each.screen === screen).flatMap(each => scored.filter(dimension => (each.scores[dimension] ?? 5) < 4).map(dimension => `${review.reviewer} ${dimension} ${String(each.scores[dimension])}`)));
    const name = `${screen} scores 4 or higher on every scored dimension from ${String(packet.reviewers)} reviews`;
    return complete && low.length === 0 ? pass(name, 'every score is 4 or 5') : fail(name, complete ? low.join(', ') : 'a review is missing or invalid');
  });
  const consistency = reviews.filter(review => review.consistency < 4).map(review => `${review.reviewer} ${String(review.consistency)}`);
  const coverage = reviews.flatMap(review => review.coverage.filter(c => !c.confirmed).map(c => `${review.reviewer} ${c.state}`));
  const groupLines = [
    complete && consistency.length === 0 ? pass(`every reviewer scores ${group}'s consistency 4 or higher`, reviews.map(review => `${review.reviewer} ${String(review.consistency)}`).join(', ')) : fail(`every reviewer scores ${group}'s consistency 4 or higher`, complete ? consistency.join(', ') : 'a review is missing or invalid'),
    complete && coverage.length === 0 ? pass(`every reviewer confirms ${group}'s empty, busy, waiting, and error coverage`, 'each state is listed once and confirmed') : fail(`every reviewer confirms ${group}'s empty, busy, waiting, and error coverage`, complete ? `unconfirmed: ${coverage.join(', ')}` : 'a review is missing or invalid'),
  ];
  const all = [...screenPasses, ...groupLines];
  const passed = all.every(line => 'passed' in line && line.passed);
  return [...lines, ...all, info(`the ${group} group ${passed ? 'passes' : 'does not pass'} review`, passed ? 'passed' : 'failed', `${String(reviews.length)} of ${String(packet.reviewers)} reviews count`)];
}

export const screenReview = (declared: readonly Screen[]): Scenario => ({
  name: 'screen-review',
  summary: 'writes a review packet for a group of declared screens, or of the fixtures with --fixtures, or judges the returned reviews with --judge, against the screen and group rules in rubric.md',
  run: async args => {
    const { values, positionals } = parseArgs({ args: [...args], options: { fixtures: { type: 'boolean' }, judge: { type: 'boolean' } }, strict: true, allowPositionals: true });
    const group = groups.find(each => each === positionals[0]);
    if (group === undefined || positionals.length !== 1) throw new Error(`screen-review takes one group: ${groups.join(', ')}`);
    return values.judge === true ? judgeReviews(group) : write(group, values.fixtures === true, declared);
  },
});
