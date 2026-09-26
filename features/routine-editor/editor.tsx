'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { jiraSearch } from '../../shared/routine-draft.ts';
import { color } from '../../shared/ui/tokens.ts';
import { RoutineActions } from './actions.tsx';
import { fields, instructionsField, skillsField } from './form.ts';
import type { PressAction, SaveAction, SaveState } from './protocol.ts';
import type { Choice, Choices, RoutineForm } from './read.ts';
import { stepName, when } from './words.ts';

const sourceKinds: readonly Choice[] = [
  { id: jiraSearch, name: 'Jira search' },
  { id: 'schedule', name: 'Schedule, one task each run' },
];

const field = { height: 32, padding: '0 12px', borderRadius: 6, border: `1px solid ${color('rule-strong')}`, background: color('surface'), width: '100%' } as const;

const area = { ...field, height: 'auto', minHeight: 64, padding: '6px 12px', resize: 'vertical', lineHeight: '20px' } as const;

const hint = { fontSize: 12, color: color('muted') } as const;

function Field({ label, htmlFor, help, children }: { readonly label: string; readonly htmlFor: string; readonly help?: string; readonly children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 13, fontWeight: 500 }}>
        {label}
      </label>
      {children}
      {help === undefined ? null : <span style={hint}>{help}</span>}
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 24, background: color('surface'), border: `1px solid ${color('rule')}`, borderRadius: 8 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600 }}>{title}</h2>
      {children}
    </section>
  );
}

function Select({ id, name, value, choices, onChange }: { readonly id: string; readonly name: string; readonly value: string; readonly choices: readonly Choice[]; readonly onChange?: (value: string) => void }) {
  return (
    <select
      id={id}
      name={name}
      defaultValue={onChange === undefined ? value : undefined}
      value={onChange === undefined ? undefined : value}
      onChange={onChange === undefined ? undefined : event => { onChange(event.target.value); }}
      style={field}
    >
      {choices.map(choice => (
        <option key={choice.id} value={choice.id}>
          {choice.name}
        </option>
      ))}
    </select>
  );
}

const withCurrent = (choices: readonly Choice[], current: string): readonly Choice[] => (current === '' || choices.some(choice => choice.id === current) ? choices : [...choices, { id: current, name: current }]);

