import type { z } from 'zod';
import { actionKinds, performer, type Limits, type Owed, type Performers } from '../../shared/actions.ts';
import type { Database } from '../../shared/db/client.ts';
import { jiraAs, type JiraAccess } from './client.ts';

type CommentKind = typeof actionKinds.ticketComment;

type TransitionKind = typeof actionKinds.ticketTransition;

export type JiraKind = CommentKind['kind'] | TransitionKind['kind'];

type CommentPayload = z.output<CommentKind['payload']>;

type TransitionPayload = z.output<TransitionKind['payload']>;

export const markerProperty = 'autoworker';

const quoted = (status: string): string => `"${status}"`;

type Inline = { readonly type: 'text'; readonly text: string; readonly marks?: readonly unknown[] } | { readonly type: 'hardBreak' };

const paragraph = (content: readonly Inline[]) => ({ type: 'paragraph', content });

const lines = (text: string): readonly Inline[] => text.split('\n').flatMap((line, index): readonly Inline[] => [...(index === 0 ? [] : [{ type: 'hardBreak' as const }]), ...(line === '' ? [] : [{ type: 'text' as const, text: line }])]);

const document = (text: string, link: string | null) => ({
  version: 1,
  type: 'doc',
  content: [
    ...text
      .split(/\n\s*\n/)
      .filter(block => block.trim() !== '')
      .map(block => paragraph(lines(block))),
    ...(link === null ? [] : [paragraph([{ type: 'text', text: link, marks: [{ type: 'link', attrs: { href: link } }] }])]),
  ],
});

async function pullRequestOf(db: Database, task: string): Promise<string | null> {
  const opened = await db
    .selectFrom('outbox')
    .select('result')
    .where('task_id', '=', task)
    .where('kind', '=', actionKinds.prOpenDraft.kind)
    .where('state', '=', 'done')
    .orderBy('position', 'desc')
    .executeTakeFirst();
  if (opened === undefined) return null;
  return actionKinds.prOpenDraft.result.parse(opened.result).url;
}

const isMarked = (value: unknown, marker: string): boolean => typeof value === 'object' && value !== null && 'marker' in value && value.marker === marker;

const findComment = (access: JiraAccess) => async (owed: Owed<CommentPayload>, limits: Limits) => {
  const jira = await jiraAs(access, owed.actsAs, limits.signal);
  const me = await jira.myself();
  const comments = await jira.comments(owed.payload.ticket);
  const posted = comments.find(comment => comment.author === me && isMarked(comment.properties.get(markerProperty), owed.marker));
  return posted === undefined ? { absent: true as const } : { found: { comment: posted.id } };
};

const postComment = (access: JiraAccess, db: Database) => async (owed: Owed<CommentPayload>, limits: Limits) => {
  const link = owed.payload.linkPullRequest ? await pullRequestOf(db, owed.task) : null;
  if (owed.payload.linkPullRequest && link === null) return { failed: `Task ${owed.task} has no opened pull request yet, so the comment that links it was not posted.` };
  const jira = await jiraAs(access, owed.actsAs, limits.signal);
  const comment = await jira.comment(owed.payload.ticket, document(owed.payload.text, link), { [markerProperty]: { marker: owed.marker } });
  return { done: { comment } };
};

const moveTicket = (access: JiraAccess) => async (owed: Owed<TransitionPayload>, limits: Limits) => {
  const { ticket, status, from } = owed.payload;
  const jira = await jiraAs(access, owed.actsAs, limits.signal);
  const now = (await jira.ticket(ticket)).status;
  if (now === status) return { done: { status } };
  if (from !== null && now !== from) return { failed: `${ticket} is in ${quoted(now)}, not ${quoted(from)}, so it was not moved to ${quoted(status)}.` };
  const moves = await jira.transitions(ticket);
  const move = moves.find(candidate => candidate.to === status);
  if (move === undefined) {
    return { failed: `${ticket} is in ${quoted(now)}, and no transition from there leads to ${quoted(status)}. Its transitions lead to ${moves.map(candidate => quoted(candidate.to)).join(', ') || 'nothing'}.` };
  }
  await jira.transition(ticket, move.id);
  return { done: { status } };
};

export const jiraPerformers = (access: JiraAccess, db: Database): Performers<JiraKind> => ({
  'ticket.comment': performer(actionKinds.ticketComment, { catches: 'nothing', find: findComment(access), call: postComment(access, db) }),
  'ticket.transition': performer(actionKinds.ticketTransition, { catches: 'duplicates', call: moveTicket(access) }),
});
