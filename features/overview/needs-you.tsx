'use client';

import { useState, type ReactNode } from 'react';
import type { ConnectorKind } from '../../shared/db/types.ts';
import type { Mark } from '../../shared/task-status.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { day, moment, nameOf } from './format.ts';
import { actionLink, box, EmptyWorld, Heading, page, taskHref } from './parts.tsx';
import { frame, type Login, type NeedsYou, type TaskRow } from './protocol.ts';

const needsYouStream: Stream = { path: '/stream', after: undefined };

const connectorNames: Readonly<Record<ConnectorKind, string>> = { codex: 'Codex', github: 'GitHub', jira: 'Jira' };

const peoplePage = '/people';

const actions: Readonly<Record<NonNullable<TaskRow['waitingOn']>, string>> = { answer: 'Answer', approval: 'Review', outside_approval: 'Check', retry: 'Fix and retry' };

type RowProps = { readonly id: string; readonly marks: readonly Mark[]; readonly title: string; readonly label?: string; readonly detail: string; readonly since: string | null; readonly href: string; readonly action: string; readonly divided: boolean };

function Row({ id, marks, title, label, detail, since, href, action, divided }: RowProps) {
  return (
    <li data-row={id} style={{ display: 'grid', gridTemplateColumns: '176px minmax(0, 1fr) 96px auto', alignItems: 'center', gap: 16, padding: '12px 16px', borderTop: divided ? `1px solid ${color('rule')}` : 'none' }}>
      <StatusMarks marks={marks} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          {label === undefined ? null : <span className="mono" style={{ color: color('muted'), flex: 'none' }}>{label}</span>}
          <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        </span>
        <span style={{ fontSize: 13, color: color('muted') }}>{detail}</span>
      </div>
      <span style={{ fontSize: 13, color: color('muted'), textAlign: 'right' }}>{since}</span>
      <a href={href} data-action={id} style={actionLink}>
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
  if (login.state === 'invalid') return `${name} no longer accepts your login. Replace it on the People page with a new one.`;
  return login.expiresAt === null ? `Replace your ${name} login on the People page.` : `Your ${name} login expires on ${day(login.expiresAt, zone)}. Replace it on the People page before then.`;
};

function Logins({ logins, zone }: { readonly logins: readonly Login[]; readonly zone: string }) {
  if (logins.length === 0) return null;
  return (
    <Section name="logins" title="Your logins" count={logins.length}>
      {logins.map((login, index) => (
        <Row key={login.connector} divided={index > 0} id={`login-${login.connector}`} marks={['needs-you']} title={`${connectorNames[login.connector]} login`} detail={loginSentence(login, zone)} since={null} href={peoplePage} action="Replace login" />
      ))}
    </Section>
  );
}

const sinceText = (task: TaskRow, zone: string, now: string): string | null => (task.since === null ? null : `since ${moment(task.since, zone, now)}`);

const runningDetail = (task: TaskRow): string => (task.since === null ? `${nameOf(task.step)} is next, for ${task.person}.` : `${nameOf(task.step)} is running for ${task.person}.`);

const taskRows = (tasks: readonly TaskRow[], zone: string, now: string, detail: (task: TaskRow) => string, action: (task: TaskRow) => string): ReactNode =>
  tasks.map((task, index) => <Row key={task.key} divided={index > 0} id={task.key} marks={task.marks} label={task.key} title={task.title} detail={detail(task)} since={sinceText(task, zone, now)} href={taskHref(task.key)} action={action(task)} />);

const waitingDetail = (task: TaskRow): string => task.waitingReason ?? `${nameOf(task.step)} waits for a person.`;

const actionOf = (task: TaskRow): string => (task.waitingOn === null ? 'Open' : actions[task.waitingOn]);

const summary = (needs: NeedsYou): string | undefined => {
  if (!needs.picked) return 'Pick who you are in the top bar to see what waits for you.';
  const count = needs.waiting.length + needs.gates.length + needs.logins.length;
  if (count === 0) return 'Nothing needs you right now.';
  return count === 1 ? 'One thing waits for you.' : `${String(count)} things wait for you, oldest first.`;
};

type NeedsYouProps = { readonly initial: NeedsYou; readonly zone: string; readonly now: string };

export function NeedsYouPage({ initial, zone, now }: NeedsYouProps) {
  const [needs, setNeeds] = useState(initial);
  useFrames(needsYouStream, frame, next => {
    setNeeds(next.needs);
  });
  const { world } = needs;
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
              {taskRows(needs.waiting, zone, now, waitingDetail, actionOf)}
            </Section>
          )}
          {needs.gates.length === 0 ? null : (
            <Section name="gates" title="Approve" count={needs.gates.length}>
              {taskRows(needs.gates, zone, now, waitingDetail, actionOf)}
            </Section>
          )}
          <Logins logins={needs.logins} zone={zone} />
          <Section name="running" title="Running" count={needs.running.length + needs.moreRunning}>
            {needs.running.length === 0 ? <li style={{ padding: '12px 16px', color: color('muted') }}>Nothing is running right now.</li> : taskRows(needs.running, zone, now, runningDetail, () => 'Watch')}
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
