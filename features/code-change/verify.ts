import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { z } from 'zod';
import { builtByStep, shapeOf, type StepVerdict, type Unasked } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { modelShape, shapeDrift } from '../../tools/verify/model-shape.ts';
import type { Change, Earlier, PullRequestFact } from '../../shared/agent-step.ts';
import { decideLand, guarded, sentBack } from './land.ts';
import type { MergeValue } from '../../shared/merge-state.ts';
import type { ReworkObligation, SendBack } from '../../shared/rework.ts';
import { evidenceText, reproductionPath, scriptFile, type RanScript, type Reproduction, type Side } from '../../shared/reproduction.ts';
import { agentSteps } from './stage-output.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { actionsOf, realStates, variablesIn, type TlcRun } from '../../tools/verify/tlc.ts';
import { mutantName, mutants, runSeed, simulate, type MutantName, type Run } from './simulate.ts';
import { workflow } from './workflow.ts';

type Case = { readonly output: unknown; readonly verdicts: Readonly<Record<string, StepVerdict>> };

const text = { kind: 'text', title: null, body: 'What the step did.' } as const;

const choice = { kind: 'choice', title: null, question: 'Which way?', options: [{ id: 'a', label: 'This way' }], recommended: null } as const;

const review = (outcome: 'done' | 'needs_input' | 'blocked', blocks: readonly unknown[] = [text]) => ({ outcome, summary: 'A review.', blocks });

const cases: readonly (readonly [string, Case])[] = [
  ['a done review with a text block', { output: review('done'), verdicts: { specify: 'pass', implement: 'pass', verify: 'environment_fail', land: 'pass' } }],
  ['a done review that says the behavior is fixed', { output: { ...review('done'), behavior: 'fixed' }, verdicts: { specify: 'fail', implement: 'fail', verify: 'pass', land: 'fail' } }],
  ['a done review that says the behavior is still wrong', { output: { ...review('done'), behavior: 'still_wrong' }, verdicts: { verify: 'behavior_fail' } }],
  ['a done review that could not check the behavior', { output: { ...review('done'), behavior: null }, verdicts: { verify: 'environment_fail' } }],
  ['a done review with no text block', { output: { ...review('done', [choice]), behavior: 'fixed' }, verdicts: { verify: 'environment_fail' } }],
  ['a review that asks for input', { output: review('needs_input', [choice]), verdicts: { specify: 'needs_input', implement: 'needs_input', land: 'needs_input' } }],
  ['a review that asks for input about the behavior', { output: { ...review('needs_input', [choice]), behavior: null }, verdicts: { verify: 'needs_input' } }],
  ['a blocked review', { output: review('blocked'), verdicts: { specify: 'fail', implement: 'fail', land: 'fail' } }],
  ['a blocked review about the behavior', { output: { ...review('blocked'), behavior: null }, verdicts: { verify: 'environment_fail' } }],
  ['a message that is not a review', { output: 'I could not finish.', verdicts: { specify: 'fail', implement: 'fail', verify: 'environment_fail', land: 'fail' } }],
  ['no final message', { output: null, verdicts: { specify: 'fail', implement: 'fail', verify: 'environment_fail', land: 'fail' } }],
];

function judgeChecks(): readonly Check[] {
  return cases.map(([what, { output, verdicts }]) => {
    const name = `each step judges ${what} as its declaration says`;
    const wrong = Object.entries(verdicts).flatMap(([step, expected]) => {
      const kind = workflow.steps.find(candidate => candidate.name === step);
      const got = kind?.judge(output);
      return got === expected ? [] : [`${step} judged ${got ?? 'nothing, because it has no such step'}, not ${expected}`];
    });
    return wrong.length === 0 ? pass(name, Object.entries(verdicts).map(([step, verdict]) => `${step} ${verdict}`).join(', ')) : fail(name, wrong.join('; '));
  });
}

function shapeCheck(): Check {
  const name = 'the Code change declaration has the shape that features/tasks/Tasks.tla checks';
  const drift = shapeDrift(modelShape(new URL('../tasks/Tasks.tla', import.meta.url), new URL('../tasks/Tasks.cfg', import.meta.url)), shapeOf(workflow));
  return drift.length === 0 ? pass(name, workflow.steps.map(kind => kind.name).join(', ')) : fail(name, drift.join('; '));
}

function builtCheck(): Check {
  const name = 'every step of Code change was built by step()';
  const loose = workflow.steps.filter(kind => !builtByStep(kind)).map(kind => kind.name);
  return loose.length === 0 ? pass(name, `${String(workflow.steps.length)} steps`) : fail(name, `not built by step(): ${loose.join(', ')}`);
}

const base = 'b'.repeat(40);

const head = 'c'.repeat(40);

const ran = (exitCode: number | null, timedOut = false): RanScript => ({ exitCode, timedOut, output: `exited ${String(exitCode)}` });

const side = (commit: string, run: RanScript | null, setup: RanScript | null = ran(0)): Side => ({ commit, checkout: null, setup, run });

const ranBoth = (before: Side, after: Side): Reproduction => ({ state: 'ran', script: 'test -f src/fixed.ts', base: before, change: after });

const said = (exitCode: number, output: string): RanScript => ({ exitCode, timedOut: false, output });

const runFile = '/tmp/autoworker-run.sAMQb4/reproduce.sh';

const noRg = `checking formatNumber\n${runFile}: 6: rg: not found`;

