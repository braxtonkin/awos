import { expect, test } from 'vitest';
import { fail, info, pass, render } from '../../tools/verify/check.ts';
import { laneLines, lanes } from './lanes.ts';

const noAssignee = lanes.find(lane => lane.slug === 'no-assignee');
const regression = lanes.find(lane => lane.slug === 'regression');

test('a failing check that does not decide the lane prints INFO failed, never PASS, and is not counted', () => {
  if (noAssignee === undefined) throw new Error('lane 4 is missing');
  const planted = [fail('merged', 'not reached'), info('ticket filed to merged within 45 minutes', 'n/a', 'not merged'), pass('lane 4: no attempt row exists', '0 attempts')];
  const { text, exitCode } = render(laneLines(noAssignee, planted));
  expect(text).toBe(
    [
      'INFO  merged  (failed: not reached)',
      'INFO  ticket filed to merged within 45 minutes  (n/a: not merged)',
      'PASS  lane 4: no attempt row exists  (0 attempts)',
      'PASS  lane 4 no-assignee: 1 of 1 deciding checks passed',
      '2 of 2 checks passed, and 2 info lines decide nothing',
      '',
    ].join('\n'),
  );
  expect(exitCode).toBe(0);
});

test('a time limit whose step never happened fails a lane that expects the step', () => {
  if (regression === undefined) throw new Error('lane 1 is missing');
  const { text, exitCode } = render(laneLines(regression, [info('run 1: ticket filed to clean within 45 minutes', 'n/a', 'not clean')]));
  expect(text).toBe(
    [
      'FAIL  run 1: ticket filed to clean within 45 minutes  (n/a: not clean, and this lane expects it)',
      'FAIL  lane 1 regression: 0 of 1 deciding checks passed  (run 1: ticket filed to clean within 45 minutes)',
      '0 of 2 checks passed',
      '',
    ].join('\n'),
  );
  expect(exitCode).toBe(1);
});
