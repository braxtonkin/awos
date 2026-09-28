# Code change workflow reference

Code change is the one workflow the core ships. It is declared in [features/code-change/workflow.ts](../../../features/code-change/workflow.ts), its agent step plug is `agentSteps` in [features/code-change/stage-output.ts](../../../features/code-change/stage-output.ts), and Land lives in [features/code-change/land.ts](../../../features/code-change/land.ts) and [features/code-change/land-loop.ts](../../../features/code-change/land-loop.ts). This page lists its steps, verdicts, routes, rework obligations, Land's rules, and the settings it reads. [architecture.md](../architecture.md) explains how they work together.

## Steps

| Step | Run by | Environment | After the turn | Can end the task | Needs a repository |
| --- | --- | --- | --- | --- | --- |
| `specify` | agent | no | push | no | yes |
| `implement` | agent | no | push | yes | yes |
| `verify` | agent | yes, from the repository's Verify provider | reproduce | no | yes |
| `land` | engine | no | none | yes | yes |

Every step's review must hold at least one `text` block. A routine may end the task at `implement` or `land`, and may mark any step before the one it ends at as a gate.

## Verdicts and routes

| Step | Verdict | Route | Counter and cap | When the cap is reached, the task waits with |
| --- | --- | --- | --- | --- |
| `specify`, `implement` | `fail` | fail: run the step again | stage retries, global cap 2 | the third failure in a row parks |
| any agent step | `needs_input` | ask a person | input waits, global cap 3 | a fourth question in a row counts as a failure |
| `verify` | `behavior_fail` | return to `implement` | `rounds`, 3 | "Retry starts again at Implement, because Verify found the behavior still wrong three times. Read its evidence on this page, then press Retry with a note that says what to change, and Implement gets your note." |
| `verify` | `environment_fail` | rerun `verify` | `reruns`, 3 | "Verify's environment failed 4 times in a row. Check that the repository's Verify environment starts, then press Retry to run Verify again." |
| `land` | `red_check` | return to `implement` | `landRounds`, 3 | "Retry starts again at Implement, because checks on the pull request failed three times. Read the failing checks on the pull request, then press Retry with a note that says what to change, and Implement gets your note." |
| `land` | `conflict` | return to `implement` | `conflicts`, 10 | "Retry starts again at Implement, because the pull request conflicted with its base branch ten times, as other merges kept changing the files it changes. Press Retry once those merges slow down, and Implement merges the base branch again." |
| `land` | `changes_requested` | review: back to `implement` once | `reviews`, 1 | "A later review asked for changes after AutoWorker answered the first one. Answer it on the pull request, then press Retry to run Land again." A routine that ignores later reviews waits for GitHub to report the pull request mergeable instead |
| `land` | `review_required` | await an outside approval | none | "The pull request needs an approval under the repository's rules. AutoWorker goes on once GitHub reports one." |
| `land` | `fail` | fail: run Land again | stage retries, global cap 2 | the third failure in a row parks |

An unreadable review, or one missing a required block, is `blocked`. For `specify`, `implement`, and `land`, `blocked` counts as `fail`. For `verify`, it counts as `environment_fail`.

Verify's review adds a `behavior` field, and the Job's reproduction overwrites it with what it measured. `fixed` gives `pass`, `still_wrong` gives `behavior_fail`, and no behavior gives `environment_fail`. A `pass` clears the step's own counters.

The engine also records verdicts no step declares. `lost` means the lease lapsed, `stopped` means a person stopped or retried the task, `handed_off` means Land owed an action and a later pass reads the result, and `not_launched` means the attempt could not start, for example because a login was not valid.

Global caps are in `caps` in [features/tasks/claim.ts](../../../features/tasks/claim.ts): 3 lost attempts in a row, 2 stage retries, and 3 input waits.

## Rework obligations

At each claim of an agent step, `begin` builds at most one obligation, from the newest attempt that sent the task back to that step since the step last passed, and the claim stores it on the new attempt. A `note` obligation can reach Specify and Verify too, and the other kinds reach Implement. The type is `ReworkObligation` in [shared/rework.ts](../../../shared/rework.ts), and every kind also carries any person's notes.

| Kind | Built from | Carries | Demands a change |
| --- | --- | --- | --- |
| `conflict` | Land's `conflict` | The base branch and its head, read at claim time | no. The merge itself is the change |
| `check` | Land's `red_check` | The pull request head CI failed on, the base branch and its current head, and each failed check with its log tail, or its description and link, or why it could not be read | yes |
| `behavior` | Verify's `behavior_fail` | Verify's whole evidence: the script and both runs | yes |
| `review` | Land's `changes_requested` | The review and its comments | yes |
| `note` | A person's Retry or Send back with a note, when nothing else sent the task back | The notes | no |

For a `conflict` or `check` obligation, the Job starts merging the base head before the turn, unless the start commit already holds it. Implement's input says the merge is in progress and must be finished first.

Implement settles its attempt in this order, in `settleImplement`:

1. A push the Job declined, for example a merge that still held conflict markers, fails.
2. A push, an inherited push from a lost attempt, or a question goes to the judge.
3. No push with no obligation, or with a `conflict` or `note` obligation, fails with "The agent made no change.", and the stage retry cap applies.
4. No push with a `check`, `behavior`, or `review` obligation fails and parks at once, naming what was owed and quoting the agent's last message.

