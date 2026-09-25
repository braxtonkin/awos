import { expect, test } from 'vitest';
import { fail, info, pass, render } from '../../tools/verify/check.ts';
import { runScenario } from '../../tools/verify/scenarios.ts';
import { teamAccount } from './autoworker.ts';
import { describeReply } from './harness.ts';
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

const missing = "not in the run's output, and this lane expects it";

test('lane 7 fails and names the read-back when the run posted its report but never read it back', () => {
  const report = lanes.find(lane => lane.slug === 'report');
  if (report === undefined) throw new Error('lane 7 is missing');
  const { text, exitCode } = render(laneLines(report, [pass('report posted', 'https://jira.example/browse/SBX-1?focusedCommentId=1')]));
  expect(text).toBe(
    [
      'INFO  report posted  (passed: https://jira.example/browse/SBX-1?focusedCommentId=1)',
      `FAIL  the report comment reads back from Jira with its timeline, input tokens per step, and every link  (${missing})`,
      'FAIL  lane 7 report: 0 of 1 deciding checks passed  (the report comment reads back from Jira with its timeline, input tokens per step, and every link)',
      '0 of 2 checks passed, and 1 info lines decide nothing',
      '',
    ].join('\n'),
  );
  expect(exitCode).toBe(1);
});

test('lane 5 fails and names the run-as record and the started Job when the run stops before clean', () => {
  const runAs = lanes.find(lane => lane.slug === 'run-as');
  if (runAs === undefined) throw new Error('lane 5 is missing');
  const { text, exitCode } = render(laneLines(runAs, [pass('ticket filed', 'SBX-1'), pass('task recorded', 'task 1'), pass('plan posted', 'comment 1')]));
  expect(text).toBe(
    [
      'PASS  ticket filed  (SBX-1)',
      'PASS  task recorded  (task 1)',
      'PASS  plan posted  (comment 1)',
      `FAIL  record: every attempt ran as ${teamAccount}  (${missing})`,
      `FAIL  lane 5: the first attempt's Job started  (${missing})`,
      `FAIL  lane 5 run-as: 3 of 5 deciding checks passed  (record: every attempt ran as ${teamAccount}; lane 5: the first attempt's Job started)`,
      '3 of 6 checks passed',
      '',
    ].join('\n'),
  );
  expect(exitCode).toBe(1);
});

test('lane 2 fails and names its fault check when the driver stopped too late to report it', () => {
  const restart = lanes.find(lane => lane.slug === 'engine-restart');
  if (restart === undefined) throw new Error('lane 2 is missing');
  const { text, exitCode } = render(laneLines(restart, [pass('engine restarted', 'killed'), pass('clean', 'nothing left'), pass('pull requests 1', 'one'), pass('duplicate comments 0', 'none')]));
  expect(text).toBe(
    [
      'PASS  engine restarted  (killed)',
      'PASS  clean  (nothing left)',
      'PASS  pull requests 1  (one)',
      'PASS  duplicate comments 0  (none)',
      `FAIL  attempt continued  (${missing})`,
      'FAIL  lane 2 engine-restart: 4 of 5 deciding checks passed  (attempt continued)',
      '4 of 5 checks passed',
      '',
    ].join('\n'),
  );
  expect(exitCode).toBe(1);
});

test('lane 3 fails and names a counted check that never came', () => {
  const lost = lanes.find(lane => lane.slug === 'lost-job');
  if (lost === undefined) throw new Error('lane 3 is missing');
  const { text, exitCode } = render(laneLines(lost, [pass('pod deleted mid-step', 'pod 1'), pass('lost attempt replaced', 'attempt 3'), pass('clean', 'nothing left')]));
  expect(text).toBe(
    [
      'PASS  pod deleted mid-step  (pod 1)',
      'PASS  lost attempt replaced  (attempt 3)',
      'PASS  clean  (nothing left)',
      "FAIL  pull requests  (no check of this kind is in the run's output, and this lane expects one)",
      'FAIL  lane 3 lost-job: 3 of 4 deciding checks passed  (pull requests)',
      '3 of 4 checks passed',
      '',
    ].join('\n'),
  );
  expect(exitCode).toBe(1);
});

test('a scenario that prints only info lines fails for producing no check', async () => {
  const quiet = { name: 'quiet', summary: 'prints a note', run: () => Promise.resolve([info('setup ready', 'passed', 'kind')]) };
  const { text, exitCode } = render(await runScenario(quiet, []));
  expect(text).toBe(['INFO  setup ready  (passed: kind)', 'FAIL  quiet produces at least one check  (it produced none)', '0 of 1 checks passed, and 1 info lines decide nothing', ''].join('\n'));
  expect(exitCode).toBe(1);
});

test("the run prints Verify's reply with its behavior, and names the shape of a reply that is not a review", () => {
  const verified = { outcome: 'done', summary: 'Reproduced and fixed.', blocks: [{ kind: 'text', title: null, body: 'Ran both.' }], behavior: 'fixed' };
  expect(describeReply(verified)).toBe('review done, behavior "fixed": Reproduced and fixed.');
  expect(describeReply({ outcome: 'done', summary: 'Planned.', blocks: [] })).toBe('review done: Planned.');
  expect(describeReply({ note: 'no review' })).toBe('reply did not parse as a review, its shape is object with note');
});
