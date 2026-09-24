import type { Source } from '../../shared/routine-source.ts';

export const scheduleSource: Source = {
  kind: 'schedule',
  find: run =>
    Promise.resolve([{ key: `${run.routine}/${run.run}`, title: `${run.name}, ${run.reason === 'schedule' ? 'the run due' : 'Run now pressed'} at ${run.occurrence.toISOString()}`, assignee: null }]),
};
