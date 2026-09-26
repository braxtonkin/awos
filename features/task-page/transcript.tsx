'use client';

import type { ReactNode } from 'react';
import type { Item } from '../../shared/items.ts';
import type { Review } from '../../shared/review.ts';
import { deliveryOf, type Said } from '../../shared/said.ts';
import { clock, day } from '../../shared/ui/clock.ts';
import { DeliveryLine } from '../../shared/ui/delivery.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { Folded } from './folded.tsx';
import { reviewOf } from './now.ts';
import type { AttemptSummary, AttemptTranscript, Kept } from './protocol.ts';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';
import { verbOf, type Action } from './tool-actions.ts';

type Shown =
  | { readonly kind: 'instructions'; readonly text: string }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'agent'; readonly text: string }
  | { readonly kind: 'finished'; readonly outcome: Outcome; readonly summary: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'command'; readonly action: Action | undefined; readonly running: boolean; readonly output: string }
  | { readonly kind: 'tool'; readonly what: string; readonly action: Action | undefined };

const tools: Readonly<Record<string, string>> = { fileChange: 'Changed files', mcpToolCall: 'Used a tool', webSearch: 'Searched the web', imageView: 'Looked at an image' };

type Outcome = Review['outcome'];

const endings: Readonly<Record<Outcome, (step: string) => string>> = {
  done: step => `Finished ${step}`,
  needs_input: step => `Needs a person to go on with ${step}`,
  blocked: step => `Could not finish ${step}`,
};

function shownOf(item: Item, firstInTurn: boolean, action: Action | undefined, running: boolean): Shown {
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
      return { kind: 'command', action, running, output: item.text };
    default:
      return { kind: 'tool', what: tools[item.type] ?? 'Used a tool', action };
  }
}

const muted = { fontSize: 13, color: color('muted') } as const;

