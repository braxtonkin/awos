import type { ReactNode } from 'react';
import { color } from '../../shared/ui/tokens.ts';
import { clock, day } from './format.ts';
import type { World } from './protocol.ts';

export const page = { flex: 1, width: '100%', maxWidth: 1200, margin: '0 auto', padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24 } as const;

export const box = { background: color('surface'), border: `1px solid ${color('rule')}`, borderRadius: 12 } as const;

export const actionLink = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 32,
  padding: '0 12px',
  borderRadius: 6,
  border: `1px solid ${color('rule-strong')}`,
  color: color('ink'),
  fontSize: 13,
  fontWeight: 500,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
} as const;

export const taskHref = (key: string): string => `/tasks/${encodeURIComponent(key)}`;

export function Heading({ title, note, children }: { readonly title: string; readonly note?: string | undefined; readonly children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, minHeight: 44 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 style={{ fontSize: 20, lineHeight: '24px', fontWeight: 600 }}>{title}</h1>
        {note === undefined ? null : <p style={{ fontSize: 13, color: color('muted') }}>{note}</p>}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>{children}</div>
    </div>
  );
}

const nextSentence = (world: Extract<World, { kind: 'no-tasks' }>, zone: string): string =>
  world.next === null ? 'Every routine is paused, so resume one to start finding tickets.' : `${world.next.routine} looks for tickets next on ${day(world.next.at, zone)} at ${clock(world.next.at, zone)}, and each ticket it finds becomes a task here.`;

export function EmptyWorld({ world, zone }: { readonly world: Exclude<World, { kind: 'tasks' }>; readonly zone: string }) {
  const title = world.kind === 'no-routines' ? 'No routines yet' : 'No tasks yet';
  return (
    <section data-empty={world.kind} style={{ ...box, padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600 }}>{title}</h2>
      {world.kind === 'no-routines' ? (
        <p style={{ color: color('muted') }}>
          Add a routine to a setup file such as <span className="mono">setup.json</span>, then run <span className="mono">node services/engine/setup.ts setup.json</span>, and AutoWorker starts finding tickets.
        </p>
      ) : (
        <p style={{ color: color('muted') }}>{nextSentence(world, zone)}</p>
      )}
    </section>
  );
}

type View = 'list' | 'board';

const views: readonly { readonly view: View; readonly href: string; readonly label: string }[] = [
  { view: 'list', href: '/tasks', label: 'List' },
  { view: 'board', href: '/board', label: 'Board' },
];

export function ViewSwitch({ current }: { readonly current: View }) {
  return (
    <nav aria-label="View" style={{ display: 'inline-flex', padding: 2, gap: 2, borderRadius: 8, background: color('surface-2') }}>
      {views.map(each => (
        <a
          key={each.view}
          href={each.href}
          aria-current={each.view === current ? 'page' : undefined}
          style={{ height: 28, display: 'inline-flex', alignItems: 'center', padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, textDecoration: 'none', color: color(each.view === current ? 'ink' : 'muted'), background: each.view === current ? color('surface') : 'transparent' }}
        >
          {each.label}
        </a>
      ))}
    </nav>
  );
}
