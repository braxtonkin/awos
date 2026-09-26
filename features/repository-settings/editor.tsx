'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useActionState, useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import type { DraftLeaves } from '../../shared/repository-settings.ts';
import type { RequestAnswer } from '../../shared/requests.ts';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames } from '../../shared/ui/use-frames.ts';
import { frame, streamPath, type Field, type SaveAction, type SaveState } from './protocol.ts';
import type { Settings } from './read.ts';

type Draft = Readonly<Record<Field, string>>;

const draftOf = (settings: Settings | undefined, providers: readonly string[]): Draft => ({
  github: settings?.github ?? '',
  branch: settings?.branch ?? 'main',
  image: settings?.image ?? '',
  fastTestCommand: settings?.fastTestCommand ?? '',
  setupCommand: settings?.setupCommand ?? '',
  verifyProvider: settings?.verifyProvider ?? (providers.includes('tests-only') ? 'tests-only' : (providers[0] ?? '')),
  ignorableChecks: settings?.ignorableChecks.join('\n') ?? '',
  draftLeaves: settings?.draftLeaves ?? 'when-green',
  ignoredReviewers: settings?.ignoredReviewers.join('\n') ?? '',
});

const labels: Readonly<Record<Field, string>> = {
  github: 'Repository',
  branch: 'Branch',
  image: 'Job image',
  fastTestCommand: 'Fast test command',
  setupCommand: 'Setup command',
  verifyProvider: 'Verify provider',
  ignorableChecks: 'Ignorable checks',
  draftLeaves: 'Draft pull request',
  ignoredReviewers: 'Ignored reviewers',
};

const hints: Readonly<Record<Field, string>> = {
  github: 'The owner and name on GitHub, such as example/sandbox.',
  branch: 'Tasks start from this branch and merge back into it.',
  image: 'Name it by digest, as name@sha256: and 64 hex digits, because a tag can move. Leave it blank for the default image.',
  fastTestCommand: 'Verify runs this to check a change quickly.',
  setupCommand: 'Installs what a fresh checkout needs before Verify reproduces the change.',
  verifyProvider: 'Where Verify runs the change.',
  ignorableChecks: 'One check per line. A failed check named here does not hold the pull request back.',
  draftLeaves: '',
  ignoredReviewers: 'One GitHub login per line. Changes they request never send the task back.',
};

const leaving: Readonly<Record<DraftLeaves, { readonly label: string; readonly says: string }>> = {
  'when-green': { label: 'Ready when checks pass', says: 'AutoWorker marks the draft ready for review once its checks pass.' },
  'at-once': { label: 'Ready at once', says: 'AutoWorker marks the draft ready for review as soon as it reaches Land, without waiting for its checks.' },
};

const said = (state: SaveState, answer: RequestAnswer | undefined): string | undefined => {
  switch (state.kind) {
    case 'ready':
      return undefined;
    case 'saved':
      return 'Saved';
    case 'pick-first':
      return 'Pick who you are first';
    case 'invalid':
      return 'Fix the fields marked in red';
    case 'sent':
      if (answer === undefined || answer === 'waiting') return 'Waiting for the engine';
      return 'recorded' in answer ? 'Saved' : answer.refused;
  }
};

const box = { width: '100%', padding: '6px 12px', borderRadius: 6, border: `1px solid ${color('rule')}`, background: color('surface') } as const;