function Details({ label, body }: { readonly label: ReactNode; readonly body: string }) {
  return (
    <Folded summary={<summary style={{ cursor: 'pointer' }}>{label}</summary>}>
      <pre style={{ margin: 0, marginTop: 8, padding: 12, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', borderRadius: 8, background: color('surface-2') }}>{body}</pre>
    </Folded>
  );
}

function Body({ shown, step }: { readonly shown: Shown; readonly step: string }): ReactNode {
  switch (shown.kind) {
    case 'instructions':
      return <Details label={`${step} instructions`} body={shown.text} />;
    case 'message':
    case 'agent':
      return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{shown.text}</p>;
    case 'finished':
      return <p style={{ margin: 0 }}>{`${endings[shown.outcome](step)}: ${shown.summary}`}</p>;
    case 'thinking':
      return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{shown.text === '' ? 'Thinking' : shown.text}</p>;
    case 'command':
      return (
        <Details
          label={
            <span data-command="true" style={{ display: 'inline-block', maxWidth: 'calc(100% - 16px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
              {shown.action === undefined ? 'Ran a command' : verbOf(shown.action, shown.running)} {shown.action === undefined ? null : <span className="mono">{shown.action.what}</span>}
            </span>
          }
          body={shown.output === '' ? 'No output yet.' : shown.output}
        />
      );
    case 'tool':
      return shown.action === undefined ? <span>{shown.what}</span> : <span>{verbOf(shown.action, false)} <span className="mono">{shown.action.what}</span></span>;
  }
}

const who: Readonly<Record<Shown['kind'], string>> = { instructions: 'AutoWorker', message: 'Person', agent: 'Agent', finished: 'Agent', thinking: 'Agent', command: 'Agent', tool: 'Agent' };

type RowProps = { readonly item: Item; readonly shown: Shown; readonly running: boolean; readonly time: string | undefined; readonly step: string; readonly zone: string; readonly heading: boolean };

function Row({ item, shown, running, time, step, zone, heading }: RowProps) {
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

const noted: Readonly<Record<Said['kind'], string>> = { steer: '', retry: 'Retry note · ', send_back: 'Sent back · ', answer: '', approve: '', stop: '' };

const pressed: Readonly<Record<Said['kind'], string>> = { steer: 'sent a message', retry: 'pressed Retry', send_back: 'sent it back', answer: 'answered', approve: 'approved it', stop: 'stopped the task' };

function PersonRow({ entry, item, zone }: { readonly entry: Said; readonly item: string | undefined; readonly zone: string }) {
  if (entry.words === null) {
    return (
      <li data-action={entry.kind} style={{ ...muted, padding: '12px 12px 4px', display: 'flex', gap: 8 }}>
        <span>{`${entry.person} ${pressed[entry.kind]}`}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12 }}>{clock(entry.at, zone)}</span>
      </li>
    );
  }
  return (
    <li data-item={item} data-msg="person" data-delivery={deliveryOf(entry)} data-request={entry.request} style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '8px 0', padding: '8px 12px', borderLeft: `2px solid ${color('ink')}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: color('muted') }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: color('ink') }}>{entry.person}</span>
        <span style={{ marginLeft: 'auto' }}>{clock(entry.at, zone)}</span>
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{`${noted[entry.kind]}${entry.words}`}</p>
      <DeliveryLine entry={entry} zone={zone} />
    </li>
  );
}

type Entry = { readonly kind: 'item'; readonly item: Item; readonly shown: Shown; readonly running: boolean } | { readonly kind: 'said'; readonly entry: Said; readonly item: string | undefined };

function entriesOf(each: AttemptTranscript, said: readonly Said[], live: boolean): readonly Entry[] {
  const { transcript } = each;
  const byId = new Map(transcript.items.map(item => [item.id, item]));
  const firsts = new Set(transcript.turns.flatMap(turn => turn.items.filter(id => byId.get(id)?.type === 'userMessage').slice(0, 1)));
  const byClient = new Map(said.flatMap(entry => (entry.clientId === null ? [] : [[entry.clientId, entry] as const])));
  return transcript.items.map(item => {
    const entry = item.type === 'userMessage' && item.clientId !== null ? byClient.get(item.clientId) : undefined;
    const running = live && item.status === 'inProgress';
    return entry === undefined ? { kind: 'item', item, running, shown: shownOf(item, firsts.has(item.id), each.actions[item.id], running) } : { kind: 'said', entry, item: item.id };
  });
}

function AttemptItems({ entries, times, step, zone }: { readonly entries: readonly Entry[]; readonly times: Readonly<Record<string, string>>; readonly step: string; readonly zone: string }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
      {entries.map((entry, index) => {
        if (entry.kind === 'said') return <PersonRow key={entry.entry.request} entry={entry.entry} item={entry.item} zone={zone} />;
        const before = entries[index - 1];
        const heading = entry.shown.kind !== 'instructions' && (before?.kind !== 'item' || who[before.shown.kind] !== who[entry.shown.kind]);
        return <Row key={entry.item.id} item={entry.item} shown={entry.shown} running={entry.running} time={times[entry.item.id]} step={step} zone={zone} heading={heading} />;
      })}
    </ol>
  );
}

const headingOf = (attempts: readonly AttemptSummary[], id: string, zone: string): { readonly step: string; readonly title: string } => {
  const found = attempts.find(each => each.id === id);
  if (found === undefined) return { step: 'this step', title: 'Starting' };
  const step = stepName(found.step);
  return { step, title: `${step}, try ${String(numbered(attempts, id))} · ${clock(found.startedAt, zone)}` };
};

const shownSaid = (entry: Said): boolean => deliveryOf(entry) !== 'refused';

function placed(attempts: readonly AttemptTranscript[], summaries: readonly AttemptSummary[], said: readonly Said[]): ReadonlyMap<string, readonly Said[]> {
  const inline = new Set(attempts.flatMap(each => each.transcript.items.flatMap(item => (item.clientId === null ? [] : [item.clientId]))));
  const starts = summaries.map(each => ({ id: each.id, at: each.startedAt }));
  const places = new Map<string, Said[]>();
  for (const entry of said) {
    if (!shownSaid(entry) || (entry.clientId !== null && inline.has(entry.clientId))) continue;
    const under = starts.findLast(start => start.at <= entry.at)?.id ?? '';
    places.set(under, [...(places.get(under) ?? []), entry]);
  }
  return places;
}

export type TranscriptProps = {
  readonly attempts: readonly AttemptTranscript[];
  readonly summaries: readonly AttemptSummary[];
  readonly said: readonly Said[];
  readonly kept: Kept;
  readonly zone: string;
};

export function Transcript({ attempts, summaries, said, kept, zone }: TranscriptProps) {
  const visible = said.filter(shownSaid);
  const places = placed(attempts, summaries, visible);
  const early = places.get('') ?? [];
  const extra = (entries: readonly Said[]): readonly Entry[] => entries.map(entry => ({ kind: 'said', entry, item: undefined }));
  return (
    <>
      {kept === null ? null : (
        <p data-expired="true" style={{ ...muted, margin: 0, padding: '8px 12px' }}>
          {`The transcript expired on ${day(kept.transcriptUntil, zone)}. Attempts and evidence stay until ${day(kept.historyUntil, zone)}.`}
        </p>
      )}
      {attempts.length === 0 && early.length === 0 && kept === null ? <p style={{ ...muted, margin: 0, padding: '8px 12px' }}>The agent has not started on this task yet.</p> : null}
      {early.length === 0 ? null : <AttemptItems entries={extra(early)} times={{}} step="this step" zone={zone} />}
      {attempts.map(each => {
        const heading = headingOf(summaries, each.attempt, zone);
        const summary = summaries.find(found => found.id === each.attempt);
        const entries = [...entriesOf(each, visible, summary?.finishedAt === null), ...extra(places.get(each.attempt) ?? [])];
        const replayed = kept === null ? entries : entries.filter(entry => entry.kind === 'said');
        return (
          <section key={each.attempt} data-attempt={each.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 16 }}>
            <h3 style={{ position: 'sticky', top: -8, zIndex: 1, margin: 0, padding: '8px 12px', fontSize: 12, fontWeight: 600, color: color('muted'), background: color('surface') }}>{heading.title}</h3>
            {each.transcript.items.length === 0 && summary !== undefined && summary.summary !== null ? <p style={{ margin: 0, padding: '4px 12px' }}>{summary.summary}</p> : null}
            <AttemptItems entries={replayed} times={each.times} step={heading.step} zone={zone} />
          </section>
        );
      })}
    </>
  );
}
