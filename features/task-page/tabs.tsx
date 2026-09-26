'use client';

import { useState, type ReactNode } from 'react';
import { color } from '../../shared/ui/tokens.ts';
import { tabs, type Tab } from './tab.ts';

const labels: Readonly<Record<Tab, string>> = { evidence: 'Evidence', attempts: 'Attempts' };

type TabsProps = { readonly initial: Tab; readonly panels: Readonly<Record<Tab, ReactNode>> };

export function Tabs({ initial, panels }: TabsProps) {
  const [shown, setShown] = useState(initial);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div role="tablist" aria-label="Task record" style={{ display: 'flex', gap: 24, borderBottom: `1px solid ${color('rule')}` }}>
        {tabs.map(tab => (
          <a
            key={tab}
            role="tab"
            id={`tab-${tab}`}
            href={`?tab=${tab}`}
            aria-selected={tab === shown}
            aria-controls={`panel-${tab}`}
            data-tab={tab}
            onClick={event => {
              event.preventDefault();
              setShown(tab);
              window.history.replaceState(null, '', `?tab=${tab}`);
            }}
            style={{ padding: '8px 0', fontSize: 14, fontWeight: 500, textDecoration: 'none', color: color(tab === shown ? 'ink' : 'muted'), boxShadow: tab === shown ? `inset 0 -2px 0 ${color('ink')}` : 'none' }}
          >
            {labels[tab]}
          </a>
        ))}
      </div>
      {tabs.map(tab => (
        <div key={tab} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} hidden={tab !== shown}>
          {panels[tab]}
        </div>
      ))}
    </section>
  );
}
