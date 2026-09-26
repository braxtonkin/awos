'use client';

import { isFailed } from '../../shared/task-status.ts';
import { color, type ColorName } from '../../shared/ui/tokens.ts';
import type { Stream } from '../../shared/ui/use-frames.ts';
import type { TaskLive } from './protocol.ts';
import type { Step } from './read.ts';
import { useLive } from './status-card.tsx';
import { stepName } from './time.ts';

type StepState = 'done' | 'running' | 'waiting' | 'failed' | 'stopped' | 'next';

const looks: Readonly<Record<StepState, { readonly label: string; readonly tone: ColorName; readonly filled: boolean }>> = {
  done: { label: 'Done', tone: 'ink', filled: true },
  running: { label: 'Running', tone: 'run', filled: true },
  waiting: { label: 'Waiting', tone: 'attn', filled: true },
  failed: { label: 'Failed', tone: 'fail', filled: true },
  stopped: { label: 'Stopped', tone: 'muted', filled: true },
  next: { label: 'Not yet', tone: 'faint', filled: false },
};

function currentState(task: TaskLive): StepState {
  const newestVerdict = task.attempts.at(-1)?.verdict ?? null;
  switch (task.state) {
    case 'ready':
      return 'running';
    case 'waiting':
      return isFailed({ state: task.state, waitingOn: task.waitingOn, newestVerdict }) ? 'failed' : 'waiting';
    case 'stopped':
      return 'stopped';
    case 'done':
      return 'done';
  }
}

function statesOf(task: TaskLive, steps: readonly Step[]): readonly StepState[] {
  const current = steps.findIndex(step => step.name === task.step);
  return steps.map((_, index) => {
    if (task.state === 'done' || index < current) return 'done';
    return index === current ? currentState(task) : 'next';
  });
}

type StepperProps = { readonly initial: TaskLive; readonly steps: readonly Step[]; readonly stream: Stream };

export function Stepper({ initial, steps, stream }: StepperProps) {
  const task = useLive(initial, stream);
  const states = statesOf(task, steps);
  return (
    <ol aria-label="Steps" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {steps.map((step, index) => {
        const state = states[index] ?? 'next';
        const look = looks[state];
        const current = step.name === task.step && task.state !== 'done';
        return (
          <li
            key={step.name}
            data-step-state={state}
            aria-current={current ? 'step' : undefined}
            style={{ flex: '1 1 120px', display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: current ? 600 : 500 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: look.filled ? color(look.tone) : 'transparent', border: `1px solid ${color(look.tone)}` }} />
              {stepName(step.name)}
            </span>
            <span style={{ fontSize: 12, color: color(look.tone === 'ink' || look.tone === 'faint' ? 'muted' : look.tone) }}>{step.gate ? `${look.label} · Gate` : look.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
