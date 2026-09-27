import { z } from 'zod';
import type { TaskState, Verdict, WaitingOn } from './db/types.ts';

export type TaskFacts = { readonly state: TaskState; readonly waitingOn: WaitingOn | null; readonly newestVerdict: Verdict | null };

export const marks = ['failed', 'needs-you', 'running', 'stopped', 'landed'] as const;

export type Mark = (typeof marks)[number];

export const failing: Readonly<Record<Verdict, boolean>> = {
  behavior_fail: true,
  environment_fail: true,
  fail: true,
  lost: true,
  not_launched: true,
  red_check: true,
  changes_requested: false,
  conflict: false,
  handed_off: false,
  needs_input: false,
  pass: false,
  review_required: false,
  stopped: false,
};

const isVerdict = (value: unknown): value is Verdict => typeof value === 'string' && Object.hasOwn(failing, value);

export const verdict = z.custom<Verdict>(isVerdict);

export const isRunning = (task: TaskFacts): boolean => task.state === 'ready';

export const needsYou = (task: TaskFacts): boolean => task.state === 'waiting';

export const isFailed = (task: TaskFacts): boolean => task.state === 'waiting' && task.waitingOn === 'retry' && task.newestVerdict !== null && failing[task.newestVerdict];

export const isStopped = (task: TaskFacts): boolean => task.state === 'stopped';

export const isLanded = (task: TaskFacts): boolean => task.state === 'done';

const predicates: Readonly<Record<Mark, (task: TaskFacts) => boolean>> = {
  failed: isFailed,
  'needs-you': needsYou,
  running: isRunning,
  stopped: isStopped,
  landed: isLanded,
};

export const marksOf = (task: TaskFacts): readonly Mark[] => marks.filter(mark => predicates[mark](task));

export const markLabels: Readonly<Record<Mark, string>> = {
  running: 'Running',
  'needs-you': 'Needs you',
  failed: 'Failed',
  stopped: 'Stopped',
  landed: 'Landed',
};
