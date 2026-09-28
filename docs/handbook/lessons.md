# What the live runs taught

From 24 to 27 September 2026, AutoWorker took real tickets from Jira to merged pull requests. It ran first against the sandbox library on `e2e/run-*` branches, and then against a browser game built from 42 tickets in six waves, in the public repository `braxtonkin/awos-game`. Each wave filed its tickets at once, so several agents changed the same files at the same time and conflicted with each other on purpose.

This page explains the failures those runs found, why each one happened, and the rule it left in the code. Read it before you change how reworks, Verify, Land, or the attempt Job behave. Each rule below exists because the simpler version failed on a real ticket, and the lanes that replay each failure are listed so you can prove a change keeps the fix.

## Count the failures before you fix one

The most useful habit from these runs is a small one. When two fixes that share an assumption fail the same way, write the assumption down, and count the failures by cause before writing a third fix.

Early runs had reworks that made no change. Implement came back after a send-back, pushed nothing, and ended with "The agent made no change." Two narrow fixes each helped one case and missed the rest. A count of every such attempt across three runs found 22, and every one followed a send-back:

| What sent the task back | Reworks that made no change |
| --- | --- |
| Land, a conflict with the base branch | 15 |
| Verify, behavior still wrong | 4 |
| Land, a failed check | 3 |
| Nothing, a first Implement | 0 |

The count showed the assumption was wrong. The assumption was that a send-back plus the ticket tells a rework enough to act. It did not, for any cause. So the fix had to be general, one change that gives every rework the reason it came back, instead of a patch per cause.

A no-change attempt is not always wrong, though. A rework that correctly finds nothing to change should stop and ask a person. The better measure is a blind repeat, which is an attempt that made no change right after another one on the same task, with no person acting in between. After the fix, the rest of the game run had 84 reworks and no blind repeats. The same query run over the attempts before the fix finds two, so it can detect them.

## A rework must know why it came back

**What happened.** SBX-60's pull request failed a smoke test in CI because the page asked for a missing `favicon.ico`. The rework's prompt said only that Land sent the task back. The agent ran the repository's own checks, saw them pass, and pushed nothing, three times.

**What changed.** Each send-back now becomes one typed `ReworkObligation`, defined in `shared/rework.ts`. `begin` in `features/tasks/begin.ts` builds it at claim time from the attempt that sent the task back:

- A failed check carries each check's name and the tail of its log.
- A conflict carries the base head to merge.
- Behavior still wrong carries Verify's evidence.
- A review carries the review.
- Each obligation also carries any person's notes.

`claim` accepts only what `begin` built, and stores the obligation on the attempt. A rework that owes a change and pushes nothing ends the step at once, and the task waits for a person with the agent's own words. `Tasks.tla` states this as `UnmetReworkEndsTheStep` and `UnmetReworkWaitsForAPerson`.

**Where the proof lives.** Lanes 11 to 14 of `npm run verify -- p7-lane` replay SBX-60, a Verify failure, SBX-57's ticket conflict, and a rework that pushes nothing. They run in the local world with the Codex stand-in.

## Conflicts are not failed checks

**What happened.** In waves of seven to nine tickets that all edited `src/page.ts`, each merge moved main under the others. SBX-66 was sent back three times for conflicts. Each rework resolved its conflict, but Land counted every conflict against the cap of three failed-check rounds. The task parked with "checks on the pull request failed three times", which was false.

**What changed.** Land ends a conflict with its own verdict, `conflict`. The Code change workflow gives that verdict its own route, counter `conflicts`, and a cap of 10, with a park reason that names conflicts. A failed check still parks after three rounds. `Tasks.tla` adds `ConflictSparesCheckRounds`.

**Where the proof lives.** Lanes 16 to 18 replay three conflicts, checks that stay red, and a base branch that never stops moving.

## Verify's evidence must come from a clean run

**What happened.** SBX-73's Verify agent wrote a reproduction script and ran it once itself. The script wrote its output to a fixed path, `/tmp/sbx-73-sim.out`. The Job then ran the same script as the separate `reproduce` user. On the change, the test passed, but the write to that path failed with "Permission denied", because `/tmp` is shared and sticky and the agent's earlier run owned the file. The engine recorded the behavior as still wrong. The rework saw that the failure was only the redirect. It ran its own check with the output inside the workspace, and the Job committed that file as the rework's change.

**What changed.** Before each side of a reproduction, `clearSharedTemp` in `features/jobs/reproduce.ts` removes every entry the agent or the other side left in `/tmp`, `/var/tmp`, and `/dev/shm`. A script now gets the same result for the runner as it did for the agent. It also can no longer pass on the base by reading a file the agent left behind.

**Where the proof lives.** The `reproduce` lane of `npm run verify -- jobs-live` plants all three leaks: an agent file that blocks a write, an agent file that fakes a pass, and a base-side file the change side would read. The `stand-in-solutions` scenario keeps its own copy of the reproduction in `features/e2e/stand-in-check.ts`, and that copy does not clear shared temp yet. The stand-in lanes run in the attempt image, so they use the real one.

## A rework must see the tree that failed

**What happened.** SBX-93's tests passed on its branch, everywhere anyone looked, and failed in CI. GitHub runs a pull request's checks on the pull request merged into the current base branch. While SBX-93 waited, main gained new machines, perks, and achievements from sibling tickets, and those changed the numbers its tests compared. The rework started from the branch head, found every check passing, pushed nothing, and correctly asked a person. It could not fetch main itself, because only the bridge user holds the token.