const settleCases: readonly (readonly [string, Reproduction | null, 'fixed' | 'still_wrong' | null])[] = [
  ['the shell found no `rg` on line 6 on both commits, as in SBX-54', ranBoth(side(base, said(127, noRg)), side(head, said(127, noRg))), null],
  ['the script went on past a command the shell could not find on the base commit, then failed', ranBoth(side(base, said(1, `${runFile}: 1: rg: not found\nafter`)), side(head, ran(0))), null],
  ['a command in the script could not be executed on the base commit', ranBoth(side(base, said(126, `${runFile}: 2: ./bin/format: Permission denied`)), side(head, ran(0))), null],
  ['the shell stopped at a syntax error in the script on both commits', ranBoth(side(base, said(2, `${runFile}: 1: Syntax error: "(" unexpected`)), side(head, said(2, `${runFile}: 1: Syntax error: "(" unexpected`))), null],
  ["the base run failed and printed another shell's not found, as a bug can", ranBoth(side(base, said(1, 'sh: 1: tsc: not found')), side(head, ran(0))), 'fixed'],
  ['the shell found no `rg` only on the change, which the change may have removed', ranBoth(side(base, ran(1)), side(head, said(127, noRg))), 'still_wrong'],
  ['the script fails on the base commit and passes on the change', ranBoth(side(base, ran(1)), side(head, ran(0))), 'fixed'],
  ['the script fails on both', ranBoth(side(base, ran(1)), side(head, ran(1))), 'still_wrong'],
  ['the script passes on the base commit, so nothing was reproduced', ranBoth(side(base, ran(0)), side(head, ran(0))), null],
  ['the base commit could not be checked out, so its failure is no reproduction', ranBoth({ commit: base, checkout: 'checking out failed', setup: null, run: null }, side(head, ran(0))), null],
  ["the base commit's setup failed, so the script never ran there", ranBoth(side(base, null, ran(1)), side(head, ran(0))), null],
  ["the change's setup failed", ranBoth(side(base, ran(1)), side(head, null, ran(127))), null],
  ['the base run ran out of time', ranBoth(side(base, ran(null, true)), side(head, ran(0))), null],
  ['the change run ran out of time', ranBoth(side(base, ran(1)), side(head, ran(null, true))), null],
  ['the agent left no script', { state: 'no_script', reason: 'the agent left no file' }, null],
  ['the Job posted no reproduction', null, null],
];

function settleChecks(): readonly Check[] {
  return settleCases.map(([what, reproduction, expected]) => {
    const name = `Verify's behavior comes from the Job's own runs, whatever the agent says: ${what}`;
    const settled = agentSteps.settle({ step: 'verify', output: { outcome: 'done', summary: 'Ran both.', blocks: [], behavior: 'fixed' }, change: { pushed: null, carried: null, declined: null }, reproduction, obligation: null });
    const behavior = typeof settled.output === 'object' && settled.output !== null && 'behavior' in settled.output ? settled.output.behavior : 'missing';
    const kept = JSON.stringify(settled.evidence) === JSON.stringify(reproduction);
    return behavior === expected && kept ? pass(name, `behavior ${String(expected)}, evidence ${settled.evidence === null ? 'none' : 'stored as posted'}`) : fail(name, `behavior ${String(behavior)}, not ${String(expected)}; evidence ${kept ? 'as posted' : 'changed'}`);
  });
}

const sbx54Script = ['echo "checking formatNumber"', 'test -f package.json || echo "no package.json here"', "printf '%s\\n' 'formatNumber(1234) prints 1,234'", 'cd .', 'echo "searching src"', 'rg -n formatNumber src/'].join('\n');

