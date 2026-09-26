import { fail, type Check, type Scenario } from '../../tools/verify/check.ts';

const parked: Readonly<Record<string, string>> = {
  'last-step': 'Lane 3 sets the routine last step to Implement with one repository skill, and checks for a done task with an open draft pull request, no Verify or Land attempt, and the skill line in the Implement prompt.',
  continue: 'Lane 4 deletes the Implement pod after its push, and checks that the next attempt starts at the lost push with its summary in the prompt, and that the run reaches merged.',
  'late-push': "Lane 5 pushes onto the lost attempt's branch after the next attempt starts, and checks that the task branch and the new attempt are unchanged.",
  evidence: "Lane 6 reads lane 1's Verify evidence, its stored runs, and its ticket comment, and records whether the agent could report its own command ids.",
  round: 'Lane 7 reverts the feature on the task branch after Implement passes, and checks for a behavior failure, the evidence in the next Implement prompt, and a later passing round.',
  record: "Lane 9 reads lane 1's attempts, outbox rows, and autoworker/ branches, and checks the run-as identity, branches, pushes, owed actions, and that no autoworker/ branch is left.",
};

const run = (lanes: readonly string[]): Promise<readonly Check[]> =>
  Promise.resolve(
    (lanes.length === 0 ? Object.keys(parked) : lanes).map(lane => {
      const procedure = parked[lane];
      return procedure === undefined
        ? fail(`p3-parked names a known lane: ${lane}`, `name any of ${Object.keys(parked).join(', ')}`)
        : fail(`${lane}: PARKED: gate 1`, `${procedure} Each needs a GitHub write, which the sandbox token cannot make until the owner regrants it.`);
    }),
  );

export const parkedScenario: Scenario = {
  name: 'p3-parked',
  summary: "names each of P3's GitHub-write lanes and reports it PARKED: gate 1 until the sandbox token can write",
  run,
};
