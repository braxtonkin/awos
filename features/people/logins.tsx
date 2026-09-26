'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, type CSSProperties } from 'react';
import type { ConnectorKind } from '../../shared/db/types.ts';
import { pickFirst } from '../../shared/ui/use-send.ts';
import { field, hint, primary } from '../../shared/ui/controls.ts';
import { color, type ColorName } from '../../shared/ui/tokens.ts';
import { loginNames, notReplacing, sayLogin, type Login, type ReplaceLogin, type Replacing, type Tone } from './logins.ts';

const tones: Readonly<Record<Tone, ColorName>> = { plain: 'ink', quiet: 'faint', attn: 'attn' };

const refreshEveryMs = 5000;

const refreshForMs = 10 * 60_000;

export function RefreshWhileChecking({ checking }: { readonly checking: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!checking) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > refreshForMs) clearInterval(timer);
      else router.refresh();
    }, refreshEveryMs);
    return () => {
      clearInterval(timer);
    };
  }, [checking, router]);
  return null;
}

const answers: Readonly<Record<Exclude<Replacing['kind'], 'ready' | 'refused'>, string>> = {
  'pick-first': pickFirst,
  off: 'Replacing logins is off, so nothing was saved.',
  saved: 'Saved. The engine checks it next.',
};

const codexWarning = 'The engine refreshes this login, and each refresh signs out every other copy of it, so paste one you made only for AutoWorker.';

const secretLabels: Readonly<Record<ConnectorKind, string>> = { github: 'New token', codex: 'New auth.json', jira: 'New login, as email:token' };

const quietLink: CSSProperties = { fontSize: 13, fontWeight: 500, color: color('muted') };

const replaceHref = (login: Login): string => `/people?login=${login.connector}&owner=${login.owner}#login-${login.owner}-${login.connector}`;

function SecretField({ connector, id }: { readonly connector: ConnectorKind; readonly id: string }) {
  const shared = { id, name: 'secret', required: true, autoComplete: 'off', spellCheck: false, autoFocus: true, className: 'mono', style: { ...field, fontSize: 12 } } as const;
  return connector === 'codex' ? <textarea {...shared} rows={4} /> : <input {...shared} type="password" />;
}

function ReplaceForm({ login, action }: { readonly login: Login; readonly action: ReplaceLogin }) {
  const [state, dispatch, pending] = useActionState(action, notReplacing);
  const secretId = `secret-${login.owner}-${login.connector}`;
  return (
    <form action={dispatch} data-login-form={login.connector} style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4, paddingBottom: 8 }}>
      <input type="hidden" name="owner" value={login.owner} />
      <input type="hidden" name="connector" value={login.connector} />
      <label htmlFor={secretId} style={hint}>
        {secretLabels[login.connector]}
      </label>
      <SecretField connector={login.connector} id={secretId} />
      {login.connector === 'codex' ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" name="made" value="yes" style={{ margin: 0 }} />
          <span>
            I made this login for AutoWorker. <span style={{ color: color('muted') }}>{codexWarning}</span>
          </span>
        </label>
      ) : null}
      <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button type="submit" disabled={pending} style={primary}>
          {pending ? 'Saving' : 'Save'}
        </button>
        <a href="/people" style={quietLink}>
          Cancel
        </a>
        <span data-replaced={login.connector} role="status" style={{ fontSize: 13, color: color(state.kind === 'refused' ? 'attn' : 'muted') }}>
          {state.kind === 'ready' ? null : state.kind === 'refused' ? state.reason : answers[state.kind]}
        </span>
      </span>
    </form>
  );
}

const row: CSSProperties = { display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr) auto', columnGap: 12, rowGap: 4, alignItems: 'baseline' };

type LoginsProps = { readonly logins: readonly Login[]; readonly now: string; readonly zone: string; readonly action: ReplaceLogin | undefined; readonly open: ConnectorKind | undefined };

export function Logins({ logins, now, zone, action, open }: LoginsProps) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {logins.map(login => {
        const said = sayLogin(login, now, zone);
        const opened = open === login.connector;
        return (
          <li key={login.connector} id={`login-${login.owner}-${login.connector}`} data-login={login.connector} data-tone={said.tone} style={row}>
            <span style={{ fontWeight: 500 }}>{loginNames[login.connector]}</span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span data-said={login.connector} style={{ color: color(tones[said.tone]) }}>
                {said.text}
              </span>
              {said.cause === null ? null : <span style={{ fontSize: 12, color: color('muted') }}>{said.cause}</span>}
            </span>
            {action === undefined || opened ? null : (
              <a href={replaceHref(login)} data-replace={login.connector} style={quietLink}>
                Replace
              </a>
            )}
            {action !== undefined && opened ? <ReplaceForm login={login} action={action} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
