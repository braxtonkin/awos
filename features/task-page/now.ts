import type { Item } from '../../shared/items.ts';
import { review, type Review } from '../../shared/review.ts';
import { isFailed } from '../../shared/task-status.ts';
import { clock } from '../../shared/ui/clock.ts';
import type { AttemptTranscript, TaskLive } from './protocol.ts';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';
import { actionLine, type Action } from './tool-actions.ts';

export type Tone = 'run' | 'attn' | 'muted';

export type Now = { readonly tone: Tone; readonly lead: string | null; readonly line: string; readonly detail: string | null };

export const reviewOf = (text: string): Review | undefined => {
  try {
    return review.loose().safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
};

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

function doing(item: Item | undefined, action: Action | undefined): string {
  if (item === undefined) return 'Starting';
  const running = item.status === 'inProgress';
  switch (item.type) {
    case 'commandExecution':
      return action === undefined ? (running ? 'Running a command' : 'Ran a command') : actionLine(action, running);
    case 'fileChange':
      return action === undefined ? (running ? 'Changing files' : 'Changed files') : actionLine(action, running);
    case 'reasoning':
      return 'Thinking';
    case 'userMessage':
      return 'Reading a message';
    case 'agentMessage': {
      if (running || item.text.trim() === '') return 'Writing a message';
      const ended = reviewOf(item.text);
      return ended === undefined ? firstLine(item.text) : `Finished: ${firstLine(ended.summary)}`;
    }
    default:
      return running ? 'Using a tool' : 'Used a tool';
  }
}

export function nowOf(live: TaskLive, attempts: readonly AttemptTranscript[], zone: string): Now | null {
  const newest = live.attempts.at(-1);
  const step = stepName(newest?.step ?? live.step);
  if (live.state === 'ready' && newest !== undefined && newest.finishedAt === null) {
    const shown = attempts.find(each => each.attempt === newest.id);
    const items = shown?.transcript.items ?? [];
    const last = items.findLast(item => item.type !== 'userMessage' || items.indexOf(item) > 0);
    return { tone: 'run', lead: `${step}, try ${String(numbered(live.attempts, newest.id))}`, line: doing(last, last === undefined ? undefined : shown?.actions[last.id]), detail: null };
  }
  switch (live.state) {
    case 'ready':
      return { tone: 'run', lead: null, line: `${stepName(live.step)} starts in a moment.`, detail: null };
    case 'stopped':
      return { tone: 'muted', lead: null, line: live.stoppedBy === null ? `Stopped at ${stepName(live.step)}.` : `${live.stoppedBy.name} stopped it at ${clock(live.stoppedBy.at, zone)}.`, detail: 'Stopping kept the work already pushed. Retry starts the agent again.' };
    case 'done':
      return { tone: 'muted', lead: null, line: 'The task landed. This is what the agent did.', detail: null };
    case 'waiting':
      break;
  }
  if (isFailed({ state: live.state, waitingOn: live.waitingOn, newestVerdict: newest?.verdict ?? null })) return null;
  switch (live.waitingOn) {
    case 'answer':
      return { tone: 'attn', lead: null, line: 'The agent asked a question. Answer it below.', detail: null };
    case 'approval':
      return { tone: 'attn', lead: null, line: `${step} finished and waits for your approval.`, detail: null };
    default:
      return { tone: 'attn', lead: null, line: live.waitingReason ?? `${step} waits for a person.`, detail: null };
  }
}
