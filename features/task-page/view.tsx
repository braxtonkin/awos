import { clock } from '../../shared/ui/clock.ts';
import { color } from '../../shared/ui/tokens.ts';
import type { Stream } from '../../shared/ui/use-frames.ts';
import { AgentPanel, type PanelActions } from './agent-panel.tsx';
import { LiveStatus } from './live-status.tsx';
import { textOf, type Cursor } from './protocol.ts';
import type { Header, TaskPageData } from './read.ts';

const streamOf = (key: string, cursor: Cursor | undefined): Stream => ({ path: `/tasks/${encodeURIComponent(key)}/stream`, after: cursor === undefined ? undefined : textOf(cursor) });

function Facts({ header, zone }: { readonly header: Header; readonly zone: string }) {
  const facts = [header.repository, header.runsAs === null ? null : `Runs as ${header.runsAs}`, `Found at ${clock(header.foundAt, zone)}`];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 13, color: color('muted') }}>
      {facts.flatMap(fact => (fact === null ? [] : [<span key={fact}>{fact}</span>]))}
    </div>
  );
}

type TaskPageProps = { readonly page: TaskPageData; readonly actions: PanelActions; readonly zone: string };

export function TaskPage({ page, actions, zone }: TaskPageProps) {
  const { header, live } = page;
  const stream = streamOf(header.key, page.cursor);
  return (
    <div key={header.key} style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 520px', alignItems: 'start' }}>
      <main style={{ padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 28 }}>
            <span style={{ fontSize: 13, color: color('muted') }}>
              {header.routine} › <span className="mono">{header.key}</span>
            </span>
          </div>
          <h1 style={{ margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>{header.title}</h1>
          <Facts header={header} zone={zone} />
        </div>
        <LiveStatus initial={live} stream={stream} zone={zone} />
      </main>
      <AgentPanel task={header.id} initial={page.attempts} live={live} said={page.said} kept={page.kept} stream={stream} actions={actions} zone={zone} />
    </div>
  );
}
