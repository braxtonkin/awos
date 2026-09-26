'use client';

import { useRef } from 'react';
import { initials, type Person } from '../people.ts';
import { color } from './tokens.ts';

export type Link = { readonly href: string; readonly label: string };

export const links: readonly Link[] = [{ href: '/people', label: 'People' }];

type TopBarProps = { readonly people: readonly Person[]; readonly acting: Person | undefined; readonly pick: (form: FormData) => Promise<void> };

export function Avatar({ name }: { readonly name: string }) {
  const box = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: '50%', flex: 'none' } as const;
  return <span aria-hidden="true" style={{ ...box, background: color('surface-2'), border: `1px solid ${color('rule')}`, color: color('muted'), fontSize: 11, fontWeight: 600 }}>{initials(name)}</span>;
}

function Chevron() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: color('muted'), flex: 'none' }}>
      <path d="M4 6.5l4 4 4-4" />
    </svg>
  );
}

function Tick() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', flex: 'none' }}>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Mark() {
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', width: 20, height: 20, borderRadius: 6, background: color('ink'), flex: 'none' }}>
      {[4, 8, 12].map(left => (
        <span key={left} style={{ position: 'absolute', top: 8, left, width: 4, height: 2, borderRadius: 2, background: color('surface') }} />
      ))}
    </span>
  );
}

export function TopBar({ people, acting, pick }: TopBarProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = (): void => {
    if (menu.current !== null) menu.current.open = false;
  };
  const item = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 32, padding: '0 8px', border: 0, borderRadius: 6, background: 'transparent', fontSize: 13 } as const;
  return (
    <header style={{ height: 56, display: 'flex', alignItems: 'center', gap: 24, padding: '0 32px', background: color('surface'), borderBottom: `1px solid ${color('rule')}` }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontSize: 15, fontWeight: 600 }}>
        <Mark />
        AutoWorker
      </span>
      <nav style={{ display: 'flex', gap: 2 }}>
        {links.map(link => (
          <a key={link.href} href={link.href} style={{ height: 32, display: 'inline-flex', alignItems: 'center', padding: '0 12px', color: color('muted') }}>
            {link.label}
          </a>
        ))}
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: color('muted') }}>Acting as</span>
        <details ref={menu} style={{ position: 'relative' }}>
          <summary aria-label="Acting as" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 8px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer', listStyle: 'none' }}>
            {acting === undefined ? 'Pick who you are' : <><Avatar name={acting.name} />{acting.name}</>}
            <Chevron />
          </summary>
          <form action={pick} onSubmit={close} role="menu" style={{ position: 'absolute', right: -12, top: 48, zIndex: 20, width: 240, padding: 4, background: color('surface'), border: `1px solid ${color('rule')}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)' }}>
            {people.map(person => (
              <button key={person.id} type="submit" name="person" value={person.id} role="menuitemradio" aria-checked={person.id === acting?.id} className="hov" style={item}>
                <Avatar name={person.name} />
                {person.name}
                {person.id === acting?.id ? <Tick /> : null}
              </button>
            ))}
          </form>
        </details>
      </div>
    </header>
  );
}
