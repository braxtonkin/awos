'use client';

import type { ReactNode } from 'react';
import type { Review } from '../review.ts';
import { deliveryOf, type Said } from '../said.ts';
import { field, primary, secondary } from './controls.ts';
import { DeliveryLine } from './delivery.tsx';
import type { SendAction, Sending } from './sending.ts';
import { color } from './tokens.ts';
import { pickFirst, useSend, type Sent } from './use-send.ts';

type Block = Review['blocks'][number];

export type ReviewProps = {
  readonly task: string;
  readonly attempt: string;
  readonly review: Review;
  readonly said: readonly Said[];
  readonly act: SendAction;
  readonly onSent: Sent;
  readonly zone: string;
};

type Context = Omit<ReviewProps, 'review' | 'said'> & { readonly said: readonly Said[] };

const muted = { fontSize: 13, color: color('muted') } as const;


function Hidden({ values }: { readonly values: Readonly<Record<string, string>> }) {
  return Object.entries(values).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />);
}

function Told({ state, entry, zone }: { readonly state: Sending; readonly entry: Said | undefined; readonly zone: string }): ReactNode {
  if (state.kind === 'pick-first') return <span role="status" style={muted}>{pickFirst}</span>;
  if (entry === undefined) return null;
  if (deliveryOf(entry) === 'refused' && entry.answer !== 'waiting' && 'refused' in entry.answer) {
    return (
      <span role="status" style={{ fontSize: 13, color: color('fail') }}>
        {entry.answer.refused}
      </span>
    );
  }
  return (
    <span data-msg="person" data-delivery={deliveryOf(entry)} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 13 }}>{entry.words ?? `${entry.person} pressed ${entry.kind === 'approve' ? 'Approve' : 'Send back'}`}</span>
      <DeliveryLine entry={entry} zone={zone} />
    </span>
  );
}

const newest = (said: readonly Said[], match: (entry: Said) => boolean): Said | undefined => said.findLast(match);

function Titled({ title, children }: { readonly title: string | null; readonly children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {title === null ? null : <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h4>}
      {children}
    </div>
  );
}

function Choice({ block, index, context }: { readonly block: Extract<Block, { kind: 'choice' }>; readonly index: number; readonly context: Context }) {
  const [state, dispatch, pending] = useSend(context.act, context.onSent);
  const entry = newest(context.said, each => each.kind === 'answer' && each.block === index);
  const chosen = entry !== undefined && deliveryOf(entry) !== 'refused' ? entry.options[0] : undefined;
  return (
    <Titled title={block.title}>
      <form action={dispatch} key={chosen ?? 'none'} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Hidden values={{ task: context.task, review: context.attempt, intent: 'answer', answer: 'pick', block: String(index) }} />
        <p style={{ margin: 0 }}>{block.question}</p>
        <div role="radiogroup" aria-label={block.question} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {block.options.map(option => (
            <label key={option.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, cursor: 'pointer' }}>
              <input
                type="radio"
                name="option"
                value={option.id}
                defaultChecked={option.id === chosen}
                disabled={pending}
                onChange={event => {
                  event.currentTarget.form?.requestSubmit();
                }}
              />
              <span>{option.label}</span>
              {option.id === block.recommended ? <span style={muted}>Recommended</span> : null}
            </label>
          ))}
        </div>
        <Told state={state} entry={entry} zone={context.zone} />
      </form>
    </Titled>
  );
}

type Item = { readonly id: string; readonly label: string };

