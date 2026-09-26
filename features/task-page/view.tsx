import { color } from '../../shared/ui/tokens.ts';
import { LiveStatus } from './live-status.tsx';
import type { Stream } from '../../shared/ui/use-frames.ts';
import { textOf, type Cursor, type StopAction } from './protocol.ts';
import type { Header, TaskPageData } from './read.ts';
import { Stop } from './stop.tsx';
import { clock } from './time.ts';
import { Transcript } from './transcript.tsx';

const streamOf = (key: string, cursor: Cursor | undefined): Stream => ({ path: `/tasks/${encodeURIComponent(key)}/stream`, after: cursor === undefined ? undefined : textOf(cursor) });

function Facts({ header, zone }: { readonly header: Header; readonly zone: string }) {
  const facts = [header.repository, header.runsAs === null ? 'Runs as nobody yet' : `Runs as ${header.runsAs}`, `Found at ${clock(header.foundAt, zone)}`];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 13, color: color('muted') }}>
      {facts.flatMap(fact => (fact === null ? [] : [<span key={fact}>{fact}</span>]))}
    </div>
  );
}

type TaskPageProps = { readonly page: TaskPageData; readonly stop: StopAction; readonly zone: string };

export function TaskPage({ page, stop, zone }: TaskPageProps) {
  const { header, live } = page;
  const stream = streamOf(header.key, page.cursor);
  return (
    <div key={header.key} style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 520px', alignItems: 'start' }}>
      <main style={{ padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 28 }}>
            <span style={{ fontSize: 13, color: color('muted') }}>
              {header.routine} › {header.key}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <Stop task={header.id} action={stop} stream={stream} running={live.state === 'ready' || live.state === 'waiting'} />
            </span>
          </div>
          <h1 style={{ margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>{header.title}</h1>
          <Facts header={header} zone={zone} />
        </div>
        <LiveStatus initial={live} stream={stream} zone={zone} />
      </main>
      <Transcript initial={page.attempts} live={live} stream={stream} zone={zone} />
    </div>
  );
}