**What changed.** A check obligation now records the base branch's head, read at claim time. `baseToMerge` in `features/tasks/worker.ts` hands it to the Job, which starts merging it before the turn, on the same path a conflict rework uses. So a check rework starts from the tree CI tested.

**Where the proof lives.** Lane 19 replays SBX-93. For that, the fake GitHub in `features/e2e/fake-github.ts` now runs CI on the pull request merged into its base, as GitHub does. Before that change, no local lane could show this failure at all.

## A rework must get the whole evidence

**What happened.** The same ticket's Verify script was 4,736 characters long. The evidence text cut every part at 4,000 characters, which dropped the lines that set up the state and the timing. The rework could not run Verify's check and asked what to do.

**What changed.** `evidenceText` in `shared/reproduction.ts` shows the whole script, with tokens redacted. Each run's output is still trimmed. The schema already bounds a script's length.

## The agent must be able to run the failing check

**What happened.** The game's smoke test launches Chrome through `playwright-core` with `channel: "chrome"`. GitHub's runner has Chrome, and the attempt image does not. SBX-79's check reworks received the failing log, could not run the test, and guessed at a CSS fix twice.

**What changed.** No code changed. The fix was configuration, the way a company adopting AutoWorker would do it. A repository Job image extends the attempt image, adds Google Chrome pinned by version and checksum, and is saved as the repository's Job image on the Repositories page. The next rework ran the smoke test itself, fixed the layout, and merged. The lesson for anyone adding a check to a repository is that a rework can only fix a check it can run. If CI needs a tool, the repository's Job image needs it too. [operations.md](operations.md#give-a-repository-its-own-job-image) shows how to build one.

## A person corrects Verify through the ticket

**What happened.** SBX-93 asked for a speedup measured against the old per-unit code. Verify's scripts timed the wrong reference three times: first the new exported function, then a simpler loop, and then a copy taken from the changed file instead of main. Each time the change looked slower than it was.

**What stayed.** A person's note reaches only the next attempt after it. When a rework finds Verify wrong, the task waits at Implement, so a note given with Retry there reaches Implement and never the Verify that follows. A person corrects Verify by editing the ticket's text, which the worker reads from Jira on every attempt. The owner decided on 27 September 2026 to leave this with a person. There is no route for a rework to contest Verify's evidence, and no action that reruns Verify alone. See "Only a person contests Verify's evidence" in [docs/decisions.md](../decisions.md).

## Scratch files are the repository's job

**What happened.** SBX-73's rework wrote its own simulator output to `.sbx-73-sim.out` inside the repository. The Job commits everything in the workspace, so the file merged into main, and a cleanup ticket removed it.

**What stayed.** The owner decided that each repository ignores its own scratch files in its `.gitignore`. The Job keeps committing what the workspace holds. See "Each repository ignores its own scratch files" in [docs/decisions.md](../decisions.md).

## Earlier fixes from the same runs

- **A script that cannot run is an environment failure.** A reproduction whose base run exits 126 or 127, or fails on a missing command or a syntax error, now counts as `environment_fail`, so Verify reruns instead of blaming Implement.
- **Setup runs before the turn.** A repository's setup command, such as `npm ci`, runs before Implement's and Verify's turns. Before that, an agent sometimes started in a checkout with no dependencies.
- **The task page holds one state.** SBX-60's page once showed Implement failed while the agent panel said it succeeded. The task page now derives everything from one live state.

## What a plan for AutoWorker must get right

The game's plan had one mistake that cost a ticket many attempts. W4-07 needed a save fixture that W4-02, in the same wave, creates. Tickets in one wave run at the same time, so the fixture did not exist yet, and the agent rightly asked. When you plan work for AutoWorker, make every dependency point to an earlier wave, and give each ticket everything its own tests compare against.

A ticket that asks Verify to time code is hard to check faithfully. SBX-93's second version asked Verify to check results only, and put the speed claim in a committed benchmark. That version passed.

## The numbers from the full game run

| Wave | Tickets | Attempts | Conflicts | Failed checks | Input tokens |
| --- | --- | --- | --- | --- | --- |
| 0 | 6 | 65 | 6 | 1 | 5.75M |
| 1 | 9 | 93 | 11 | 1 | 7.35M |
| 2 | 7 | 64 | 5 | 1 | 6.18M |
| 3 | 8 | 76 | 5 | 4 | 11.66M |
| 4 | 7 | 69 | 2 | 2 | 9.55M |
| 5 | 5 | 36 | 2 | 0 | 6.04M |
| All | 42 | 403 | 31 | 9 | 46.5M |

Input tokens include cached input. A wave took 15 to 41 minutes. One hard ticket, SBX-93, took 27 attempts and 5.0M tokens across three product fixes. Every wave ended with a gate on main: simulator milestones inside the plan's ranges, the previous gate's save loading, typecheck, tests, the build, and a smoke test against the live site.

## What the runs did not test

The live runs used one repository shape and one kind of work. These parts of AutoWorker have run only against fakes or not at all:

- Pull request reviews and the merge queue. The fake GitHub has neither, and the game repository requires no review.
- Chat. When AutoWorker posts to chat is the one open question in `docs/decisions.md`.
- A second person, a team account doing real work, and a routine that runs as a fixed identity against real services.
- A deployment. Every run used a local kind cluster, with the engine and dashboard in containers on one machine.