function Row({ field, problem, children }: { readonly field: Field; readonly problem: string | undefined; readonly children: ReactNode }) {
  const note = problem === undefined ? hints[field] : `${labels[field]} ${problem}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={field} style={{ fontSize: 13, fontWeight: 500 }}>
        {labels[field]}
      </label>
      {children}
      {note === '' ? null : (
        <p id={`${field}-note`} data-problem={problem === undefined ? undefined : field} style={{ fontSize: 12, color: color(problem === undefined ? 'muted' : 'fail') }}>
          {note}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 24, borderTop: `1px solid ${color('rule')}` }}>
      <h2 style={{ fontSize: 15, fontWeight: 600 }}>{title}</h2>
      {children}
    </section>
  );
}

type EditorProps = { readonly settings: Settings | undefined; readonly providers: readonly string[]; readonly action: SaveAction; readonly initial: SaveState };

export function Editor({ settings, providers, action, initial }: EditorProps) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(action, initial);
  const [draft, setDraft] = useState(() => draftOf(settings, providers));
  const [answers, setAnswers] = useState<Readonly<Record<string, { readonly answer: RequestAnswer; readonly repository: string | null }>>>({});
  useFrames({ path: streamPath, after: undefined }, frame, next => {
    setAnswers(known => ({ ...known, [next.request]: { answer: next.answer, repository: next.repository } }));
  });
  const heard = state.kind === 'sent' ? (answers[state.request] ?? state) : undefined;
  const landed = state.kind === 'sent' && heard !== undefined && typeof heard.answer === 'object' && 'recorded' in heard.answer ? heard.repository : null;
  useEffect(() => {
    if (landed !== null && state.kind === 'sent') router.replace(`/repositories/${landed}?saved=${state.request}`);
  }, [landed, state, router]);
  const problems = state.kind === 'invalid' ? state.problems : {};
  const sentence = pending ? 'Saving' : said(state, heard?.answer);
  const set = (field: Field) => (event: { readonly target: { readonly value: string } }) => {
    setDraft(current => ({ ...current, [field]: event.target.value }));
  };
  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(form);
    });
  };
  const input = (field: Field, mono = false) => (
    <input
      id={field}
      name={field}
      value={draft[field]}
      onChange={set(field)}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={problems[field] === undefined ? undefined : true}
      aria-describedby={`${field}-note`}
      className={mono ? 'mono' : undefined}
      style={{ ...box, height: 32, ...(problems[field] === undefined ? {} : { borderColor: color('fail') }) }}
    />
  );
  const list = (field: Field) => (
    <textarea id={field} name={field} value={draft[field]} onChange={set(field)} rows={2} spellCheck={false} aria-describedby={`${field}-note`} className="mono" style={{ ...box, resize: 'vertical', ...(problems[field] === undefined ? {} : { borderColor: color('fail') }) }} />
  );
  const leaves = draft.draftLeaves === 'at-once' ? 'at-once' : 'when-green';
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <input type="hidden" name="repository" value={settings?.id ?? ''} />
      {settings === undefined ? <Row field="github" problem={problems.github}>{input('github', true)}</Row> : null}
      <Row field="branch" problem={problems.branch}>
        {input('branch', true)}
      </Row>
      <Section title="Testing">
        <Row field="verifyProvider" problem={problems.verifyProvider}>
          <select id="verifyProvider" name="verifyProvider" value={draft.verifyProvider} onChange={set('verifyProvider')} aria-describedby="verifyProvider-note" style={{ ...box, height: 32, width: 240 }}>
            {providers.map(provider => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </Row>
        <Row field="fastTestCommand" problem={problems.fastTestCommand}>
          {input('fastTestCommand', true)}
        </Row>
        <Row field="setupCommand" problem={problems.setupCommand}>
          {input('setupCommand', true)}
        </Row>
        <Row field="image" problem={problems.image}>
          {input('image', true)}
        </Row>
      </Section>
      <Section title="Pull request">
        <fieldset style={{ margin: 0, padding: 0, border: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <legend style={{ padding: 0, marginBottom: 6, fontSize: 13, fontWeight: 500 }}>{labels.draftLeaves}</legend>
          <div style={{ display: 'flex', gap: 24 }}>
            {(['when-green', 'at-once'] as const).map(option => (
              <label key={option} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="radio" name="draftLeaves" value={option} checked={leaves === option} onChange={set('draftLeaves')} />
                {leaving[option].label}
              </label>
            ))}
          </div>
          <p data-draft-says={leaves} style={{ fontSize: 12, color: color('muted') }}>
            {leaving[leaves].says}
          </p>
        </fieldset>
        <Row field="ignorableChecks" problem={problems.ignorableChecks}>
          {list('ignorableChecks')}
        </Row>
        <Row field="ignoredReviewers" problem={problems.ignoredReviewers}>
          {list('ignoredReviewers')}
        </Row>
      </Section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingTop: 24, borderTop: `1px solid ${color('rule')}` }}>
        <button type="submit" data-save="button" disabled={pending} style={{ height: 32, padding: '0 16px', border: 0, borderRadius: 6, background: color('ink'), color: color('surface'), fontWeight: 500, cursor: 'pointer' }}>
          {settings === undefined ? 'Add repository' : 'Save'}
        </button>
        {sentence === undefined ? null : (
          <span role="status" data-save="said" style={{ fontSize: 13, color: state.kind === 'invalid' || (heard !== undefined && typeof heard.answer === 'object' && 'refused' in heard.answer) ? color('fail') : color('ink') }}>
            {sentence}
          </span>
        )}
      </div>
    </form>
  );
}
