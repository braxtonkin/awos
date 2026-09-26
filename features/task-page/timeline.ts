import { z } from 'zod';
import { emptyTranscript, reduce } from '../../shared/items.ts';
import type { AttemptSummary, AttemptTranscript, Line } from './protocol.ts';
import { actionOf, type Action } from './tool-actions.ts';

const itemOf = z.looseObject({ params: z.looseObject({ item: z.looseObject({ id: z.string() }).optional(), itemId: z.string().optional() }) });

function extendOne(start: AttemptTranscript, lines: readonly Line[]): AttemptTranscript {
  const times: Record<string, string> = { ...start.times };
  const actions: Record<string, Action> = { ...start.actions };
  for (const line of lines) {
    const parsed = itemOf.safeParse(line.body);
    if (!parsed.success) continue;
    const { item, itemId } = parsed.data.params;
    const id = item?.id ?? itemId;
    if (id !== undefined) times[id] ??= line.at;
    const action = item === undefined ? undefined : actionOf(item);
    if (item !== undefined && action !== undefined) actions[item.id] = action;
  }
  return { attempt: start.attempt, transcript: reduce(lines, start.transcript), times, actions };
}

export function extend(attempts: readonly AttemptTranscript[], lines: readonly Line[]): readonly AttemptTranscript[] {
  const byAttempt = Map.groupBy(lines, line => line.attempt);
  const known = attempts.map(each => {
    const added = byAttempt.get(each.attempt);
    return added === undefined ? each : extendOne(each, added);
  });
  const fresh = [...byAttempt]
    .filter(([id]) => !attempts.some(each => each.attempt === id))
    .map(([id, added]) => extendOne({ attempt: id, transcript: emptyTranscript, times: {}, actions: {} }, added));
  return [...known, ...fresh].toSorted((a, b) => Number(a.attempt) - Number(b.attempt));
}

export const numbered = (attempts: readonly AttemptSummary[], id: string): number => {
  const found = attempts.find(each => each.id === id);
  return found === undefined ? 0 : attempts.filter(each => each.step === found.step && Number(each.id) <= Number(id)).length;
};
