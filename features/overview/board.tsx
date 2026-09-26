import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { nameOf } from './format.ts';
import { EmptyWorld, Heading, page, taskHref, ViewSwitch } from './parts.tsx';
import type { TaskRow } from './protocol.ts';
import type { Board, BoardRow } from './read.ts';

const waitsFor: Readonly<Record<NonNullable<TaskRow['waitingOn']>, string>> = { answer: 'Waits for your answer', approval: 'Waits for approval', outside_approval: 'Waits for an outside approval', retry: 'Waits for Retry' };

function Card({ task }: { readonly task: TaskRow }) {
  return (
    <li data-task={task.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, background: color('surface'), border: `1px solid ${color('rule')}` }}>
      <a href={taskHref(task.key)} style={{ display: 'flex', flexDirection: 'column', gap: 2, color: color('ink'), textDecoration: 'none' }}>
        <span className="mono" style={{ color: color('muted') }}>{task.key}</span>
        <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
      </a>
      <StatusMarks marks={task.marks} />
      {task.waitingOn === null ? null : <span style={{ fontSize: 13, color: color('muted') }}>{waitsFor[task.waitingOn]}</span>}
    </li>
  );
}

function Row({ row }: { readonly row: BoardRow }) {
  return (
    <section data-workflow={row.workflow} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 15, fontWeight: 600 }}>
        {nameOf(row.workflow)}
        {row.landed === 0 ? null : (
          <a href="/tasks?state=landed" style={{ fontSize: 13, fontWeight: 400, color: color('muted') }}>
            {row.landed === 1 ? 'See 1 landed task' : `See ${String(row.landed)} landed tasks`}
          </a>
        )}
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${String(row.columns.length)}, minmax(0, 1fr))`, gap: 16, alignItems: 'start' }}>
        {row.columns.map(column => (
          <div key={column.step} data-step={column.step} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <h3 style={{ display: 'flex', gap: 8, margin: 0, paddingBottom: 8, borderBottom: `1px solid ${color('rule')}`, fontSize: 13, fontWeight: 600 }}>
              {nameOf(column.step)}
              <span style={{ fontWeight: 400, color: color('muted') }}>{column.tasks.length}</span>
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {column.tasks.map(task => (
                <Card key={task.key} task={task} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function BoardPage({ board, zone }: { readonly board: Board; readonly zone: string }) {
  const { world } = board;
  const shown = board.rows.flatMap(row => row.columns.flatMap(column => column.tasks));
  const stopped = shown.filter(task => task.state === 'stopped').length;
  const open = shown.length - stopped;
  return (
    <main style={page}>
      <Heading title="Tasks" note={world.kind === 'tasks' ? `${String(open)} open and ${String(stopped)} stopped, at the step each one is at.` : undefined}>
        {world.kind === 'tasks' ? <ViewSwitch current="board" /> : null}
      </Heading>
      {world.kind !== 'tasks' ? (
        <EmptyWorld world={world} zone={zone} />
      ) : (
        board.rows.map(row => <Row key={row.workflow} row={row} />)
      )}
    </main>
  );
}