function Said({ state }: { readonly state: SaveState }) {
  if (state.kind === 'ready') return null;
  if (state.kind === 'invalid') {
    return (
      <ul role="alert" data-save="problems" style={{ margin: 0, paddingLeft: 20, color: color('fail'), display: 'flex', flexDirection: 'column', gap: 4 }}>
        {state.problems.map(problem => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    );
  }
  const sentence = {
    'pick-first': 'Pick who you are first',
    waiting: 'Waiting for the engine. Save again in a moment to see its answer.',
    refused: state.kind === 'refused' ? state.reason : '',
    saved: state.kind === 'saved' ? `Saved as version ${String(state.version)}` : '',
  }[state.kind];
  return (
    <span role={state.kind === 'refused' ? 'alert' : 'status'} data-save="said" style={{ fontSize: 13, color: state.kind === 'refused' ? color('fail') : color('ink') }}>
      {sentence}
    </span>
  );
}

type RoutineEditorProps = {
  readonly form: RoutineForm;
  readonly choices: Choices;
  readonly save: SaveAction;
  readonly press: PressAction;
  readonly request: string;
  readonly justSaved: number | undefined;
  readonly zone: string;
  readonly now: string;
};

export function RoutineEditor({ form, choices, save, press, request, justSaved, zone, now }: RoutineEditorProps) {
  const { draft } = form;
  const [state, dispatch, pending] = useActionState(save, justSaved === undefined ? { kind: 'ready', request } : { kind: 'saved', version: justSaved, request });
  const [workflow, setWorkflow] = useState(draft.workflow);
  const [kind, setKind] = useState(draft.source.kind);
  const steps = choices.workflows.find(each => each.name === workflow)?.steps ?? [];
  const workflows = withCurrent(
    choices.workflows.map(each => ({ id: each.name, name: each.name })),
    draft.workflow,
  );
  const accounts = [{ id: '', name: "The ticket's assignee" }, ...choices.people, ...choices.teamAccounts.map(account => ({ ...account, name: `${account.name}, team account` }))];
  const repositories = [...choices.repositories, { id: '', name: 'No repository' }];
  const lastSteps = [{ id: '', name: 'Run every step' }, ...steps.map(step => ({ id: step, name: `Stop after ${stepName(step)}` }))];
  return (
    <main style={{ padding: '32px 32px 64px', display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 760, width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 28 }}>
          <a href="/routines" style={{ fontSize: 13, color: color('muted') }}>
            Routines
          </a>
          {form.id === null ? null : (
            <span style={{ marginLeft: 'auto' }}>
              <RoutineActions routine={form.id} paused={form.paused} press={press} />
            </span>
          )}
        </div>
        <h1 style={{ fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>{form.id === null ? 'New routine' : draft.name}</h1>
        {form.saved === null ? null : (
          <p style={{ fontSize: 13, color: color('muted') }} data-version={form.saved.version}>
            Version {form.saved.version}, saved by {form.saved.by} {when(form.saved.at, now, zone)}
            {form.paused ? ', paused' : ''}
          </p>
        )}
      </div>
      <form action={dispatch} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <input type="hidden" name={fields.routine} value={form.id ?? ''} />
        <input type="hidden" name={fields.request} value={state.request} />
        <input type="hidden" name={fields.from} value={draft.from === null ? '' : String(draft.from)} />
        <input type="hidden" name={fields.ignoreLaterReviews} value={String(draft.ignoreLaterReviews)} />
        {draft.source.pageSize === undefined ? null : <input type="hidden" name={fields.pageSize} value={String(draft.source.pageSize)} />}
        <Section title="What it does">
          <Field label="Name" htmlFor="routine-name">
            <input id="routine-name" name={fields.name} defaultValue={draft.name} autoComplete="off" style={field} />
          </Field>
          <Field label="Goal" htmlFor="routine-goal" help="The agent reads the goal before every step.">
            <textarea id="routine-goal" name={fields.goal} defaultValue={draft.goal} rows={2} style={area} />
          </Field>
          <Field label="Workflow" htmlFor="routine-workflow">
            <Select id="routine-workflow" name={fields.workflow} value={workflow} choices={workflows} onChange={setWorkflow} />
          </Field>
        </Section>
        <Section title="Where it finds work">
          <Field label="Source" htmlFor="routine-source">
            <Select id="routine-source" name={fields.sourceKind} value={kind} choices={withCurrent(sourceKinds, draft.source.kind)} onChange={setKind} />
          </Field>
          {kind === jiraSearch ? (
            <>
              <Field label="JQL" htmlFor="routine-jql" help="Each ticket this search finds becomes a task.">
                <textarea id="routine-jql" name={fields.jql} defaultValue={draft.source.jql ?? ''} rows={2} spellCheck={false} className="mono" style={area} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <Field label="Jira status when work starts" htmlFor="routine-start-status" help="Optional">
                  <input id="routine-start-status" name={fields.startStatus} defaultValue={draft.jiraStartStatus ?? ''} autoComplete="off" style={field} />
                </Field>
                <Field label="Jira status when work ends" htmlFor="routine-end-status" help="Optional">
                  <input id="routine-end-status" name={fields.endStatus} defaultValue={draft.jiraEndStatus ?? ''} autoComplete="off" style={field} />
                </Field>
              </div>
            </>
          ) : null}
          <Field label="Every" htmlFor="routine-every" help="Minutes between runs, up to one day.">
            <input id="routine-every" name={fields.everyMinutes} type="number" min={1} max={1440} defaultValue={draft.everyMinutes} style={{ ...field, width: 120 }} />
          </Field>
        </Section>
        <Section title="How it runs">
          <Field label="Repository" htmlFor="routine-repository">
            <Select id="routine-repository" name={fields.repository} value={draft.repository ?? ''} choices={repositories} />
          </Field>
          <Field label="Run as" htmlFor="routine-run-as" help="Tasks act with this account's logins.">
            <Select id="routine-run-as" name={fields.runAs} value={draft.runAs ?? ''} choices={accounts} />
          </Field>
          <Field label="Last step" htmlFor="routine-last-step">
            <Select key={workflow} id="routine-last-step" name={fields.lastStep} value={workflow === draft.workflow ? (draft.lastStep ?? '') : ''} choices={lastSteps} />
          </Field>
        </Section>
        <Section title="Steps">
          {steps.map((step, index) => {
            const settings = workflow === draft.workflow ? draft.steps[step] : undefined;
            return (
              <div key={`${workflow}:${step}`} data-step={step} style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: index === 0 ? 0 : 16, borderTop: index === 0 ? 'none' : `1px solid ${color('rule')}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600 }}>{stepName(step)}</h3>
                  {index === steps.length - 1 ? null : (
                    <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <input type="checkbox" name={fields.gate} value={step} defaultChecked={workflow === draft.workflow && draft.gates.includes(step)} />
                      Wait for approval after this step
                    </label>
                  )}
                </div>
                <Field label="Instructions" htmlFor={`instructions-${step}`}>
                  <textarea id={`instructions-${step}`} name={instructionsField(step)} defaultValue={settings?.instructions ?? ''} rows={2} style={area} />
                </Field>
                <Field label="Skills" htmlFor={`skills-${step}`} help="Skill names, separated by commas.">
                  <input id={`skills-${step}`} name={skillsField(step)} defaultValue={settings?.skills.join(', ') ?? ''} autoComplete="off" spellCheck={false} style={field} />
                </Field>
              </div>
            );
          })}
        </Section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button type="submit" disabled={pending} data-save="button" style={{ height: 32, padding: '0 16px', borderRadius: 6, border: 0, background: color('ink'), color: color('surface'), fontWeight: 500, cursor: 'pointer' }}>
            {pending ? 'Saving' : form.id === null ? 'Create routine' : 'Save'}
          </button>
          {pending ? null : <Said state={state} />}
        </div>
      </form>
    </main>
  );
}
