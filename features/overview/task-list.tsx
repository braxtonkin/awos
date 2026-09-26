import { markLabels, marks } from '../../shared/task-status.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { between, duration } from '../../shared/ui/clock.ts';
import { nameOf } from './format.ts';
import { actionLink, box, EmptyWorld, Heading, page, taskHref, ViewSwitch } from './parts.tsx';
import type { ListRow, Option, TaskList } from './read.ts';

const cell = { padding: '12px 16px', textAlign: 'left', verticalAlign: 'middle', borderTop: `1px solid ${color('rule')}` } as const;

const head = { ...cell, borderTop: 'none', fontSize: 12, fontWeight: 500, color: color('muted') } as const;

const field = { height: 32, padding: '0 8px', borderRadius: 6, border: `1px solid ${color('rule-strong')}`, background: color('surface'), fontSize: 13 } as const;

function Pick({ name, label, value, options, unset = 'Any' }: { readonly name: string; readonly label: string; readonly value: string | undefined; readonly options: readonly Option[]; readonly unset?: string }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: color('muted') }}>
      {label}
      <select name={name} defaultValue={value ?? ''} style={field}>
        <option value="">{unset}</option>
        {options.map(option => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const stateOptions: readonly Option[] = [...marks.map(mark => ({ id: mark, name: markLabels[mark] })), { id: 'all', name: 'All' }];

const lastColumn = (row: ListRow, now: string): string => {
  if (row.landedInMs !== null) return `took ${duration(row.landedInMs)}`;
  if (row.since === null) return '';
  const spent = between(row.since, now);
  const said: Readonly<Record<ListRow['state'], string>> = { ready: `running ${spent}`, waiting: `waiting ${spent}`, stopped: `stopped ${spent} ago`, done: `landed ${spent} ago` };
  return said[row.state];
};

const detailOf = (row: ListRow): string | null => {
  const said: Readonly<Record<ListRow['state'], string | null>> = { ready: `${nameOf(row.step)} is running.`, waiting: row.waitingReason, stopped: `Stopped at ${nameOf(row.step)}.`, done: null };
  return said[row.state];
};

function Rows({ rows, now }: { readonly rows: readonly ListRow[]; readonly now: string }) {
  return (
    <table style={{ ...box, width: '100%', tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, overflow: 'hidden' }}>
      <thead>
        <tr>
          <th style={{ ...head, width: 176 }}>Status</th>
          <th style={head}>Task</th>
          <th style={{ ...head, width: 140 }}>Routine</th>
          <th style={{ ...head, width: 160 }}>Person</th>
          <th style={{ ...head, width: 104 }}>Step</th>
          <th style={{ ...head, width: 152, textAlign: 'right' }}>Time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.key} data-task={row.key}>
            <td style={cell}>
              <StatusMarks marks={row.marks} />
            </td>
            <td style={cell}>
              <a href={taskHref(row.key)} style={{ display: 'flex', alignItems: 'baseline', gap: 8, color: color('ink'), textDecoration: 'none', minWidth: 0 }}>
                <span className="mono" style={{ color: color('muted'), flex: 'none' }}>{row.key}</span>
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
              </a>
              {detailOf(row) === null ? null : <span style={{ display: 'block', fontSize: 13, color: color('muted'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detailOf(row)}</span>}
            </td>
            <td style={{ ...cell, color: color('muted') }}>{row.routine}</td>
            <td style={{ ...cell, color: color('muted') }}>{row.person}</td>
            <td style={{ ...cell, color: color('muted') }}>{nameOf(row.step)}</td>
            <td data-time={row.landedInMs ?? undefined} style={{ ...cell, color: color('muted'), textAlign: 'right', whiteSpace: 'nowrap' }}>
              {lastColumn(row, now)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const noteOf = (list: TaskList): string => {
  const filtered = list.filters.routine !== undefined || list.filters.person !== undefined || (list.filters.state !== undefined && list.filters.state !== 'all');
  const noun = filtered ? 'matching tasks' : list.filters.state === 'all' ? 'tasks' : 'tasks not landed';
  if (list.matching > list.rows.length) return `The newest ${String(list.rows.length)} of ${String(list.matching)} ${noun}.`;
  if (list.matching === 1) return `1 of the ${noun}.`;
  return `${String(list.matching)} ${noun}, those that need a person first.`;
};

export function TaskListPage({ list, zone, now }: { readonly list: TaskList; readonly zone: string; readonly now: string }) {
  const { filters, world } = list;
  return (
    <main style={page}>
      <Heading title="Tasks" note={world.kind === 'tasks' ? noteOf(list) : undefined}>
        {world.kind === 'tasks' ? <ViewSwitch current="list" /> : null}
      </Heading>
      {world.kind !== 'tasks' ? (
        <EmptyWorld world={world} zone={zone} />
      ) : (
        <>
          <form method="get" action="/tasks" aria-label="Filter tasks" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
            <Pick name="state" label="Status" value={filters.state} options={stateOptions} unset="Not landed" />
            <Pick name="routine" label="Routine" value={filters.routine} options={list.routines} />
            <Pick name="person" label="Person" value={filters.person} options={list.people} />
            <button type="submit" style={{ ...actionLink, background: color('surface'), cursor: 'pointer' }}>
              Filter
            </button>
            {filters.state === undefined && filters.routine === undefined && filters.person === undefined ? null : (
              <a href="/tasks" style={{ fontSize: 13, color: color('muted') }}>
                Clear filters
              </a>
            )}
          </form>
          {list.rows.length === 0 ? (
            <p data-empty="filtered" style={{ ...box, padding: '32px 24px', color: color('muted') }}>
              No task matches these filters. Clear them to see every task.
            </p>
          ) : (
            <Rows rows={list.rows} now={now} />
          )}
        </>
      )}
    </main>
  );
}