function inShell(script: string): RanScript {
  const folder = mkdtempSync(join(tmpdir(), 'autoworker-run.'));
  try {
    mkdirSync(join(folder, 'tree'));
    writeFileSync(join(folder, scriptFile), script);
    const ran = spawnSync('/bin/sh', [join(folder, scriptFile)], { cwd: join(folder, 'tree'), env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    return { exitCode: ran.status, timedOut: false, output: `${ran.stdout}${ran.stderr}` };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function unrunnableCheck(): Check {
  const name = "SBX-54 replayed in sh: a script whose line 6 calls `rg`, which the shell cannot find, fails Verify's own attempt, and the next Verify attempt is told the command";
  const reproduction: Reproduction = { state: 'ran', script: sbx54Script, base: side(base, inShell(sbx54Script)), change: side(head, inShell(sbx54Script)) };
  const output = { outcome: 'done', summary: 'The script checks formatNumber.', blocks: [{ kind: 'text', title: null, body: 'The script searches src for formatNumber.' }], behavior: null };
  const settled = agentSteps.settle({ step: 'verify', output, change: { pushed: null, carried: null, declined: null }, reproduction, obligation: null });
  const verdict = workflow.steps.find(kind => kind.name === 'verify')?.judge(settled.output) ?? 'pass';
  const earlier = [entry('specify', 'pass'), entry('implement', 'pass'), { step: 'verify', verdict, output: settled.output, evidence: settled.evidence }];
  const next = agentSteps.input({ step: 'verify', ticket: { key: 'SBX-54', title: 'Format numbers', description: null }, earlier, obligation: null });
  const told = 'AutoWorker could not check the behavior, because the script could not run on the base commit, where the shell found no `rg` on line 6.';
  const exits = `base ${String(reproduction.base.run?.exitCode)}, change ${String(reproduction.change.run?.exitCode)}`;
  return verdict === 'environment_fail' && next.includes(told)
    ? pass(name, `${exits}; verdict ${verdict}; the next Verify input says: ${told}`)
    : fail(name, `${exits}; verdict ${verdict}${verdict === 'behavior_fail' ? ', which sends the task back to Implement' : ''}; the next Verify input ${next.includes(told) ? 'names the command' : `lacks "${told}"`}`);
}

const doneImplement = { outcome: 'done', summary: 'Implemented the ticket.', blocks: [{ kind: 'text', title: null, body: 'Added the function.' }] };

const checkedEverything = { outcome: 'done', summary: 'All mandated checks pass.', blocks: [{ kind: 'text', title: null, body: 'All mandated checks pass: typecheck, test, and build. The smoke test needs a browser.' }] };

const askedAboutTicket = {
  outcome: 'needs_input',
  summary: 'The ticket forbids the fix.',
  blocks: [{ kind: 'choice', title: null, question: 'The ticket says "Do not edit `test/save.test.ts`", and Verify needs it to compile. Which wins?', options: [{ id: 'edit', label: 'Edit it' }], recommended: null }],
};

const pushedCommit: Change = { pushed: 'a'.repeat(40), carried: null, declined: null };

const unchanged: Change = { pushed: null, carried: null, declined: null };

const failedSandbox: ReworkObligation = {
  kind: 'check',
  head: 'c'.repeat(40),
  branch: 'main',
  base: 'f'.repeat(40),
  checks: [{ name: 'check', kind: 'logged', conclusion: 'failure', step: 'npm run smoke', log: 'FAIL console error: Failed to load resource: the server responded with a status of 404 (Not Found)' }],
  notes: [],
};

const stillWrong: ReworkObligation = { kind: 'behavior', evidence: 'On the change: the script exited 1.\n\ntest/save.test.ts: Property "level" is missing in type GameState.', notes: [] };

const reviewed: ReworkObligation = { kind: 'review', review: 'ada asked for changes.\nRename the helper.', notes: [] };

const merging: ReworkObligation = { kind: 'conflict', branch: 'main', head: 'd'.repeat(40), notes: [] };

const noted: ReworkObligation = { kind: 'note', notes: [{ by: 'Ada', text: 'Use the smaller plan.' }] };

type ImplementCase = { readonly what: string; readonly output: unknown; readonly change: Change; readonly obligation: ReworkObligation | null; readonly observed: Unasked | null; readonly says: string; readonly ends: readonly string[] | null };

const implementCases: readonly ImplementCase[] = [
  { what: 'an attempt that pushed a commit', output: doneImplement, change: pushedCommit, obligation: null, observed: null, says: 'Added the function.', ends: null },
  { what: "an attempt that pushed nothing but started from a lost attempt's push", output: doneImplement, change: { pushed: null, carried: 'b'.repeat(40), declined: null }, obligation: null, observed: null, says: 'Added the function.', ends: null },
  { what: 'a first attempt that pushed nothing and carried nothing, so the agent made no change and its retries go on', output: doneImplement, change: unchanged, obligation: null, observed: 'fail', says: 'made no change', ends: null },
  {
    what: 'an attempt whose merge the Job declined to push, with the reason it gave',
    output: doneImplement,
    change: { pushed: null, carried: null, declined: '`src/a.ts` still holds conflict markers' },
    obligation: merging,
    observed: 'fail',
    says: 'AutoWorker pushed nothing, because `src/a.ts` still holds conflict markers.',
    ends: null,
  },
  { what: 'a rework after a failed check that pushed a commit', output: doneImplement, change: pushedCommit, obligation: failedSandbox, observed: null, says: 'Added the function.', ends: null },
  {
    what: 'SBX-60 replayed: a rework after a failed check that pushed nothing ends the step at once, naming the check and quoting the agent',
    output: checkedEverything,
    change: unchanged,
    obligation: failedSandbox,
    observed: 'fail',
    says: 'Implement pushed nothing, though the task came back to fix the failed check `check`.',
    ends: ['the failed check `check`', 'Its last message said: "All mandated checks pass: typecheck, test, and build. The smoke test needs a browser."'],
  },
  {
    what: 'a rework after Verify found the behavior still wrong that pushed nothing ends the step at once',
    output: checkedEverything,
    change: unchanged,
    obligation: stillWrong,
    observed: 'fail',
    says: 'the behavior Verify found still wrong',
    ends: ['the behavior Verify found still wrong', 'All mandated checks pass'],
  },
  { what: 'a rework after a review that pushed nothing ends the step at once', output: checkedEverything, change: unchanged, obligation: reviewed, observed: 'fail', says: 'a review asked for', ends: ['a review asked for'] },
  { what: 'a rework that pushed nothing and left no final message ends the step and says so', output: null, change: unchanged, obligation: failedSandbox, observed: 'fail', says: 'It ended without a final message', ends: ['It ended without a final message'] },
  { what: "a rework that pushed nothing for a person's note keeps its retries", output: doneImplement, change: unchanged, obligation: noted, observed: 'fail', says: 'made no change', ends: null },
  { what: 'SBX-57 replayed: a rework that asks a person about a clash with the ticket goes to the ask route, though it pushed nothing', output: askedAboutTicket, change: unchanged, obligation: stillWrong, observed: null, says: 'Do not edit', ends: null },
];

const noChangeSummary = '"summary":"The agent made no change."';

function implementChecks(): readonly Check[] {
  return implementCases.map(({ what, output, change, obligation, observed, says, ends }) => {
    const name = `Implement's verdict comes from its change and what it owes: ${what}`;
    const settled = agentSteps.settle({ step: 'implement', output, change, reproduction: null, obligation });
    const said = JSON.stringify(settled.output);
    const reason = 'ends' in settled ? settled.ends : null;
    const endsRight = ends === null ? reason === null : reason !== null && ends.every(part => reason.includes(part)) && /^[A-Z].*\.$/s.test(reason) && said.includes(noChangeSummary);
    const detail = `observed ${String(settled.observed)}${reason === null ? '' : `, ends: ${reason}`}`;
    return settled.observed === observed && said.includes(says) && endsRight ? pass(name, detail) : fail(name, `${detail}; expected ${String(observed)}${ends === null ? ' and no end' : ` ending with ${ends.join(' and ')}`}; output ${said.slice(0, 300)}`);
  });
}

const doneReview = { outcome: 'done', summary: 'Done.', blocks: [{ kind: 'text', title: null, body: 'Done.' }] };

const waitingTasksLand = { outcome: 'done', summary: 'Land sent the task back to Implement.', blocks: [{ kind: 'text', title: null, body: 'Land sent the task back, because the pull request conflicts with its base branch.' }] };

const sbx60Land = { outcome: 'done', summary: 'Land sent the task back to Implement.', blocks: [{ kind: 'text', title: null, body: 'Land sent the task back, because a check failed: check.' }] };

const noChangeOutput = { outcome: 'fail', summary: 'The agent made no change.', blocks: [{ kind: 'text', title: null, body: 'Implement made no change: the attempt pushed no commit.' }] };

const entry = (step: string, verdict: Earlier['verdict'], output: unknown = doneReview, evidence: Earlier['evidence'] = null): Earlier => ({ step, verdict, output, evidence });

const passedOnce = [entry('specify', 'pass'), entry('implement', 'pass'), entry('verify', 'pass')];

const conflicted = [...passedOnce, entry('land', 'conflict', waitingTasksLand)];

const redAt = 'e'.repeat(40);

const failedReproduction = ranBoth(side(base, ran(1)), side(head, said(1, 'AssertionError: Expected values to be strictly equal: 1 !== 2')));

function sentBackChecks(): readonly Check[] {
  const reading = (value: MergeValue) => ({ number: 7, state: { head: redAt, value }, draft: 'when-green' as const });
  const record = { draftLeaves: 'when-green' as const, answered: [], markedReady: false, refused: null, updatedAt: null, gatesApproved: true, evidence: '' };
  const landed = (value: MergeValue): Earlier => {
    const { decision } = decideLand(reading(value), record, guarded);
    return decision.kind === 'send-back' ? entry('land', decision.verdict, sentBack(decision.why, decision.failing === null ? null : { head: reading(value).state.head, checks: decision.failing })) : entry('land', 'fail', decision);
  };
  const cases: readonly (readonly [string, Earlier, SendBack])[] = [
    ["Land's conflict send-back as the five waiting tasks and SBX-66 hold it, a red check with the conflict's exact output", entry('land', 'red_check', waitingTasksLand), { kind: 'conflict' }],
    ["Land's conflict send-back as Land writes it now, with its own verdict", landed({ kind: 'conflicting' }), { kind: 'conflict' }],
    ["Land's red check as SBX-60's task holds it, which names the check and no head", entry('land', 'red_check', sbx60Land), { kind: 'check', head: null, names: ['check'] }],
    ["Land's red check as Land writes it now, with the head and every failing check", landed({ kind: 'red', failing: ['build', 'lint'] }), { kind: 'check', head: redAt, names: ['build', 'lint'] }],
    ["Verify's behavior still wrong, with its evidence", entry('verify', 'behavior_fail', doneReview, failedReproduction), { kind: 'behavior', evidence: evidenceText(failedReproduction) ?? '' }],
    ['a review that asked for changes', entry('land', 'changes_requested', { ...doneReview, blocks: [{ kind: 'text', title: null, body: 'ada asked for changes.\nRename the helper.' }] }), { kind: 'review', review: 'ada asked for changes.\nRename the helper.' }],
  ];
  const verdictName = 'Land ends a conflict with the verdict conflict, which its own route counts, and a red check with red_check';
  const verdicts = [landed({ kind: 'conflicting' }).verdict, landed({ kind: 'red', failing: ['build'] }).verdict].join(', ');
  return [
    verdicts === 'conflict, red_check' ? pass(verdictName, verdicts) : fail(verdictName, verdicts),
    ...cases.map(([what, sender, expected]) => {
      const name = `the plug reads what a rework owes from the attempt that sent the task back: ${what}`;
      const got = agentSteps.sentBack(sender);
      return isDeepStrictEqual(got, expected) ? pass(name, JSON.stringify(got).slice(0, 200)) : fail(name, `${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
    }),
  ];
}

const reworkInput = (earlier: readonly Earlier[], obligation: ReworkObligation | null): string =>
  agentSteps.input({ step: 'implement', ticket: { key: 'SBX-49', title: 'Add scores', description: null }, earlier, obligation });

const plantedToken = `ghp_${'x'.repeat(36)}`;

const sbx93Check = 'npx vitest run test/catch-up.test.ts -t "offline catch-up credits every machine, perk, and achievement"';

const sbx93Script = [
  'set -e',
  `export GITHUB_TOKEN=${plantedToken}`,
  ...Array.from({ length: 48 }, (_, index) => `node scripts/seed-state.mjs --machine m${String(index)} --perk p${String(index % 7)} --achievement a${String(index % 11)} --saved-at ${String(1_700_000_000 + index * 60)}`),
  'export CATCH_UP_NOW=$((1700000000 + 3600))',
  sbx93Check,
].join('\n');

function longScriptCheck(): Check {
  const name = `SBX-93 replayed: a behavior rework's input holds Verify's whole script of ${String(sbx93Script.length)} characters, redacted, with the run outputs still trimmed`;
  const evidence: Reproduction = { state: 'ran', script: sbx93Script, base: side(base, said(1, 'x'.repeat(5000))), change: side(head, said(1, 'y'.repeat(5000))) };
  const owed = agentSteps.sentBack(entry('verify', 'behavior_fail', doneReview, evidence));
  const given = owed.kind === 'behavior' ? reworkInput([...passedOnce.slice(0, 2), entry('verify', 'behavior_fail', doneReview, evidence)], { ...owed, notes: [] }) : '';
  const facts: readonly (readonly [string, boolean])[] = [
    ['the script is longer than 4,000 characters', sbx93Script.length > 4000],
    ['the input holds the script through its last line', given.includes(`${sbx93Check}\n\`\`\``)],
    ['the input redacts the token in the script', given.includes('export GITHUB_TOKEN=[redacted]') && !given.includes(plantedToken)],
    ['the input trims each run output', given.split('[cut after 4000 characters]').length === 3],
  ];
  const missing = facts.filter(([, holds]) => !holds).map(([what]) => what);
  return missing.length === 0 ? pass(name, facts.map(([what]) => what).join('; ')) : fail(name, `fails: ${missing.join('; ')}. The input ends: ${given.slice(-600)}`);
}

function reworkChecks(): readonly Check[] {
  const failedTwice = [...conflicted, entry('implement', 'fail', noChangeOutput), entry('implement', 'fail', noChangeOutput)];
  const cases: readonly (readonly [string, readonly Earlier[], ReworkObligation | null, readonly string[], readonly string[]])[] = [
    [
      'the first conflict rework is told that the pull request conflicts, and which base commit AutoWorker started merging',
      conflicted,
      merging,
      ['Land sent the task back, because the pull request conflicts with its base branch.', `AutoWorker started merging \`${'d'.repeat(40)}\`, the head of \`main\``],
      ['Your last attempt'],
    ],
    ['the third conflict rework is still told about the conflict, and why its last attempt failed', failedTwice, merging, ['conflicts with its base branch', 'Your last attempt at this step failed.', 'Implement made no change'], []],
    [
      "SBX-60's rework is told the check, the step it failed at, and the end of its log",
      [...passedOnce, entry('land', 'red_check', sbx60Land)],
      failedSandbox,
      ['checks failed on `' + 'c'.repeat(40) + '`', 'The check `check` ended failure at the step `npm run smoke`.', 'Failed to load resource: the server responded with a status of 404'],
      [],
    ],
    [
      "SBX-93's check rework is told that CI tested the merge, and which base commit AutoWorker started merging",
      [...passedOnce, entry('land', 'red_check', sbx60Land)],
      failedSandbox,
      ['CI ran them on the pull request merged into `main`', 'AutoWorker started merging `' + 'f'.repeat(40) + '`, the head of `main` when this attempt started', 'Finish that merge first'],
      [],
    ],
    ["a behavior rework holds Verify's evidence", [...passedOnce.slice(0, 2), entry('verify', 'behavior_fail')], stillWrong, ['found the behavior still wrong', 'Property "level" is missing in type GameState'], []],
    ['a review rework holds the review', [...passedOnce, entry('land', 'changes_requested')], reviewed, ['a review asked for changes', 'Rename the helper.'], []],
    ['a first Implement is told nothing came back', passedOnce.slice(0, 1), null, ['Plan:'], ['sent the task back', 'Your last attempt']],
  ];
  return cases.map(([what, earlier, obligation, has, lacks]) => {
    const name = `Implement's input renders what its rework owes: ${what}`;
    const given = reworkInput(earlier, obligation);
    const missing = has.filter(part => !given.includes(part));
    const extra = lacks.filter(part => given.includes(part));
    return missing.length === 0 && extra.length === 0 ? pass(name, given.slice(-300)) : fail(name, `${missing.length === 0 ? '' : `lacks ${missing.join('; ')}. `}${extra.length === 0 ? '' : `holds ${extra.join('; ')}. `}${given}`);
  });
}

const verdictedVerify = (evidence: Reproduction, pullRequest: PullRequestFact) => ({
  step: 'verify',
  verdict: 'pass' as const,
  ticket: { key: 'SBX-1', title: 'Add clamp', description: null },
  repository: { github: 'example/sandbox', branch: 'main' },
  taskBranch: { name: 'autoworker/SBX-1', head: head },
  attempt: { branch: 'autoworker/SBX-1-attempt-3', start: head, lastPushed: null },
  branches: [],
  pullRequest,
  firstPass: true,
  startStatus: null,
  endStatus: null,
  ends: false,
  output: { outcome: 'done', summary: 'The agent says anything it likes.', blocks: [], behavior: 'fixed' },
  evidence,
});

const shownEvidence = z.object({ kind: z.literal('pr.evidence'), payload: z.object({ number: z.int(), evidence: z.string() }) });

function pullEvidenceChecks(): readonly Check[] {
  const rounds: readonly (readonly [string, string])[] = [
    ['the first passing Verify', head],
    ['a later passing Verify, after a return to Implement', 'd'.repeat(40)],
  ];
  return rounds.map(([what, commit]) => {
    const name = `${what} owes the pull request the engine's recorded evidence, not the agent's prose (F4)`;
    const owed = agentSteps.owes(verdictedVerify(ranBoth(side(base, ran(1)), side(commit, ran(0))), { kind: 'opened', number: 7 })).flatMap(entry => shownEvidence.safeParse(entry).data ?? []);
    const text = owed[0]?.payload.evidence ?? '';
    const good = owed.length === 1 && owed[0]?.payload.number === 7 && text.includes(commit) && !text.includes('The agent says');
    return good ? pass(name, `${String(text.length)} characters naming ${commit.slice(0, 8)}, to pull request 7`) : fail(name, `${String(owed.length)} pr.evidence rows: ${text.slice(0, 200)}`);
  });
}

const unopened: readonly (readonly [string, PullRequestFact])[] = [
  ["the draft's opening is still owed, so no pull request number exists yet", { kind: 'owed' }],
  ['no draft was ever owed', { kind: 'none' }],
];

function unopenedEvidenceChecks(): readonly Check[] {
  return unopened.map(([what, pullRequest]) => {
    const name = `a passing Verify owes no pr.evidence when ${what}, because the row would name no pull request`;
    const owed = agentSteps.owes(verdictedVerify(ranBoth(side(base, ran(1)), side(head, ran(0))), pullRequest)).map(entry => entry.kind);
    return owed.includes('pr.evidence') ? fail(name, owed.join(', ')) : pass(name, owed.join(', '));
  });
}

function promptCheck(): Check {
  const name = "Verify's core prompt names the script path the Job reads";
  const found = workflow.steps.find(kind => kind.name === 'verify');
  const prompt = found?.runBy === 'agent' ? found.prompt : '';
  return prompt.includes(`\`${reproductionPath}\``) ? pass(name, reproductionPath) : fail(name, `the prompt does not name ${reproductionPath}`);
}

const settings = { Checks: 2, Ignorable: 1, QueueSettings: 2, ReviewSettings: 2, DraftSettings: 2 } as const;

type StateView = {
  readonly repo: { readonly draft: string };
  readonly check: ReadonlyMap<string, string>;
  readonly draft: boolean;
  readonly conflict: boolean;
  readonly reviews: number;
  readonly lastReview: string;
  readonly queue: string;
  readonly mergedAt: number | undefined;
  readonly task: string;
  readonly landFails: number;
  readonly seen: number;
  readonly row: string;
  readonly inflight: number | undefined;
  readonly judged: readonly number[];
};

type TraceView = Pick<TlcRun, 'loopActions' | 'stutters'> & {
  readonly actions: readonly string[];
  readonly states: readonly StateView[];
  readonly last: StateView;
  readonly beforeLast: StateView;
  readonly loop: readonly StateView[];
};

const entriesIn = (value: string): ReadonlyMap<string, string> =>
  new Map([...value.matchAll(/(\w+):>(\w+)/g)].map(([, key = '', entry = '']): [string, string] => [key, entry]));

const fieldsIn = (record: string): ReadonlyMap<string, string> =>
  new Map([...record.matchAll(/(\w+)\|->(\w+)/g)].map(([, name = '', field = '']): [string, string] => [name, field]));

const headIn = (value: string): number | undefined => (value === 'NoHead' ? undefined : Number.parseInt(value, 10));

const headsIn = (set: string): readonly number[] => [...set.matchAll(/(\d+)/g)].map(([, head = '']) => Number.parseInt(head, 10));

function viewOf(text: string): StateView {
  const variables = variablesIn(text);
  const variable = (name: string): string => variables.get(name) ?? '';
  const count = (name: string): number => Number.parseInt(variable(name), 10);
  return {
    repo: { draft: fieldsIn(variable('repo')).get('draft') ?? '' },
    check: entriesIn(variable('check')),
    draft: variable('draft') === 'TRUE',
    conflict: variable('conflict') === 'TRUE',
    reviews: count('reviews'),
    lastReview: variable('lastReview'),
    queue: variable('queue'),
    mergedAt: headIn(variable('mergedAt')),
    task: variable('task'),
    landFails: count('landFails'),
    seen: count('seen'),
    row: variable('row'),
    inflight: headIn(variable('inflight')),
    judged: headsIn(variable('judged')),
  };
}

function traceViewOf(run: TlcRun): TraceView {
  const real = realStates(run);
  return {
    actions: actionsOf(run),
    states: run.trace.map(state => viewOf(state.text)),
    last: viewOf(real.at(-1)?.text ?? ''),
    beforeLast: viewOf(real.at(-2)?.text ?? ''),
    loop: run.loop.map(state => viewOf(state.text)),
    loopActions: run.loopActions,
    stutters: run.stutters,
  };
}

const shape = (label: string, holds: (trace: TraceView) => boolean): Shape => ({ label, holds: run => holds(traceViewOf(run)) });

const landActions: ReadonlySet<string> = new Set(['Complete', 'FailAttempt', 'SendBack', 'MarkReady', 'AnswerReview', 'AwaitApproval', 'OweMerge', 'Resume']);

const mergeActions: ReadonlySet<string> = new Set(['Perform', 'Arrive', 'QueueMerges']);

const sendBackActions: ReadonlySet<string> = new Set(['SendBack', 'AnswerReview']);

const countedCheck = 'c1';

const endsIn = (actions: readonly string[], wanted: ReadonlySet<string>): boolean => wanted.has(actions.at(-1) ?? '');

const inOrder = (actions: readonly string[], wanted: readonly string[]): boolean =>
  actions.reduce((matched, action) => (action === wanted[matched] ? matched + 1 : matched), 0) === wanted.length;

const followsLastOweMerge = (actions: readonly string[], action: string): boolean => {
  const owed = actions.lastIndexOf('OweMerge');
  return owed >= 0 && actions.slice(owed + 1).includes(action);
};

const holdsForever = ({ stutters, last, loop }: TraceView, holds: (view: StateView) => boolean): boolean => {
  const forever = stutters ? [last] : loop;
  return forever.length > 0 && forever.every(holds);
};

const mergedPastJudged = ({ mergedAt, judged }: StateView): boolean => mergedAt !== undefined && judged.every(head => head < mergedAt);

const mergesSentBackTask = ({ actions, beforeLast }: TraceView): boolean => endsIn(actions, mergeActions) && beforeLast.task === 'implement';

const landMovesOn = ({ actions, last }: TraceView): boolean => endsIn(actions, landActions) && last.task !== 'implement';

const mergeOfHeadPushedAfterRead = shape(
  'by a merge of a head pushed after the state was read',
  ({ actions, last }) => followsLastOweMerge(actions, 'OutsidePush') && endsIn(actions, mergeActions) && mergedPastJudged(last),
);

const mergeAfterReviewSentBack = shape('by a merge performed after a review sent the task back', trace => {
  const read = trace.states[trace.actions.lastIndexOf('AnswerReview') - 1];
  return inOrder(trace.actions, ['OweMerge', 'AnswerReview']) && read !== undefined && read.row !== 'none' && mergesSentBackTask(trace);
});

const mergeAfterRedCheckSentBack = shape(
  'by a merge performed after a check turned red and sent the task back',
  trace =>
    inOrder(trace.actions, ['OweMerge', 'Rerun', 'Finish', 'SendBack']) && trace.states.every(state => state.queue !== 'queued') && mergesSentBackTask(trace),
);

const queueMergesAfterSendBack = shape('by the queue merging after Land sent the task back', trace => {
  const sentBack = trace.actions.findLastIndex(action => sendBackActions.has(action));
  return (
    sentBack >= 0 &&
    trace.states.slice(0, sentBack).some(state => state.queue === 'queued') &&
    trace.actions.at(-1) === 'QueueMerges' &&
    mergesSentBackTask(trace)
  );
});

const failedCallLandsAfterSendBack = shape("by a failed call's request landing after Land sent the task back", trace => {
  const { actions, states } = trace;
  const released = states.findIndex((state, index) => actions[index] === 'Perform' && state.inflight !== undefined && state.row === 'owed');
  return released >= 0 && actions.slice(released + 1).some(action => sendBackActions.has(action)) && actions.at(-1) === 'Arrive' && mergesSentBackTask(trace);
});

const mergeAfterStop = shape(
  'by a merge performed after a person stopped the task',
  ({ actions, beforeLast, last }) =>
    followsLastOweMerge(actions, 'Stop') && actions.at(-1) === 'Perform' && beforeLast.task === 'stopped' && last.mergedAt !== undefined,
);

const readyWhileCheckNotGreen = shape(
  'by a draft marked ready while its counted check is not green',
  ({ actions, beforeLast }) =>
    actions.at(-1) === 'MarkReady' && beforeLast.draft && beforeLast.repo.draft === 'whenGreen' && beforeLast.check.get(countedCheck) !== 'green',
);

const landMovesPastRedCheck = shape(
  'by Land moving past a red check',
  trace =>
    landMovesOn(trace) &&
    trace.actions.at(-1) !== 'SendBack' &&
    trace.beforeLast.check.get(countedCheck) === 'red' &&
    trace.beforeLast.repo.draft === 'whenGreen',
);

const landMovesPastConflict = shape('by Land moving past a conflict', trace => landMovesOn(trace) && trace.beforeLast.conflict);

const rejoinsQueueAfterEjection = shape(
  'by Land joining the queue again in the attempt the queue ejected',
  ({ actions, beforeLast, last }) =>
    actions.slice(0, -1).includes('QueueEjects') && actions.at(-1) === 'OweMerge' && beforeLast.queue === 'ejected' && last.landFails === beforeLast.landFails,
);

const refusedMergeOwedForever = shape(
  'by a merge GitHub keeps refusing while Land keeps owing it',
  trace =>
    holdsForever(trace, view => view.task === 'land') &&
    ['OweMerge', 'Perform'].every(action => trace.loopActions.includes(action)) &&
    !trace.loopActions.includes('FailAttempt'),
);

const changesUnansweredWhileAwaiting = shape(
  'by a changes request left unanswered while the task awaits approval',
  trace => holdsForever(trace, view => view.task === 'awaiting' && view.lastReview === 'changes' && view.reviews > view.seen),
);

const landNeverPolls = shape(
  'by a task left in Land while Land never polls',
  trace => holdsForever(trace, view => view.task === 'land') && !trace.loopActions.some(action => landActions.has(action)),
);

const directMerge = { QueueSettings: '{FALSE}', ReviewSettings: '{FALSE}', DraftSettings: '{"whenGreen"}' } as const;

const queueMerge = { QueueSettings: '{TRUE}', ReviewSettings: '{FALSE}', DraftSettings: '{"whenGreen"}' } as const;

const noReviewers = { MaxReviews: '0' } as const;

const landModel: Scenario = defineModel({
  name: 'land',
  module: new URL('Land.tla', import.meta.url),
  configs: {
    pr: { file: 'Land.cfg', floors: { ...settings, LaterReviewSettings: 1, MaxPushes: 2, MaxReviews: 2, MaxReruns: 1, MaxEjections: 1, MaxCallFailures: 1 } },
    nightly: { file: 'Land.nightly.cfg', floors: { ...settings, LaterReviewSettings: 2, MaxPushes: 3, MaxReviews: 2, MaxReruns: 1, MaxEjections: 2, MaxCallFailures: 1 } },
  },
  guards: [
    'ActionCarriesHead',
    'ReadyWaitsForGreen',
    'RedCheckSendsBack',
    'ConflictSendsBack',
    'EjectionEndsAttempt',
    'LandPollIsFair',
    'LandWaitsForMergeRow',
    'LandWaitsWhileQueued',
    'FailedMergeKeepsClaim',
    'MergeClaimChecksTask',
    'RefusalFailsAttempt',
    'AnyReviewResumesLand',
  ],
  properties: {
    MergedHeadWasMergeable: 'INVARIANTS',
    PerformedMergeWasAllowed: 'PROPERTIES',
    ReadyOnlyWhenChecksGreen: 'PROPERTIES',
    RedCheckReturnsToImplement: 'PROPERTIES',
    ConflictReturnsToImplement: 'PROPERTIES',
    EjectionFailsLand: 'PROPERTIES',
    LandSettles: 'PROPERTIES',
  },
  liveness: ['LandSettles'],
  mutants: [
    { guard: 'ActionCarriesHead', property: 'MergedHeadWasMergeable', overrides: { ...directMerge, ...noReviewers }, shape: mergeOfHeadPushedAfterRead },
    { guard: 'LandWaitsForMergeRow', property: 'PerformedMergeWasAllowed', overrides: directMerge, shape: mergeAfterReviewSentBack },
    { guard: 'LandWaitsForMergeRow', property: 'PerformedMergeWasAllowed', overrides: { ...directMerge, ...noReviewers }, shape: mergeAfterRedCheckSentBack },
    { guard: 'LandWaitsWhileQueued', property: 'PerformedMergeWasAllowed', overrides: { ...queueMerge, ...noReviewers }, shape: queueMergesAfterSendBack },
    { guard: 'FailedMergeKeepsClaim', property: 'PerformedMergeWasAllowed', overrides: directMerge, shape: failedCallLandsAfterSendBack },
    { guard: 'MergeClaimChecksTask', property: 'PerformedMergeWasAllowed', overrides: { ...directMerge, ...noReviewers }, shape: mergeAfterStop },
    { guard: 'ReadyWaitsForGreen', property: 'ReadyOnlyWhenChecksGreen', overrides: directMerge, shape: readyWhileCheckNotGreen },
    { guard: 'RedCheckSendsBack', property: 'RedCheckReturnsToImplement', overrides: directMerge, shape: landMovesPastRedCheck },
    { guard: 'ConflictSendsBack', property: 'ConflictReturnsToImplement', overrides: { QueueSettings: '{FALSE}', ReviewSettings: '{FALSE}' }, shape: landMovesPastConflict },
    { guard: 'EjectionEndsAttempt', property: 'EjectionFailsLand', overrides: { ...queueMerge, ...noReviewers }, shape: rejoinsQueueAfterEjection },
    { guard: 'RefusalFailsAttempt', property: 'LandSettles', overrides: { ...directMerge, ...noReviewers }, shape: refusedMergeOwedForever },
    { guard: 'AnyReviewResumesLand', property: 'LandSettles', overrides: { QueueSettings: '{FALSE}', ReviewSettings: '{TRUE}', DraftSettings: '{"whenGreen"}' }, shape: changesUnansweredWhileAwaiting },
    { guard: 'LandPollIsFair', property: 'LandSettles', overrides: { ...directMerge, ...noReviewers }, shape: landNeverPolls },
  ],
});

const simulationFlags = {
  seeds: { type: 'string' },
  from: { type: 'string' },
  seed: { type: 'string' },
  steps: { type: 'string' },
  tasks: { type: 'string' },
  mutant: { type: 'string' },
} as const;

const simulationOptions = z.object({
  seeds: z.coerce.number().int().positive().default(200),
  from: z.coerce.number().int().nonnegative().default(1),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(150),
  tasks: z.coerce.number().int().positive().default(6),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const seedsOf = (options: SimulationOptions): readonly number[] =>
  options.seed === undefined ? Array.from({ length: options.seeds }, (_, index) => options.from + index) : [options.seed];

const replay = (run: Run, options: SimulationOptions): string =>
  `npm run verify -- land-sim${run.mutant === undefined ? '' : ` --mutant ${run.mutant}`} --seed ${String(run.seed)} --steps ${String(options.steps)} --tasks ${String(options.tasks)}`;

function violation(run: Run, options: SimulationOptions): string {
  if (run.failure === undefined) return `seed ${String(run.seed)} broke nothing`;
  const { step, move, broken } = run.failure;
  const found = broken.slice(0, 3).map(entry => `${entry.property}: ${entry.detail}`);
  return `seed ${String(run.seed)}, step ${String(step)}, after ${move}: ${found.join('; ')}; replay: ${replay(run, options)}; last moves: ${run.trace.slice(-6).join(' | ')}`;
}

const merged = (runs: readonly Run[]): Readonly<Record<string, number>> =>
  runs.reduce<Record<string, number>>((total, run) => {
    for (const [key, count] of Object.entries(run.settled)) total[key] = (total[key] ?? 0) + count;
    return total;
  }, {});

async function guardedCheck(options: SimulationOptions): Promise<Check> {
  const started = performance.now();
  const runs = await simulate({ seeds: seedsOf(options), steps: options.steps, tasks: options.tasks });
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.find(run => run.failure !== undefined);
  const name = `every guard on: ${String(runs.length)} seeds, ${String(runs.filter(run => run.failure !== undefined).length)} violations`;
  const settled = Object.entries(merged(runs))
    .map(([state, count]) => `${String(count)} ${state}`)
    .join(', ');
  return failed === undefined ? pass(name, `${String(options.steps)} steps each plus a quiet phase, in ${seconds.toFixed(1)} s; tasks ended ${settled}`) : fail(name, violation(failed, options));
}

async function mutantCheck(mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const breaks = mutants[mutant];
  const plan = { seeds: seedsOf(options), steps: options.steps, tasks: options.tasks, mutant };
  const name = `without ${mutant}: ${breaks} violated`;
  for (const seed of plan.seeds) {
    const run = await runSeed(plan, seed);
    if (run.failure?.broken.some(found => found.property === breaks) === true) return pass(name, violation(run, options));
  }
  return fail(name, `no seed of ${String(plan.seeds.length)} broke ${breaks}`);
}

async function simulationChecks(args: readonly string[]): Promise<readonly Check[]> {
  const options = parseSimulationOptions(args);
  const chosen = options.mutant === undefined ? [] : options.mutant === 'all' ? mutantName.options : [options.mutant];
  return [await guardedCheck(options), ...(await Promise.all(chosen.map(mutant => mutantCheck(mutant, options))))];
}

const parked = (lane: string): Check => fail(`${lane} is parked`, 'PARKED: gate 1. The sandbox GitHub token is read-only, so AutoWorker cannot open, mark ready, or merge a pull request until the owner regrants it.');

export const scenarios: readonly Scenario[] = [
  {
    name: 'code-change',
    summary: "checks the Code change declaration against the task model's shape and runs each step's judge on reviews of every outcome",
    run: () => Promise.resolve([shapeCheck(), builtCheck(), ...judgeChecks(), ...settleChecks(), unrunnableCheck(), ...pullEvidenceChecks(), ...unopenedEvidenceChecks(), ...implementChecks(), ...sentBackChecks(), ...reworkChecks(), longScriptCheck(), promptCheck()]),
  },
  landModel,
  {
    name: 'land-sim',
    summary: "runs Land's real decision table and pass against a seeded fake of GitHub and the outbox, and checks each property of Land.tla by name; --mutant turns one guard off",
    run: simulationChecks,
    nightly: day => [['--seeds', '1000', '--from', String(day * 1000)]],
  },
  {
    name: 'land-live',
    summary: 'seeds a task at Land with a pull request from a probe branch, and prints each state Land read and each action it owed, up to merged',
    run: () => Promise.resolve([parked('land-live')]),
  },
];
