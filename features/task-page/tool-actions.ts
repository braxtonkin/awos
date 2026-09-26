import { z } from 'zod';

export type Action = { readonly kind: 'command' | 'read' | 'change'; readonly what: string };

const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh -l?c (['"])(.*)\1$/s;

export const shownCommand = (command: string): string => {
  const found = wrapped.exec(command);
  if (found?.[2] === undefined) return command;
  return found[1] === "'" ? found[2].replaceAll("'\\''", "'") : found[2];
};

const toolItem = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  commandActions: z.array(z.looseObject({ type: z.string(), path: z.string().nullable().optional(), name: z.string().nullable().optional() })).optional(),
  changes: z.array(z.looseObject({ path: z.string() })).optional(),
});

export function actionOf(item: unknown): Action | undefined {
  const parsed = toolItem.safeParse(item);
  if (!parsed.success) return undefined;
  const { command, commandActions, changes } = parsed.data;
  const reads = (commandActions ?? []).flatMap(action => (action.type === 'read' ? [action.path ?? action.name ?? ''] : []));
  if (reads.length > 0 && reads.length === commandActions?.length && reads.every(path => path !== '')) return { kind: 'read', what: reads.join(', ') };
  if (command !== undefined) return { kind: 'command', what: shownCommand(command) };
  if (changes !== undefined && changes.length > 0) return { kind: 'change', what: changes.map(change => change.path.split('/').slice(-2).join('/')).join(', ') };
  return undefined;
}

const verbs: Readonly<Record<Action['kind'], readonly [string, string]>> = { command: ['Running', 'Ran'], read: ['Reading', 'Read'], change: ['Changing', 'Changed'] };

export const actionLine = (action: Action, running: boolean): string => `${verbs[action.kind][running ? 0 : 1]} ${action.what}`;

export const verbOf = (action: Action, running: boolean): string => verbs[action.kind][running ? 0 : 1];
