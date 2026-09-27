import { between } from '../../shared/ui/clock.ts';
import { color } from '../../shared/ui/tokens.ts';
import { resultOf } from './ending.ts';
import { Folded } from './folded.tsx';
import type { AttemptSummary } from './protocol.ts';
import { stepName } from './time.ts';
import { numbered, runsAsOf } from './timeline.ts';

const cell = { padding: '8px 12px', borderBottom: `1px solid ${color('rule')}`, textAlign: 'left', verticalAlign: 'top' } as const;

const head = { ...cell, fontSize: 12, fontWeight: 500, color: color('muted') } as const;

const stepCell = { ...cell, whiteSpace: 'nowrap' } as const;

const told = { margin: '8px 0 0', color: color('muted'), whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

function Result({ row }: { readonly row: AttemptSummary }) {
  const line = resultOf(row);
  const rest = [...new Set([row.summary, row.body])].filter((words): words is string => words !== null && words !== line);
  if (rest.length === 0) return line;
  return (
    <Folded field="words" summary={<summary style={{ cursor: 'pointer' }}>{line}</summary>}>
      {rest.map(words => (
        <p key={words} style={told}>
          {words}
        </p>
      ))}
    </Folded>
  );
}

export function AttemptsTab({ attempts }: { readonly attempts: readonly AttemptSummary[] }) {
  if (attempts.length === 0) return <p style={{ margin: 0, color: color('muted') }}>No attempt has started yet.</p>;
  const runsAs = runsAsOf(attempts);
  const someoneElse = attempts.some(row => row.person !== runsAs);
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th scope="col" style={head}>
            Step
          </th>
          <th scope="col" style={head}>
            Result
          </th>
          {someoneElse ? (
            <th scope="col" style={head}>
              Ran as
            </th>
          ) : null}
          <th scope="col" style={head}>
            Length
          </th>
        </tr>
      </thead>
      <tbody>
        {attempts.map(row => (
          <tr key={row.id} data-attempt-row={row.id} data-verdict={row.verdict ?? 'none'}>
            <td style={stepCell}>{`${stepName(row.step)}, try ${String(numbered(attempts, row.id))}`}</td>
            <td style={cell} data-result="true">
              <Result row={row} />
            </td>
            {someoneElse ? <td style={cell}>{row.person}</td> : null}
            <td style={cell}>{row.finishedAt === null ? 'Still running' : between(row.startedAt, row.finishedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
