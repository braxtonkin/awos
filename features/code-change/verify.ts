import { builtByStep, shapeOf, type StepVerdict } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { modelShape, shapeDrift } from '../../tools/verify/model-shape.ts';
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

export const scenarios: readonly Scenario[] = [
  {
    name: 'code-change',
    summary: "checks the Code change declaration against the task model's shape and runs each step's judge on reviews of every outcome",
    run: () => Promise.resolve([shapeCheck(), builtCheck(), ...judgeChecks()]),
  },
];
