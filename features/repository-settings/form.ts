import type { z } from 'zod';
import { repositorySave, type RepositorySave } from '../../shared/repository-settings.ts';
import { fields, type Field, type Problems } from './protocol.ts';

type Entry = ReturnType<FormData['get']>;

const text = (value: Entry): string => (typeof value === 'string' ? value : '');

const optional = (value: Entry): string | null => (text(value).trim() === '' ? null : text(value).trim());

const lines = (value: Entry): readonly string[] =>
  text(value)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');

const fieldOf = (path: readonly PropertyKey[]): Field => fields.find(field => path.includes(field)) ?? 'github';

const problemsOf = (error: z.ZodError): Problems => {
  const found: Partial<Record<Field, string>> = {};
  for (const issue of error.issues) found[fieldOf(issue.path)] ??= issue.message;
  return found;
};

export function saveFrom(form: FormData): { readonly save: RepositorySave } | { readonly problems: Problems } {
  const id = text(form.get('repository'));
  const parsed = repositorySave.safeParse({
    repository: id === '' ? { kind: 'new', github: text(form.get('github')).trim() } : { kind: 'listed', id },
    branch: text(form.get('branch')),
    image: optional(form.get('image')),
    fastTestCommand: optional(form.get('fastTestCommand')),
    setupCommand: optional(form.get('setupCommand')),
    verifyProvider: text(form.get('verifyProvider')),
    ignorableChecks: lines(form.get('ignorableChecks')),
    draftLeaves: text(form.get('draftLeaves')),
    ignoredReviewers: lines(form.get('ignoredReviewers')),
  });
  return parsed.success ? { save: parsed.data } : { problems: problemsOf(parsed.error) };
}
