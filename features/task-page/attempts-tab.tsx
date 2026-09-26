import type { Verdict } from '../../shared/db/types.ts';
import { between, clock } from '../../shared/ui/clock.ts';
import { color } from '../../shared/ui/tokens.ts';
import { tryOf } from './evidence-tab.tsx';
import type { AttemptRow } from './read.ts';
import { stepName } from './time.ts';

const results: Readonly<Record<Verdict, string>> = {
  pass: 'Passed',
  behavior_fail: 'Found the behavior still wrong',
  environment_fail: 'The environment broke',
  fail: 'Failed',
  red_check: 'A check on the pull request went red',
  lost: 'Lost, because the agent stopped answering',
  not_launched: 'Could not start',
  needs_input: 'Asked a question',
  changes_requested: 'Changes were requested',
  review_required: 'Waited for a review',
  handed_off: 'Handed off',
  stopped: 'Stopped by a person',
};

const resultOf = (row: AttemptRow): string => (row.verdict === null ? (row.finishedAt === null ? 'Still running' : 'Ended with no result') : results[row.verdict]);

const cell = { padding: '8px 12px', borderBottom: `1px solid ${color('rule')}`, textAlign: 'left', verticalAlign: 'top' } as const;

const head = { ...cell, fontSize: 12, fontWeight: 500, color: color('muted') } as const;

type AttemptsTabProps = { readonly attempts: readonly AttemptRow[]; readonly zone: string };

export function AttemptsTab({ attempts, zone }: AttemptsTabProps) {
  if (attempts.length === 0) return <p style={{ margin: 0, color: color('muted') }}>No attempt has started yet.</p>;
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
          <th scope="col" style={head}>
            Ran as
          </th>
          <th scope="col" style={head}>
            Started
          </th>
          <th scope="col" style={head}>
            Length
          </th>
        </tr>
      </thead>
      <tbody>
        {attempts.map(row => (
          <tr key={row.id} data-attempt-row={row.id} data-verdict={row.verdict ?? 'none'}>
            <td style={cell}>{`${stepName(row.step)}, try ${String(tryOf(attempts, row.id))}`}</td>
            <td style={cell} data-result="true">
              {resultOf(row)}
            </td>
            <td style={cell}>{row.person}</td>
            <td style={cell}>{clock(row.startedAt, zone)}</td>
            <td style={cell}>{row.finishedAt === null ? 'Still running' : between(row.startedAt, row.finishedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
