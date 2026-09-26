import { color } from '../../shared/ui/tokens.ts';
import { RoutineActions } from './actions.tsx';
import type { PressAction } from './protocol.ts';
import type { RoutineSummary } from './read.ts';
import { interval, when } from './words.ts';

const newButton = { height: 32, display: 'inline-flex', alignItems: 'center', padding: '0 12px', borderRadius: 6, background: color('ink'), color: color('surface'), fontSize: 13, fontWeight: 500, textDecoration: 'none' } as const;

function Empty() {
  return (
    <div data-routines="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: 24, background: color('surface'), border: `1px solid ${color('rule')}`, borderRadius: 8 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600 }}>No routines yet</h2>
      <p style={{ color: color('muted'), maxWidth: 520 }}>A routine finds work on a schedule and starts a task for each item it finds. Add the first one: name its goal, pick a workflow, and say where it looks for work.</p>
      <a href="/routines/new" style={newButton}>
        Add the first routine
      </a>
    </div>
  );
}

type RoutineListProps = { readonly routines: readonly RoutineSummary[]; readonly press: PressAction; readonly zone: string; readonly now: string };

export function RoutineList({ routines, press, zone, now }: RoutineListProps) {
  const cell = { padding: '12px 16px', borderTop: `1px solid ${color('rule')}` } as const;
  const head = { padding: '8px 16px', fontSize: 12, fontWeight: 500, color: color('muted'), textAlign: 'left' } as const;
  return (
    <main style={{ padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1080, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>Routines</h1>
        {routines.length === 0 ? null : (
          <a href="/routines/new" style={{ ...newButton, marginLeft: 'auto' }}>
            New routine
          </a>
        )}
      </div>
      {routines.length === 0 ? (
        <Empty />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: color('surface'), border: `1px solid ${color('rule')}`, borderRadius: 8 }}>
          <thead>
            <tr>
              <th style={head}>Routine</th>
              <th style={head}>Workflow</th>
              <th style={head}>Runs</th>
              <th style={head}>Next run</th>
              <th style={head} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {routines.map(routine => (
              <tr key={routine.id} data-routine={routine.id}>
                <td style={cell}>
                  <a href={`/routines/${routine.id}`} style={{ fontWeight: 500, color: color('ink') }}>
                    {routine.name}
                  </a>
                </td>
                <td style={{ ...cell, color: color('muted') }}>{routine.workflow}</td>
                <td style={{ ...cell, color: color('muted') }}>{interval(routine.everyMinutes)}</td>
                <td style={cell} data-next-run>
                  {routine.paused ? <span style={{ color: color('attn') }}>Paused</span> : routine.runNowWaits ? 'On the next pass' : when(routine.nextRun ?? now, now, zone)}
                </td>
                <td style={{ ...cell, width: 1, whiteSpace: 'nowrap' }}>
                  <RoutineActions routine={routine.id} paused={routine.paused} press={press} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
