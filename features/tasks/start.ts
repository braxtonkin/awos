import type { Database } from '../../shared/db/client.ts';
import { builtByStep, type StepKind, type Workflow } from '../../shared/workflow.ts';

export type Workflows = ReadonlyMap<string, Workflow>;

const slug = /^[a-z][a-z0-9-]{0,63}$/;

function problemsOf(workflow: Workflow): readonly string[] {
  const names = workflow.steps.map(kind => kind.name);
  const earlier = (kind: StepKind): readonly string[] => names.slice(0, names.indexOf(kind.name));
  const counters = workflow.steps.flatMap(kind => Object.values(kind.failures).flatMap(failure => ('counter' in failure ? [failure.counter] : [])));
  const last = workflow.steps.at(-1);
  return [
    ...(slug.test(workflow.name) ? [] : [`its name must match ${slug.source}`]),
    ...names.filter(name => !slug.test(name)).map(name => `the step name ${name} must match ${slug.source}`),
    ...names.filter((name, index) => names.indexOf(name) !== index).map(name => `it names the step ${name} twice`),
    ...counters.filter((counter, index) => counters.indexOf(counter) !== index).map(counter => `two failures charge the counter ${counter}`),
    ...(last === undefined || last.canEnd ? [] : [`its last step, ${last.name}, must be able to end the task`]),
    ...workflow.steps.flatMap(kind => [
      ...kind.reads.filter(read => !earlier(kind).includes(read)).map(read => `${kind.name} reads ${read}, which is not an earlier step`),
      ...(builtByStep(kind) ? [] : [`${kind.name} was not built by step(), so its judge may not match its declaration. Build each step with step() and never spread one into another`]),
      ...Object.values(kind.failures).flatMap(failure => {
        const target = 'to' in failure && !earlier(kind).includes(failure.to) ? [`${kind.name} sends a failure back to ${failure.to}, which is not an earlier step`] : [];
        const cap = 'cap' in failure && !(Number.isInteger(failure.cap) && failure.cap >= 1) ? [`${kind.name} caps ${failure.counter} at ${String(failure.cap)}, which is not a positive whole number`] : [];
        return [...target, ...cap];
      }),
    ]),
  ];
}

export function workflowsByName(list: readonly Workflow[]): Workflows {
  const byName = new Map(list.map(workflow => [workflow.name, workflow]));
  const problems = [
    ...list.flatMap(workflow => problemsOf(workflow).map(problem => `The workflow ${workflow.name}: ${problem}.`)),
    ...(byName.size < list.length ? ['Two workflows share a name. Give each workflow its own name in its declaration.'] : []),
  ];
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return byName;
}

export async function startProblems(db: Database, workflows: Workflows): Promise<readonly string[]> {
  const versions = await db
    .selectFrom('routine_version as version')
    .select(['version.routine_id', 'version.version', 'version.workflow'])
    .where(eb =>
      eb.or([
        eb('version.version', '=', eb.selectFrom('routine_version as newest').select(newest => newest.fn.max('newest.version').as('newest')).whereRef('newest.routine_id', '=', 'version.routine_id')),
        eb.exists(
          eb
            .selectFrom('task')
            .select('task.id')
            .whereRef('task.routine_id', '=', 'version.routine_id')
            .whereRef('task.found_version', '=', 'version.version')
            .where('task.state', '<>', 'done'),
        ),
      ]),
    )
    .orderBy('version.routine_id')
    .orderBy('version.version')
    .execute();
  return versions
    .filter(version => !workflows.has(version.workflow))
    .map(
      version =>
        `Routine ${version.routine_id} version ${String(version.version)} uses the workflow ${version.workflow}, which this engine was not given. Add its feature folder to services/engine/workflows.ts, or save the routine with one of: ${[...workflows.keys()].join(', ')}.`,
    );
}
