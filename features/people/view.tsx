import type { ReactNode } from 'react';
import type { PersonKind } from '../../shared/db/types.ts';
import { color } from '../../shared/ui/tokens.ts';
import { Avatar } from '../../shared/ui/top-bar.tsx';
import type { Account } from './read.ts';

const kindWords: Readonly<Record<PersonKind, string>> = { person: 'Person', shared: 'Team account' };

type Column = { readonly label: string; readonly cell: (account: Account, acting: string | undefined) => ReactNode };

const quiet = (text: string): ReactNode => <span style={{ color: color('faint') }}>{text}</span>;

const columns: readonly Column[] = [
  {
    label: 'Name',
    cell: (account, acting) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Avatar name={account.name} />
        <span style={{ fontWeight: 500 }}>{account.name}</span>
        {account.id === acting ? <span style={{ fontSize: 12, color: color('muted') }}>You</span> : null}
      </span>
    ),
  },
  { label: 'Email', cell: account => account.email },
  { label: 'Jira account', cell: account => (account.jiraAccount === null ? quiet('None') : <span className="mono">{account.jiraAccount}</span>) },
  { label: 'Kind', cell: account => (account.kind === 'shared' ? kindWords.shared : quiet(kindWords.person)) },
];

const cellStyle = { padding: '12px 16px', textAlign: 'left', verticalAlign: 'middle', overflowWrap: 'anywhere' } as const;

type PeoplePageProps = { readonly people: readonly Account[]; readonly acting: string | undefined };

export function PeoplePage({ people, acting }: PeoplePageProps) {
  return (
    <main style={{ padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%', maxWidth: 1120 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{ fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>People</h1>
        <p style={{ fontSize: 13, color: color('muted') }}>You act as a person. A team account only runs work, so you can't act as one.</p>
      </div>
      <table data-people="table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, background: color('surface'), border: `1px solid ${color('rule')}`, borderRadius: 8, fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(column => (
              <th key={column.label} scope="col" style={{ ...cellStyle, padding: '8px 16px', fontSize: 12, fontWeight: 500, color: color('muted') }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map(account => (
            <tr key={account.id} data-name={account.name} data-kind={account.kind}>
              {columns.map(column => (
                <td key={column.label} style={{ ...cellStyle, borderTop: `1px solid ${color('rule')}` }}>
                  {column.cell(account, acting)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
