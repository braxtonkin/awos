import { z } from 'zod';

export const fragmentMethods = ['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/commandExecution/outputDelta'] as const;

export type FragmentMethod = (typeof fragmentMethods)[number];

export const isFragmentMethod = (method: string | undefined): method is FragmentMethod => fragmentMethods.some(fragment => fragment === method);

export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';

export type ItemStatus = 'inProgress' | 'completed' | 'abandoned';

export type Item = {
  readonly id: string;
  readonly turnId: string;
  readonly type: string;
  readonly text: string;
  readonly status: ItemStatus;
  readonly clientId: string | null;
};

export type Turn = { readonly id: string; readonly status: TurnStatus; readonly items: readonly string[] };

export type Transcript = { readonly items: readonly Item[]; readonly turns: readonly Turn[] };

const threadItem = z.looseObject({
  id: z.string(),
  type: z.string(),
  text: z.string().optional(),
  summary: z.array(z.string()).optional(),
  aggregatedOutput: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
});

type ThreadItem = z.infer<typeof threadItem>;

const turnStatus = z.enum(['inProgress', 'completed', 'interrupted', 'failed']);

const notification = z.discriminatedUnion('method', [
  z.object({ method: z.enum(['item/started', 'item/completed']), params: z.looseObject({ item: threadItem, turnId: z.string() }) }),
  z.object({ method: z.enum(fragmentMethods), params: z.looseObject({ itemId: z.string(), turnId: z.string(), delta: z.string() }) }),
  z.object({ method: z.literal('turn/started'), params: z.looseObject({ turn: z.looseObject({ id: z.string() }) }) }),
  z.object({ method: z.literal('turn/completed'), params: z.looseObject({ turn: z.looseObject({ id: z.string(), status: turnStatus }) }) }),
]);

function finalText(item: ThreadItem): string | undefined {
  switch (item.type) {
    case 'agentMessage':
      return item.text;
    case 'reasoning':
      return item.summary === undefined || item.summary.length === 0 ? undefined : item.summary.join('\n\n');
    case 'commandExecution':
      return item.aggregatedOutput ?? undefined;
    case 'userMessage':
      return item.content?.flatMap(part => (part.text === undefined ? [] : [part.text])).join('\n');
    default:
      return undefined;
  }
}

type DraftItem = Omit<Item, 'status'> & { readonly completed: boolean };

type Draft = { readonly turns: Map<string, { status: TurnStatus; readonly items: string[] }>; readonly items: Map<string, DraftItem> };

function turnOf(draft: Draft, turnId: string): { status: TurnStatus; readonly items: string[] } {
  const known = draft.turns.get(turnId);
  if (known !== undefined) return known;
  const made = { status: 'inProgress' as TurnStatus, items: [] };
  draft.turns.set(turnId, made);
  return made;
}

function place(draft: Draft, item: DraftItem): void {
  const turn = turnOf(draft, item.turnId);
  if (!draft.items.has(item.id)) turn.items.push(item.id);
  draft.items.set(item.id, item);
}

function step(draft: Draft, body: unknown): void {
  const parsed = notification.safeParse(body);
  if (!parsed.success) return;
  const message = parsed.data;
  switch (message.method) {
    case 'item/started':
    case 'item/completed': {
      const { item, turnId } = message.params;
      const known = draft.items.get(item.id);
      place(draft, {
        id: item.id,
        turnId,
        type: item.type,
        text: finalText(item) ?? known?.text ?? '',
        completed: message.method === 'item/completed' || (known?.completed ?? false),
        clientId: item.clientId ?? known?.clientId ?? null,
      });
      return;
    }
    case 'item/agentMessage/delta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/commandExecution/outputDelta': {
      const { itemId, turnId, delta } = message.params;
      const known = draft.items.get(itemId);
      if (known?.completed === true) return;
      place(draft, known === undefined ? { id: itemId, turnId, type: 'unknown', text: delta, completed: false, clientId: null } : { ...known, text: known.text + delta });
      return;
    }
    case 'turn/started':
      turnOf(draft, message.params.turn.id);
      return;
    case 'turn/completed':
      turnOf(draft, message.params.turn.id).status = message.params.turn.status;
      return;
  }
}

const statusOf = (completed: boolean, turn: TurnStatus | undefined): ItemStatus => (completed ? 'completed' : turn === 'inProgress' ? 'inProgress' : 'abandoned');

export function reduce(lines: Iterable<{ readonly body: unknown }>): Transcript {
  const draft: Draft = { turns: new Map(), items: new Map() };
  for (const line of lines) step(draft, line.body);
  return {
    turns: [...draft.turns].map(([id, turn]) => ({ id, status: turn.status, items: [...turn.items] })),
    items: [...draft.items.values()].map(({ completed, ...item }) => ({ ...item, status: statusOf(completed, draft.turns.get(item.turnId)?.status) })),
  };
}

export function finalMessage(transcript: Transcript): string | undefined {
  const turn = transcript.turns.findLast(candidate => candidate.status !== 'inProgress');
  if (turn === undefined) return undefined;
  const byId = new Map(transcript.items.map(item => [item.id, item]));
  return turn.items
    .map(id => byId.get(id))
    .findLast(item => item?.type === 'agentMessage' && item.status === 'completed')?.text;
}
