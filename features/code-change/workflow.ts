import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { actionKinds } from '../../shared/actions.ts';
import { review, reviewWith } from '../../shared/review.ts';
import { step, type Workflow } from '../../shared/workflow.ts';

const corePrompt = (name: string): string => readFileSync(new URL(`prompts/${name}.md`, import.meta.url), 'utf8');

const may = <K extends string>({ kind }: { readonly kind: K }): { readonly kind: K; readonly irreversible: false } => ({ kind, irreversible: false });

const said = reviewWith('text', 'choice');

const verified = said.extend({ behavior: z.enum(['fixed', 'still_wrong']).nullable() });

export const workflow = {
  name: 'code-change',
  steps: [
    step({
      name: 'specify',
      reads: [],
      runBy: 'agent',
      prompt: corePrompt('specify'),
      startsEnvironment: false,
      needsRepository: true,
      canEnd: false,
      owes: [may(actionKinds.ticketComment), may(actionKinds.ticketTransition), may(actionKinds.branchDelete)],
      output: said,
      requires: ['text'],
      failures: { fail: { kind: 'fail' }, needs_input: { kind: 'ask' } },
      blocked: 'fail',
      done: () => 'pass',
    }),
    step({
      name: 'implement',
      reads: ['specify'],
      runBy: 'agent',
      prompt: corePrompt('implement'),
      startsEnvironment: false,
      needsRepository: true,
      canEnd: true,
      owes: [may(actionKinds.branchAdvance), may(actionKinds.prOpenDraft), may(actionKinds.ticketComment), may(actionKinds.branchDelete)],
      output: said,
      requires: ['text'],
      failures: { fail: { kind: 'fail' }, needs_input: { kind: 'ask' } },
      blocked: 'fail',
      done: () => 'pass',
    }),
    step({
      name: 'verify',
      reads: ['specify', 'implement'],
      runBy: 'agent',
      prompt: corePrompt('verify'),
      startsEnvironment: true,
      needsRepository: true,
      canEnd: false,
      owes: [may(actionKinds.ticketComment), may(actionKinds.branchDelete)],
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
      runBy: 'engine',
      needsRepository: true,
      canEnd: true,
      owes: [{ kind: actionKinds.prMerge.kind, irreversible: true }],
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
