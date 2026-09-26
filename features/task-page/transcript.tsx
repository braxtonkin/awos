'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Item, Transcript as Reduced } from '../../shared/items.ts';
import { review, type Review } from '../../shared/review.ts';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { frame, type AttemptSummary, type AttemptTranscript, type TaskLive } from './protocol.ts';
import { clock, stepName } from './time.ts';
import { extend, numbered } from './timeline.ts';

type Shown =
  | { readonly kind: 'instructions'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'agent'; readonly text: string }
  | { readonly kind: 'finished'; readonly outcome: Outcome; readonly summary: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'command'; readonly output: string }
  | { readonly kind: 'tool'; readonly what: string };

const tools: Readonly<Record<string, string>> = { fileChange: 'Changed files', mcpToolCall: 'Used a tool', webSearch: 'Searched the web', imageView: 'Looked at an image' };

type Outcome = Review['outcome'];

const reviewOf = (text: string): Review | undefined => {
  try {
    return review.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
};

const endings: Readonly<Record<Outcome, (step: string) => string>> = {
  done: step => `Finished ${step}`,
  needs_input: step => `Needs a person to go on with ${step}`,
  blocked: step => `Could not finish ${step}`,
};

function shownOf(item: Item, firstInTurn: boolean): Shown {
  switch (item.type) {
    case 'userMessage':
      return firstInTurn ? { kind: 'instructions', text: item.text } : { kind: 'message', text: item.text };
    case 'agentMessage': {
      const ended = reviewOf(item.text);
      return ended === undefined ? { kind: 'agent', text: item.text } : { kind: 'finished', outcome: ended.outcome, summary: ended.summary };
    }
    case 'reasoning':
      return { kind: 'thinking', text: item.text };
    case 'commandExecution':
      return { kind: 'command', output: item.text };
    default:
      return { kind: 'tool', what: tools[item.type] ?? 'Used a tool' };
  }
}

const muted = { fontSize: 13, color: color('muted') } as const;

function Details({ label, body }: { readonly label: string; readonly body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      onToggle={event => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary style={{ cursor: 'pointer' }}>{label}</summary>
      {open ? <pre style={{ margin: 0, marginTop: 8, padding: 12, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', borderRadius: 8, background: color('surface-2') }}>{body}</pre> : null}
    </details>
  );
}

function Body({ shown, step }: { readonly shown: Shown; readonly step: string }): ReactNode {
  switch (shown.kind) {
    case 'instructions':
      return <Details label={`AutoWorker gave the agent its ${step} instructions`} body={shown.text} />;
    case 'message':
      return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{shown.text}</p>;
    case 'agent':
      return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{shown.text}</p>;
    case 'finished':
      return <p style={{ margin: 0 }}>{`${endings[shown.outcome](step)}: ${shown.summary}`}</p>;
    case 'thinking':
      return <p style={{ ...muted, margin: 0, whiteSpace: 'pre-wrap' }}>{shown.text === '' ? 'Thinking' : shown.text}</p>;
    case 'command':
      return <Details label="Ran a command" body={shown.output === '' ? 'No output yet.' : shown.output} />;
    case 'tool':
      return <span>{shown.what}</span>;
  }
}

const who: Readonly<Record<Shown['kind'], string>> = { instructions: 'AutoWorker', message: 'Person', agent: 'Agent', finished: 'Agent', thinking: 'Agent', command: 'Agent', tool: 'Agent' };

type RowProps = { readonly item: Item; readonly shown: Shown; readonly time: string | undefined; readonly step: string; readonly zone: string; readonly heading: boolean };

function Row({ item, shown, time, step, zone, heading }: RowProps) {
  const running = item.status === 'inProgress';
  return (
    <li data-item={item.id} data-status={item.status} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: heading ? '12px 12px 4px' : '4px 12px' }}>
      {heading || running ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: color('muted') }}>
          {heading ? <span style={{ fontSize: 13, fontWeight: 600, color: color('ink') }}>{who[shown.kind]}</span> : null}
          {running ? <span style={{ fontWeight: 500, color: color('run') }}>Running</span> : null}
          {time === undefined || !heading ? null : <span style={{ marginLeft: 'auto' }}>{clock(time, zone)}</span>}
        </div>
      ) : null}
      <Body shown={shown} step={step} />
    </li>
  );
}

function AttemptItems({ transcript, times, step, zone }: { readonly transcript: Reduced; readonly times: Readonly<Record<string, string>>; readonly step: string; readonly zone: string }) {
  const firsts = new Set(transcript.turns.flatMap(turn => turn.items.filter(id => transcript.items.find(item => item.id === id)?.type === 'userMessage').slice(0, 1)));
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
      {transcript.items.map((item, index) => {
        const shown = shownOf(item, firsts.has(item.id));
        const before = transcript.items[index - 1];
        const heading = before === undefined || who[shownOf(before, firsts.has(before.id)).kind] !== who[shown.kind];
        return <Row key={item.id} item={item} shown={shown} time={times[item.id]} step={step} zone={zone} heading={heading} />;
      })}
    </ol>
  );
}

const headingOf = (attempts: readonly AttemptSummary[], id: string, zone: string): { readonly step: string; readonly title: string } => {
  const found = attempts.find(each => each.id === id);
  if (found === undefined) return { step: 'this step', title: 'Starting' };
  const step = stepName(found.step);
  return { step, title: `${step} ${String(numbered(attempts, id))} · started ${clock(found.startedAt, zone)}` };
};

type TranscriptProps = { readonly initial: readonly AttemptTranscript[]; readonly live: TaskLive; readonly stream: Stream; readonly zone: string };

export function Transcript({ initial, live, stream, zone }: TranscriptProps) {
  const [attempts, setAttempts] = useState(initial);
  const [task, setTask] = useState(live);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useFrames(stream, frame, next => {
    if (next.kind === 'line') setAttempts(known => extend(known, [next]));
    if (next.kind === 'task') setTask(next.task);
  });
  useEffect(() => {
    const box = scroller.current;
    if (box !== null && pinned.current) box.scrollTop = box.scrollHeight;
  }, [attempts]);
  const onScroll = (): void => {
    const box = scroller.current;
    if (box !== null) pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
  };
  const streaming = task.state === 'ready' && task.attempts.at(-1)?.finishedAt === null;
  return (
    <aside aria-label="Agent" style={{ position: 'sticky', top: 0, height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', background: color('surface'), borderLeft: `1px solid ${color('rule')}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 20px', borderBottom: `1px solid ${color('rule')}` }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Agent</h2>
        {streaming ? (
          <span data-live="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: color('run') }}>
            <span aria-hidden="true" className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: color('run') }} />
            Live
          </span>
        ) : null}
      </div>
      <div ref={scroller} onScroll={onScroll} data-transcript="true" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
        {attempts.length === 0 ? <p style={{ ...muted, margin: 0, padding: '8px 12px' }}>The agent has not started on this task yet.</p> : null}
        {attempts.map(each => {
          const heading = headingOf(task.attempts, each.attempt, zone);
          return (
            <section key={each.attempt} data-attempt={each.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 16 }}>
              <h3 style={{ margin: 0, padding: '8px 12px', fontSize: 12, fontWeight: 600, color: color('muted') }}>{heading.title}</h3>
              <AttemptItems transcript={each.transcript} times={each.times} step={heading.step} zone={zone} />
            </section>
          );
        })}
      </div>
    </aside>
  );
}
