import { builtByStep, shapeOf, type StepVerdict } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { modelShape, shapeDrift } from '../../tools/verify/model-shape.ts';
import type { Ran } from '../../shared/agent-step.ts';
import { agentSteps, reproduction } from './stage-output.ts';
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

const run = (command: string, exitCode: number, wrap = true): Ran => ({ command: wrap ? `/bin/bash -lc '${command}'` : command, cwd: '/workspace', exitCode, output: `ran ${command}` });

const script = run(reproduction.show, 0);

const settleCases: readonly (readonly [string, readonly Ran[], 'fixed' | 'still_wrong' | null])[] = [
  ['a failing base run then a passing change run, each wrapped by the shell', [script, run(reproduction.before, 1), run(reproduction.after, 0)], 'fixed'],
  ['the same runs written without the shell wrapper', [script, run(reproduction.before, 1, false), run(reproduction.after, 0, false)], 'fixed'],
  ['a change run that still fails', [script, run(reproduction.before, 1), run(reproduction.after, 1)], 'still_wrong'],
  ['a base run that passes, so nothing was reproduced', [script, run(reproduction.before, 0), run(reproduction.after, 0)], null],
  ['a change run that hides its exit with || true', [script, run(reproduction.before, 1), run(`${reproduction.after} || true`, 0)], null],
  ['the change run before the base run', [script, run(reproduction.after, 0), run(reproduction.before, 1)], null],
  ['no script shown before the runs', [run(reproduction.before, 1), run(reproduction.after, 0), script], null],
];

function settleChecks(): readonly Check[] {
  return settleCases.map(([what, commands, expected]) => {
    const name = `Verify's behavior comes from its stored runs: ${what}`;
    const settled = agentSteps.settle({ step: 'verify', output: { outcome: 'done', summary: 'Ran both.', blocks: [], behavior: 'fixed' }, commands });
    const behavior = typeof settled.output === 'object' && settled.output !== null && 'behavior' in settled.output ? settled.output.behavior : 'missing';
    return behavior === expected ? pass(name, `behavior ${String(expected)}, evidence ${settled.evidence === null ? 'none' : 'stored'}`) : fail(name, `behavior ${String(behavior)}, not ${String(expected)}`);
  });
}

function promptCheck(): Check {
  const name = "Verify's core prompt names each command the engine matches exactly";
  const prompt = workflow.steps.find(kind => kind.name === 'verify')?.prompt ?? '';
  const missing = [reproduction.show, reproduction.before, reproduction.after].filter(command => !prompt.includes(`\`${command}\``));
  return missing.length === 0 ? pass(name, 'all 3') : fail(name, `missing ${missing.join(', ')}`);
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'code-change',
    summary: "checks the Code change declaration against the task model's shape and runs each step's judge on reviews of every outcome",
    run: () => Promise.resolve([shapeCheck(), builtCheck(), ...judgeChecks(), ...settleChecks(), promptCheck()]),
  },
];
