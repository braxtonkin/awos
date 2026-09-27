'use client';

import { useCallback, useState } from 'react';
import type { Said } from '../../shared/said.ts';
import { clock } from '../../shared/ui/clock.ts';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames } from '../../shared/ui/use-frames.ts';
import { AgentPanel, type PanelActions } from './agent-panel.tsx';
import { AttemptsTab } from './attempts-tab.tsx';
import { EvidenceTab } from './evidence-tab.tsx';
import { OpenReviews } from './open-reviews.tsx';
import { frame, textOf, type Evidence, type Frame, type Live } from './protocol.ts';
import type { Header, TaskPageData } from './read.ts';
import { StatusCard } from './status-card.tsx';
import { Stepper } from './stepper.tsx';
import type { Tab } from './tab.ts';
import { Tabs } from './tabs.tsx';
import { extend, runsAsOf } from './timeline.ts';

function Facts({ header, runsAs, zone }: { readonly header: Header; readonly runsAs: string | null; readonly zone: string }) {
  const facts = [header.repository, runsAs === null ? 'Runs as nobody yet' : `Runs as ${runsAs}`, `Found at ${clock(header.foundAt, zone)}`];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 13, color: color('muted') }}>
      {facts.flatMap(fact => (fact === null ? [] : [<span key={fact}>{fact}</span>]))}
    </div>
  );
}

const withEvidence = (known: readonly Evidence[], added: readonly Evidence[]): readonly Evidence[] => [...known, ...added.filter(row => !known.some(each => each.attempt === row.attempt))];

const withSaid = (known: readonly Said[], entry: Said): readonly Said[] => (known.some(each => each.request === entry.request) ? known : [...known, entry]);

function followed(live: Live, next: Frame): Live {
  switch (next.kind) {
    case 'task':
      return { ...live, task: next.task };
    case 'line':
      return { ...live, attempts: extend(live.attempts, [next]) };
    case 'said':
      return { ...live, said: next.said };
    case 'evidence':
      return { ...live, evidence: withEvidence(live.evidence, next.evidence) };
  }
}

type TaskPageProps = { readonly page: TaskPageData; readonly actions: PanelActions; readonly tab: Tab; readonly zone: string };

export function TaskPage({ page, actions, tab, zone }: TaskPageProps) {
  const { header, steps, cursor, kept } = page;
  const [live, setLive] = useState(page.live);
  useFrames({ path: `/tasks/${encodeURIComponent(header.key)}/stream`, after: cursor === undefined ? undefined : textOf(cursor) }, frame, next => {
    setLive(known => followed(known, next));
  });
  const sent = useCallback((entry: Said) => {
    setLive(known => ({ ...known, said: withSaid(known.said, entry) }));
  }, []);
  const { task, attempts, said, evidence } = live;
  return (
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 520px', alignItems: 'start' }}>
      <main style={{ padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 28 }}>
            <span style={{ fontSize: 13, color: color('muted') }}>
              {header.routine} › {header.key}
            </span>
          </div>
          <h1 style={{ margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>{header.title}</h1>
          <Facts header={header} runsAs={runsAsOf(task.attempts)} zone={zone} />
        </div>
        <StatusCard task={task} zone={zone} />
        <Stepper task={task} steps={steps} />
        <OpenReviews task={header.id} live={task} said={said} onSent={sent} act={actions.review} zone={zone} />
        <Tabs initial={tab} panels={{ evidence: <EvidenceTab evidence={evidence} attempts={task.attempts} zone={zone} />, attempts: <AttemptsTab attempts={task.attempts} /> }} />
      </main>
      <AgentPanel task={header.id} attempts={attempts} live={task} said={said} onSent={sent} kept={kept} actions={actions} zone={zone} />
    </div>
  );
}
