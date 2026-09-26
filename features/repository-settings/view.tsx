import { color } from '../../shared/ui/tokens.ts';
import { Editor } from './editor.tsx';
import type { SaveAction } from './protocol.ts';
import type { Editing, Listed } from './read.ts';

const page = { padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%', maxWidth: 720 } as const;

const title = { fontSize: 24, lineHeight: '32px', fontWeight: 600 } as const;

const quiet = { fontSize: 13, color: color('muted') } as const;

const addLink = { height: 32, display: 'inline-flex', alignItems: 'center', padding: '0 16px', borderRadius: 6, background: color('ink'), color: color('surface'), fontWeight: 500, textDecoration: 'none' } as const;

const stamp = (iso: string, zone: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(iso));

function Crumb({ here }: { readonly here: string }) {
  return (
    <span style={quiet}>
      <a href="/repositories" style={{ color: color('muted') }}>
        Repositories
      </a>{' '}
      › {here}
    </span>
  );
}

export function RepositoryList({ repositories }: { readonly repositories: readonly Listed[] }) {
  const cell = { padding: '12px 16px 12px 0', textAlign: 'left', borderBottom: `1px solid ${color('rule')}` } as const;
  return (
    <main style={{ ...page, maxWidth: 960 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={title}>Repositories</h1>
        <a href="/repositories/new" data-add="repository" style={{ ...addLink, marginLeft: 'auto' }}>
          Add repository
        </a>
      </div>
      {repositories.length === 0 ? (
        <p data-empty="repositories" style={{ color: color('muted') }}>
          No repositories yet. Add one so a routine can work in it, then pick it in the routine.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={quiet}>
              <th style={{ ...cell, fontWeight: 500 }}>Repository</th>
              <th style={{ ...cell, fontWeight: 500 }}>Branch</th>
              <th style={{ ...cell, fontWeight: 500 }}>Routines</th>
            </tr>
          </thead>
          <tbody>
            {repositories.map(repository => (
              <tr key={repository.id} data-repository={repository.github}>
                <td style={cell}>
                  <a href={`/repositories/${repository.id}`} style={{ fontWeight: 500, color: color('ink') }}>
                    {repository.github}
                  </a>
                </td>
                <td style={cell} className="mono">
                  {repository.branch}
                </td>
                <td style={{ ...cell, color: repository.routines.length === 0 ? color('muted') : color('ink') }}>{repository.routines.length === 0 ? 'No routine uses it yet' : repository.routines.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

type SettingsPageProps = { readonly editing: Editing; readonly action: SaveAction; readonly saved: string | undefined; readonly zone: string };

export function SettingsPage({ editing, action, saved, zone }: SettingsPageProps) {
  const { settings, providers } = editing;
  const arrivedSaved = settings !== undefined && saved === settings.saving;
  return (
    <main style={page}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Crumb here={settings === undefined ? 'New' : settings.github} />
        <h1 style={title}>{settings === undefined ? 'Add a repository' : settings.github}</h1>
        <p style={quiet}>{settings === undefined ? 'Routines can work in it once it is added.' : `Last saved by ${settings.savedBy}, ${stamp(settings.savedAt, zone)}`}</p>
      </div>
      <Editor key={settings?.saving ?? 'new'} settings={settings} providers={providers} action={action} initial={arrivedSaved ? { kind: 'saved' } : { kind: 'ready' }} />
    </main>
  );
}
