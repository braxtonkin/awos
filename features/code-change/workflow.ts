import { z } from 'zod';
import { review } from '../../shared/review.ts';
import { step, type Workflow } from '../../shared/workflow.ts';

const verified = review.extend({ behavior: z.enum(['fixed', 'still_wrong']).nullable() });

export const workflow = {
  name: 'code-change',
  steps: [
    step({
      name: 'specify',
      reads: [],
      prompt: 'Read the ticket and the repository, and write a plan for the change: what changes where, and how Verify will show that it works. Put the plan in a text block.',
      needsRepository: true,
      canEnd: false,
      owes: [],
      output: review,
      requires: ['text'],
      failures: { fail: { kind: 'fail' }, needs_input: { kind: 'ask' } },
      blocked: 'fail',
      done: () => 'pass',
    }),
    step({
      name: 'implement',
      reads: ['specify'],
      prompt: "Make the change the plan describes, with the repository's own checks passing, and push it to a draft pull request. Summarize what changed in a text block.",
      needsRepository: true,
      canEnd: true,
      owes: [],
      output: review,
      requires: ['text'],
      failures: { fail: { kind: 'fail' }, needs_input: { kind: 'ask' } },
      blocked: 'fail',
      done: () => 'pass',
    }),
    step({
      name: 'verify',
      reads: ['specify', 'implement'],
      prompt:
        'Write one reproduction of the ticket, and run it on the starting commit, where it must show the problem, and on the change, where it must pass. Report both runs in a text block. Set behavior to fixed when the change passes, to still_wrong when the change still shows the problem, and to null when the environment kept you from running both.',
      needsRepository: true,
      canEnd: false,
      owes: [],
      output: verified,
      requires: ['text'],
      failures: {
        needs_input: { kind: 'ask' },
        behavior_fail: {
          kind: 'return',
          to: 'implement',
          counter: 'rounds',
          cap: 3,
          parks: 'Verify found the behavior still wrong in 3 rounds. Read its evidence on this page, then press Retry with a note that says what to change, and AutoWorker runs Verify again.',
        },
        environment_fail: {
          kind: 'rerun',
          counter: 'reruns',
          cap: 3,
          parks: "Verify's environment failed 4 times in a row. Check that the repository's Verify environment starts, then press Retry to run Verify again.",
        },
      },
      blocked: 'environment_fail',
      done: ({ behavior }) => (behavior === 'fixed' ? 'pass' : behavior === 'still_wrong' ? 'behavior_fail' : 'environment_fail'),
    }),
    step({
      name: 'land',
      reads: ['implement', 'verify'],
      prompt: "Bring the pull request to a state GitHub reports mergeable under the repository's own rules. Summarize its checks and reviews in a text block.",
      needsRepository: true,
      canEnd: true,
      owes: [{ kind: 'merge', irreversible: true }],
      output: review,
      requires: ['text'],
      failures: {
        fail: { kind: 'fail' },
        needs_input: { kind: 'ask' },
        red_check: {
          kind: 'return',
          to: 'implement',
          counter: 'landRounds',
          cap: 3,
          parks: 'Checks on the pull request failed in 3 rounds. Read the failing checks on the pull request, then press Retry to run Land again.',
        },
        changes_requested: {
          kind: 'review',
          to: 'implement',
          counter: 'reviews',
          cap: 1,
          parks: 'A later review asked for changes after AutoWorker answered the first one. Answer it on the pull request, then press Retry to run Land again.',
          ignored: "A later review asked for changes, and this routine ignores later reviews. AutoWorker lands the pull request once GitHub reports it mergeable under the repository's rules.",
        },
        review_required: { kind: 'await', waits: "The pull request needs an approval under the repository's rules. AutoWorker goes on once GitHub reports one." },
      },
      blocked: 'fail',
      done: () => 'pass',
    }),
  ],
} as const satisfies Workflow;
