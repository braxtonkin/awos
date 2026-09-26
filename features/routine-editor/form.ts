import { z } from 'zod';
import { jiraSearch, routineDraft, type RoutineDraft } from '../../shared/routine-draft.ts';

export const fields = {
  routine: 'routine',
  request: 'request',
  from: 'from',
  name: 'name',
  goal: 'goal',
  workflow: 'workflow',
  sourceKind: 'source-kind',
  jql: 'jql',
  pageSize: 'page-size',
  startStatus: 'start-status',
  endStatus: 'end-status',
  everyMinutes: 'every-minutes',
  repository: 'repository',
  runAs: 'run-as',
  gate: 'gate',
  lastStep: 'last-step',
  ignoreLaterReviews: 'ignore-later-reviews',
} as const;

export const instructionsField = (step: string): string => `instructions:${step}`;

export const skillsField = (step: string): string => `skills:${step}`;

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

const orNull = (value: string): string | null => (value.trim() === '' ? null : value);

const stepPrefix = instructionsField('');

function stepsFrom(form: FormData): Record<string, { readonly instructions: string; readonly skills: readonly string[] }> {
  const steps = [...form.keys()].filter(key => key.startsWith(stepPrefix)).map(key => key.slice(stepPrefix.length));
  return Object.fromEntries(
    steps.flatMap(step => {
      const instructions = text(form, instructionsField(step)).trim();
      const skills = text(form, skillsField(step))
        .split(/[\s,]+/)
        .filter(skill => skill !== '');
      return instructions === '' && skills.length === 0 ? [] : [[step, { instructions, skills }]];
    }),
  );
}

function draftInput(form: FormData): unknown {
  const kind = text(form, fields.sourceKind);
  const pageSize = orNull(text(form, fields.pageSize));
  const from = orNull(text(form, fields.from));
  return {
    from: from === null ? null : Number(from),
    name: text(form, fields.name),
    goal: text(form, fields.goal),
    workflow: text(form, fields.workflow),
    source: kind === jiraSearch ? { kind, jql: text(form, fields.jql), ...(pageSize === null ? {} : { pageSize: Number(pageSize) }) } : { kind },
    jiraStartStatus: orNull(text(form, fields.startStatus)),
    jiraEndStatus: orNull(text(form, fields.endStatus)),
    ignoreLaterReviews: text(form, fields.ignoreLaterReviews) === 'true',
    everyMinutes: Number(text(form, fields.everyMinutes)),
    repository: orNull(text(form, fields.repository)),
    runAs: orNull(text(form, fields.runAs)),
    gates: form.getAll(fields.gate).filter(gate => typeof gate === 'string'),
    lastStep: orNull(text(form, fields.lastStep)),
    steps: stepsFrom(form),
  };
}

const labels: Readonly<Record<string, string>> = {
  from: 'The version you opened',
  name: 'The name',
  goal: 'The goal',
  workflow: 'The workflow',
  jiraStartStatus: 'The Jira status when work starts',
  jiraEndStatus: 'The Jira status when work ends',
  ignoreLaterReviews: 'The later reviews setting',
  everyMinutes: 'The interval',
  repository: 'The repository',
  runAs: 'Run as',
  gates: 'A gate',
  lastStep: 'The last step',
};

const sourceLabels: Readonly<Record<string, string>> = { kind: 'The source', jql: 'The JQL', pageSize: 'The page size' };

function labelOf(path: readonly PropertyKey[]): string {
  const [field, detail, part] = path.map(String);
  if (field === 'source') return sourceLabels[detail ?? 'kind'] ?? 'The source';
  if (field === 'steps') return `${part === 'skills' ? 'The skills' : 'The instructions'} for ${detail ?? 'a step'}`;
  return labels[field ?? ''] ?? 'The routine';
}

const sentence = (issue: z.core.$ZodIssue): string => `${labelOf(issue.path)} ${issue.message}.`;

export type Parsed = { readonly draft: RoutineDraft } | { readonly problems: readonly string[] };

export function draftFrom(form: FormData): Parsed {
  const parsed = routineDraft.safeParse(draftInput(form));
  return parsed.success ? { draft: parsed.data } : { problems: [...new Set(parsed.error.issues.map(sentence))] };
}