## Land's rules

Land reads the pull request's merge state and walks this table in order. The first rule that matches decides.

| Rule | When | Decision |
| --- | --- | --- |
| queued | the pull request is in the merge queue | wait |
| merged | the pull request is merged | pass. The task is done |
| ejected | the merge queue ejected it, and Land has not answered that yet | fail, and record the answer |
| conflicting | it conflicts with its base | send back with `conflict` |
| ready at once | the repository's drafts leave at once, and Land has not marked it ready | owe `pr.mark-ready` |
| still a draft | it is still a draft after Land marked it ready | fail |
| red at once | the repository's drafts leave at once, and a check is red | fail |
| red | a check on the head that `ignorable_checks` does not name is red | send back with `red_check`, the head, and the failing checks |
| ready when green | it is a draft and its checks are green | owe `pr.mark-ready`, with the evidence |
| checks pending | checks are still running | wait |
| still behind | it is behind its base, and Land already asked GitHub to update it at this head | fail |
| behind | it is behind its base | owe `pr.update-branch` at the head |
| changes requested | a review requested changes, and Land has not answered it | end with `changes_requested` |
| needs approval | it needs an approval under the repository's rules | end with `review_required` |
| refused | a merge at this head was refused, and Land has not answered that | fail |
| gate | a gate before Land is not approved | pass, which the engine refuses. The task parks on `retry`, and its reason says to stop the task and report the fault, because only a fault lets a task reach Land past an unapproved gate |
| ready | it is mergeable | owe `pr.merge` at the head Land read |
| otherwise | none of the above | wait |

An owed action ends Land's attempt `handed_off` in the same transaction that owes it. The `pr.merge` performer merges only while the task is still at `land`, and reads the pull request again before it merges.

Each repository's ignore lists apply when the GitHub reader builds the merge state. `ignorable_checks` names checks whose failure does not hold the pull request back, and `ignored_reviewers` names reviewers whose requested changes never send the task back.

When a pull request needs a review, Land asks the review step plug-in, a `ReviewStep` passed in from `services/engine/main.ts`, what to owe and what the waiting task shows. A review step may owe only the kinds in `ReviewKind`, which are `ticket.comment` and `ticket.transition`. The core's `coreReview` owes nothing and names the pull request.

## Actions each step owes

| Step | Verdict | Owes |
| --- | --- | --- |
| `specify` | `pass` | A `ticket.comment` with the plan. On the task's first pass, a `ticket.transition` to the routine's start status. `branch.delete` for the attempt branch |
| `implement` | `pass` | `branch.advance` of the task branch `autoworker/<key>` to the attempt's push. `pr.open-draft` when no pull request exists. A `ticket.comment` that names the pushed head. `branch.delete` for the attempt branch |
| `verify` | any verdict with evidence | A `ticket.comment` with the evidence |
| `verify` | `pass` with an open pull request | `pr.evidence`, which puts the evidence in the pull request's body. `branch.delete` for the attempt branch |
| `land` | merged | A `ticket.comment`, a `ticket.transition` to the routine's end status, and `branch.delete` for the task branch |
| the step the routine ends at | `pass` | A `ticket.transition` to the routine's end status, when the routine names one, for example when a routine ends at `implement` |

## Branches

| Branch | Holds |
| --- | --- |
| `autoworker/<key>-attempt-<n>` | One attempt's push. Each attempt pushes only its own branch |
| `autoworker/<key>` | The task branch. `branch.advance` moves it to each passing Implement's push, and the pull request comes from it |

## Repository settings

Each repository row carries settings that Code change reads. Setup and the Repositories page write them, and each change is recorded as a `human_action`.

| Setting | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `job_image` | none, so the engine's `JOB_IMAGE` | the worker | A public image by digest that extends the attempt image, for tools the repository's checks need |
| `setup_command` | none | the Job, before Implement's and Verify's turns | For example `npm ci`. It runs as `codex`, with a 600 s limit |
| `fast_test_command` | none | every agent step's prompt, and the `tests-only` Verify provider | The command the agent runs to test. `tests-only` points Verify at it, or at the repository's CI checks when it is empty |
| `verify_provider` | `tests-only` | the environments feature | Which provider makes Verify's environment |
| `ignorable_checks` | none | the GitHub reader | Checks whose failure does not hold a pull request back |
| `draft_leaves` | `when-green` | Land | `when-green` marks the draft ready once checks pass. `at-once` marks it ready at once |
| `ignored_reviewers` | none | the GitHub reader | Reviewers whose requested changes never send the task back |

## Prompts

Each agent step's core prompt is a file in `features/code-change/prompts/`: `specify.md`, `implement.md`, and `verify.md`. A prompt grows only from failures seen in runs (rule E2). The worker builds the full prompt in `features/tasks/step-runner.ts`, in this order:

1. The core prompt.
2. The routine's instructions for the step.
3. Each person's note.
4. The last review and its answers, after a question.
5. The goal.
6. The fast test and setup commands.
7. The environment.
8. The plug's input for the step, which for a rework includes what sent it back.
9. The skills.
10. A summary of what a lost attempt finished.

Some prompt wording is read by code. The Codex stand-in finds the reproduction script's path by the phrase "reproduction script at" in `verify.md`, and finds the answers heading in the prompt. Change those only together with `features/e2e/codex-stand-in.ts`.
