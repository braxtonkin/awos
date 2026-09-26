'use client';

import { useState, type ReactNode } from 'react';
import type { ConnectorKind } from '../../shared/db/types.ts';
import type { Mark } from '../../shared/task-status.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { between } from '../../shared/ui/clock.ts';
import { day, nameOf, splitFirst } from './format.ts';
import { actionLink, box, EmptyWorld, Heading, page, taskHref } from './parts.tsx';
import { frame, type Login, type NeedsYou, type TaskRow } from './protocol.ts';

const needsYouStream: Stream = { path: '/stream', after: undefined };

const connectorNames: Readonly<Record<ConnectorKind, string>> = { codex: 'Codex', github: 'GitHub', jira: 'Jira' };

const peoplePage = '/people';

const actions: Readonly<Record<NonNullable<TaskRow['waitingOn']>, string>> = { answer: 'Answer', approval: 'Approve', outside_approval: 'Check', retry: 'Retry' };

const detailText = { fontSize: 13, color: color('muted') } as const;

function Detail({ text }: { readonly text: string }) {
  const { first, rest } = splitFirst(text);
  if (rest === '') return <span style={detailText}>{text}</span>;
  return (
    <details style={detailText}>
      <summary style={{ display: 'block', listStyle: 'none', cursor: 'pointer' }}>
        {first}
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginLeft: 4, verticalAlign: 'middle' }}>
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </summary>
      {rest}
    </details>
  );
}

type RowProps ={ readonly id: string; readonly marks: readonly Mark[]; readonly title: string; readonly label?: string; readonly detail: string; readonly since: string | null; readonly href: string; readonly action: string; readonly divided: boolean; readonly quiet?: boolean };

function Row({ id, marks, title, label, detail, since, href, action, divided, quiet = false }: RowProps) {
  return (
    <li data-row={id} style={{ display: 'grid', gridTemplateColumns: '176px minmax(0, 1fr) 128px 120px', alignItems: 'center', gap: 16, padding: '12px 16px', borderTop: divided ? `1px solid ${color('rule')}` : 'none' }}>
      <StatusMarks marks={marks} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          {label === undefined ? null : <span className="mono" style={{ color: color('muted'), flex: 'none' }}>{label}</span>}
          <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        </span>
        <Detail text={detail} />
      </div>
      <span style={{ fontSize: 13, color: color('muted'), textAlign: 'right' }}>{since}</span>
      <a href={href} data-action={id} style={quiet ? { justifySelf: 'end', fontSize: 13, fontWeight: 500, color: color('muted') } : { ...actionLink, justifySelf: 'end' }}>
        {action}
      </a>
    </li>
  );
}

function Section({ name, title, count, children }: { readonly name: string; readonly title: string; readonly count: number; readonly children: ReactNode }) {
  return (
    <section data-section={name} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, display: 'flex', gap: 8 }}>
        {title}
        <span style={{ fontWeight: 400, color: color('muted') }}>{count}</span>
      </h2>
      <ul style={{ ...box, listStyle: 'none', margin: 0, padding: 0, overflow: 'hidden' }}>{children}</ul>
    </section>
  );
}

const loginSentence = (login: Login, zone: string): string => {
  const name = connectorNames[login.connector];
  if (login.state === 'invalid') return `${name} no longer accepts your login, so replace it with a new one.`;
  return login.expiresAt === null ? `Replace your ${name} login.` : `Your ${name} login expires on ${day(login.expiresAt, zone)}, so replace it before then.`;
};

function Logins({ logins, zone }: { readonly logins: readonly Login[]; readonly zone: string }) {
  if (logins.length === 0) return null;
  return (
    <Section name="logins" title="Your logins" count={logins.length}>
      {logins.map((login, index) => (
        <Row key={login.connector} divided={index > 0} id={`login-${login.connector}`} marks={['needs-you']} title={`${connectorNames[login.connector]} login`} detail={loginSentence(login, zone)} since={null} href={`${peoplePage}?login=${login.connector}`} action="Replace login" />
      ))}
    </Section>
  );
}

const sinceText = (task: TaskRow, now: string): string | null => (task.since === null ? null : `${task.state === 'ready' ? 'running' : 'waiting'} ${between(task.since, now)}`);

const runningDetail = (task: TaskRow): string => (task.since === null ? `${nameOf(task.step)} is next, for ${task.person}.` : `${nameOf(task.step)} for ${task.person}.`);

const taskRows = (tasks: readonly TaskRow[], now: string, detail: (task: TaskRow) => string, action: (task: TaskRow) => string, quiet = false): ReactNode =>
  tasks.map((task, index) => <Row key={task.key} divided={index > 0} id={task.key} marks={task.marks} label={task.key} title={task.title} detail={detail(task)} since={sinceText(task, now)} href={taskHref(task.key)} action={action(task)} quiet={quiet} />);

const waitingDetail = (task: TaskRow): string => task.waitingReason ?? `${nameOf(task.step)} waits for a person.`;

const actionOf = (task: TaskRow): string => (task.waitingOn === null ? 'Open' : actions[task.waitingOn]);

const summary = (needs: NeedsYou): string | undefined => {
  if (!needs.picked) return 'Pick who you are in the top bar to see what waits for you.';
  const count = needs.waiting.length + needs.gates.length + needs.logins.length;
  if (count === 0) return 'Nothing needs you right now.';
  return count === 1 ? 'One thing waits for you.' : `${String(count)} things wait for you, oldest first.`;
};

type NeedsYouProps = { readonly initial: NeedsYou; readonly zone: string };

export function NeedsYouPage({ initial, zone }: NeedsYouProps) {
  const [needs, setNeeds] = useState(initial);
  useFrames(needsYouStream, frame, next => {
    setNeeds(next.needs);
  });
  const { world, at } = needs;
  return (
    <main style={page} data-live="needs-you">
      <Heading title="Needs you" note={world.kind === 'tasks' ? summary(needs) : undefined} />
      {world.kind !== 'tasks' ? (
        <>
          <EmptyWorld world={world} zone={zone} />
          <Logins logins={needs.logins} zone={zone} />
        </>
      ) : (
        <>
          {needs.waiting.length === 0 ? null : (
            <Section name="waiting" title="Waiting on you" count={needs.waiting.length}>
              {taskRows(needs.waiting, at, waitingDetail, actionOf)}
            </Section>
          )}
          {needs.gates.length === 0 ? null : (
            <Section name="gates" title="Approve" count={needs.gates.length}>
              {taskRows(needs.gates, at, waitingDetail, actionOf)}
            </Section>
          )}
          <Logins logins={needs.logins} zone={zone} />
          <Section name="running" title="Running" count={needs.running.length + needs.moreRunning}>
            {needs.running.length === 0 ? <li style={{ padding: '12px 16px', color: color('muted') }}>Nothing is running right now.</li> : taskRows(needs.running, at, runningDetail, () => 'Watch', true)}
            {needs.moreRunning === 0 ? null : (
              <li style={{ padding: '12px 16px', borderTop: `1px solid ${color('rule')}` }}>
                <a href="/tasks?state=running" style={{ color: color('ink'), fontWeight: 500 }}>
                  See all {String(needs.running.length + needs.moreRunning)} running
                </a>
              </li>
            )}
          </Section>
        </>
      )}
    </main>
  );
}
