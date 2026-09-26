import { z } from 'zod';

export const words = z.string().trim().min(1, { error: 'must not be blank' });

export const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, { error: 'must be lowercase letters, digits, and dashes, starting with a letter' });

const skill = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: 'must be lowercase letters, digits, and dashes' });

export const jiraSearch = 'jira-search';

const onlyJiraSearch = `belongs only to a ${jiraSearch} source`;

export const source = z
  .strictObject({ kind: slug, jql: words.optional(), pageSize: z.int().min(1).max(100).optional() })
  .superRefine(({ kind, jql, pageSize }, context) => {
    const problems = [
      ...(kind === jiraSearch && jql === undefined ? [{ field: 'jql', message: `must hold the JQL query a ${jiraSearch} source searches with` }] : []),
      ...(kind !== jiraSearch && jql !== undefined ? [{ field: 'jql', message: onlyJiraSearch }] : []),
      ...(kind !== jiraSearch && pageSize !== undefined ? [{ field: 'pageSize', message: onlyJiraSearch }] : []),
    ];
    for (const { field, message } of problems) context.issues.push({ code: 'custom', path: [field], message, input: undefined });
  });

export type Source = z.output<typeof source>;

const dayMinutes = 24 * 60;

export const everyMinutes = z
  .number({ error: 'must be a whole number of minutes' })
  .int({ error: 'must be a whole number of minutes' })
  .min(1, { error: 'must be at least 1 minute' })
  .max(dayMinutes, { error: `must be at most ${dayMinutes.toLocaleString('en-US')} minutes, one day` });

export const stepSettings = z.record(slug, z.strictObject({ instructions: z.string().default(''), skills: z.array(skill).default([]) }));

const id = z.string().regex(/^[1-9]\d*$/, { error: 'must name one of the listed choices' });

export const routineDraft = z.strictObject({
  from: z.int().min(1).nullable(),
  name: words,
  goal: words,
  workflow: slug,
  source,
  jiraStartStatus: words.nullable(),
  jiraEndStatus: words.nullable(),
  ignoreLaterReviews: z.boolean(),
  everyMinutes,
  repository: id.nullable(),
  runAs: id.nullable(),
  gates: z.array(slug),
  lastStep: slug.nullable(),
  steps: stepSettings,
});

export type RoutineDraft = z.output<typeof routineDraft>;