function ChecklistItem({ item, index, context }: { readonly item: Item; readonly index: number; readonly context: Context }) {
  const [state, dispatch, pending] = useSend(context.act, context.onSent);
  const entry = newest(context.said, each => each.kind === 'answer' && each.block === index && each.options.includes(item.id));
  const unticked = entry !== undefined && deliveryOf(entry) !== 'refused';
  return (
    <form action={dispatch} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Hidden values={{ task: context.task, review: context.attempt, intent: 'answer', answer: 'untick', block: String(index), item: item.id }} />
      <label style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <input
          type="checkbox"
          defaultChecked={!unticked}
          disabled={pending || unticked}
          onChange={event => {
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <span style={unticked ? { color: color('muted'), textDecoration: 'line-through' } : undefined}>{item.label}</span>
      </label>
      <Told state={state} entry={entry} zone={context.zone} />
    </form>
  );
}

function Checklist({ block, index, context }: { readonly block: Extract<Block, { kind: 'checklist' }>; readonly index: number; readonly context: Context }) {
  return (
    <Titled title={block.title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {block.items.map(item => (
          <ChecklistItem key={item.id} item={item} index={index} context={context} />
        ))}
      </div>
    </Titled>
  );
}

function Draft({ block, index, context }: { readonly block: Extract<Block, { kind: 'draft' }>; readonly index: number; readonly context: Context }) {
  const [state, dispatch, pending] = useSend(context.act, context.onSent);
  const entry = newest(context.said, each => each.kind === 'answer' && each.block === index);
  return (
    <Titled title={block.title}>
      <form action={dispatch} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Hidden values={{ task: context.task, review: context.attempt, intent: 'answer', answer: 'edit', block: String(index) }} />
        <textarea name="body" aria-label={block.title ?? 'Draft'} defaultValue={block.body} rows={6} style={field} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="submit" disabled={pending} style={secondary}>
            Save edit
          </button>
          <Told state={state} entry={entry} zone={context.zone} />
        </span>
      </form>
    </Titled>
  );
}

function BlockView({ block, index, context }: { readonly block: Block; readonly index: number; readonly context: Context }): ReactNode {
  switch (block.kind) {
    case 'text':
      return (
        <Titled title={block.title}>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{block.body}</p>
        </Titled>
      );
    case 'list':
      return (
        <Titled title={block.title}>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {block.items.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Titled>
      );
    case 'choice':
      return <Choice block={block} index={index} context={context} />;
    case 'checklist':
      return <Checklist block={block} index={index} context={context} />;
    case 'draft':
      return <Draft block={block} index={index} context={context} />;
  }
}

function Decide({ context, asked }: { readonly context: Context; readonly asked: boolean }) {
  const [approving, approve, approvePending] = useSend(context.act, context.onSent);
  const [sending, sendBack, sendPending] = useSend(context.act, context.onSent);
  const decided = newest(context.said, each => each.kind === 'approve' || each.kind === 'send_back');
  const keys = { task: context.task, review: context.attempt };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <form action={approve}>
          <Hidden values={{ ...keys, intent: 'approve' }} />
          <button type="submit" data-act="approve" disabled={approvePending} style={primary}>
            {asked ? 'Run again with answers' : 'Approve'}
          </button>
        </form>
        <details style={{ flex: 1 }}>
          <summary style={{ ...secondary, display: 'inline-block', listStyle: 'none' }}>Send back</summary>
          <form action={sendBack} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <Hidden values={{ ...keys, intent: 'send_back' }} />
            <textarea
              name="note"
              required
              aria-label="What to change"
              placeholder="Say what to change"
              rows={3}
              style={field}
              onChange={event => {
                event.currentTarget.setCustomValidity(event.currentTarget.value.trim() === '' ? 'Say what to change before you send it back.' : '');
              }}
            />
            <span>
              <button type="submit" disabled={sendPending} style={secondary}>
                Send back with note
              </button>
            </span>
          </form>
        </details>
      </div>
      <Told state={approving.kind === 'ready' ? sending : approving} entry={decided} zone={context.zone} />
    </div>
  );
}

export function ReviewCard({ review, said, ...rest }: ReviewProps) {
  const context: Context = { ...rest, said: said.filter(each => each.review === rest.attempt) };
  return (
    <div data-review={rest.attempt} data-question={review.outcome === 'needs_input' ? 'open' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ margin: 0, fontWeight: 500 }}>{review.summary}</p>
      {review.blocks.map((block, index) => (
        <BlockView key={`${block.kind}-${String(index)}`} block={block} index={index} context={context} />
      ))}
      <Decide context={context} asked={review.outcome === 'needs_input'} />
    </div>
  );
}
