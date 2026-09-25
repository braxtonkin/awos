# Decisions

This file holds the settled design decisions for AutoWorker and the questions still open. Each entry says what was decided, why, and which options lost, so the same argument does not need to happen twice. The behavior these decisions serve is in [spec.md](spec.md).

## Settled

### AutoWorker is a generic core that a company forks

Decided 23 Sep 2026. This repository holds a generic AutoWorker. A company forks it and adds its own behavior, such as how Verify gets a live environment or how its pull requests get approved. The core keeps that behavior behind small plug-in points, so a fork adds its own implementation instead of editing the core, and it can keep taking upstream changes. Company names, policies, and infrastructure stay out of this repository. Anything that can differ from one repository to the next is a per-repository setting with a sensible default rather than a hard-coded rule. Examples are when a draft leaves draft, which reviews to ignore, the Job image and test command, and the Verify environment provider. Needs that settings can't express plug in.

Rejected option:

- **Build for one company's setup.** Every other user would have to undo it, and the owner's own fork would drift further from upstream with each change.

### Workers claim a task by inserting an attempt row

Decided 23 Sep 2026. Every try at a stage is a row in the `attempt` table. A partial unique index on `task_id`, limited to rows where `finished_at` is null, allows one unfinished attempt per task. Postgres refuses a second claim, so no code has to check first. A reaper marks attempts whose lease has expired as `lost`. That frees the task and keeps a record the dashboard can show. A late write from a lost attempt matches no rows. A lost or stopped attempt stops counting against the engine's capacity at once, and housekeeping deletes its Job. Three lost attempts in a row make the task wait for a person, so a task whose every attempt dies does not restart forever. An attempt that finishes resets that count.

The evidence comes from a throwaway prototype on Postgres 18 with a 2 s lease:

- 20 workers raced for one task, and exactly 1 won.
- A hung worker's task was claimed again after 2.09 s, and the hung worker's late write was rejected.
- A chaos run of 13 tasks, with workers dying mid-stage, finished every task. No task ever had two unfinished attempts, and all 5 late writes from dead workers were rejected.

Rejected options:

- **Lease columns on the task row.** It measured as safe as the attempt row, but the claim and the attempt history end up in two records that must agree.
- **A session advisory lock.** A hung worker held its task forever, and its late write was accepted. Both break the spec.
- **A cap of 2 or 5 lost attempts.** Two parks a task after one crash and one node restart. Five lets a task that always crashes run five times. Three matches the other caps.

### Outbox rows are claimed with a lease

Decided 23 Sep 2026. An engine copy claims an outbox row before it performs the row's action. The claim is one statement that Postgres refuses while another claim's lease on the row is live, and an expired lease frees the row. These rules go with the claim:

- The rows that a state change owes commit in the same transaction as that change.
- A row can be claimed only when every earlier row of its task is done, so a row that failed for good holds the rows behind it until a person acts. A task's next stage cannot be claimed while any of its rows is owed.
- When the target cannot catch a duplicate, as with a Jira comment, the performer first looks on the target for the row's marker. If the marker is there, it marks the row done without calling.
- The performer checks its lease right before the call that performs the action. The call's deadline is the lease's end less a margin, so the call cannot outlast the lease.
- A row is marked done only after its action took effect.
- A call that fails only records its error on the row. The claim stays until its lease runs out, and a lease that runs out without a done mark counts as a failed try, whether the call failed, the performer crashed, or it stalled. At the cap, the row fails and its task waits for a person in the same transaction, with the row's last error as the note. A lapse can also come after the action took effect, so a row can fail although its action landed.
- A person's Retry on a waiting task owes its failed rows again with their tries reset. The first try then finds the marker, or the duplicate, of an action that did land, and marks the row done.

The TLA+ model in `features/outbox/` settled this. It runs two engine copies over two tasks with two rows each. One target catches a duplicate by key, as GitHub refuses a second pull request from one branch, and the other cannot. A failed call's request may land later or never. A performer can crash between any two of its steps, twice in all, and can stall once, after its marker check. A person can press Retry once. Each night the model also runs with three rows per task, three crashes, and two stalls. The crash budgets only keep the model small. Every lapsed claim costs a try, so the model also holds with crashes unbounded. With every rule in place, TLC finds no action that takes effect twice, no row done before its effect, no effect of a state change that rolled back, no row performed out of order, no next stage claimed before every row of its task is done, no row with two live claims, and no owed row that is never done or handed to a person. The model removes each rule in turn, and each removal breaks one of these. Three of the removals settle the question:

- Without the claim, two copies both look for the marker, find none, and both post the same comment.
- Without the marker check, a copy that crashes after posting and before marking the row done leaves the row owed, and the next copy posts it again.
- Without the lease check right before the call, a copy that stalls after its marker check wakes and posts after another copy already did.

The model rests on two assumptions that the outbox's code and its connectors must make true:

- A request reaches its target, or is lost, before the lease it was sent under ends by the database's clock. The model names this `TargetSettlesWithinMargin`, and its mutant posts a comment twice when a failed call's request lands after the lease. The call's deadline is the lease's end less the margin, and `performer()` stops waiting for a call or a lookup at that deadline even when the connector ignores its signal. So the margin (`OUTBOX_MARGIN_MS`) must exceed the longest time any target can take to settle a request after its sender gave up on it. A pause between the lease check and the send, or a retry inside the client, breaks this.
- Every lease is written and judged by the database's clock. The outbox reads the time from Postgres, never from the engine's host, so clock skew between engine copies cannot free a live claim. The model names this `LeasesOnOneClock`, and the simulator's `skewed` profile runs one engine 6 s ahead to prove it: with each engine's own clock, the fast engine expires a live claim and the same comment is posted twice.
- Each action kind's target either catches a duplicate or lets the performer look for the marker. Catching a duplicate means that a repeat is refused or changes nothing, whatever happened since, and the performer reads the refusal as its own earlier success and fetches the result. An action that sets state, such as moving a ticket or a branch, qualifies only when it names the state it expects to replace. A marker qualifies only when the action's own request writes it, nothing removes it, it cannot be guessed, it counts only when the row's own identity wrote it, and the lookup reads every page and every earlier write. A lookup that fails counts as a failed call. A kind whose target meets neither condition, such as a message that cannot be looked up afterwards, cannot be performed at most once across a crash, so it needs its own rule before it is added.

Rejected options:

- **No claim, as the data model draft had it.** Two engine copies post the same comment twice, because a Jira comment or a chat post does not catch a duplicate.
- **A claim without the marker check.** A crash between the post and the done mark makes the next performer post again.
- **Release a row as soon as its call fails, and retry after a backoff.** A request still in flight can land after the retry posted, so the comment appears twice. Counting only failed calls also never caps a row whose every try crashes its performer.

### An outbox row can end refused, and the store holds a task that owes an action

Decided 24 Sep 2026 while building the outbox (P4), for the Land model, now in `features/code-change/` (M4). It amends the rule above that a row is marked done only after its action took effect.

- A performer can end a row as refused when the target declines the action for a reason a retry cannot change, such as a merge refused because the head moved. The row records the refusal and the head it named as its result, so Land reads why. A refused row settles without an effect, and the rows its task owed after it are dropped in the same statement, because they assumed its effect.
- A merge that finds the pull request already merged, already queued, or ejected in a way Land has not answered reports that as the row's result. It is never a reason to act again.
- The claim statement re-checks that the row's task still stands. A stopped task, or a kind's own predicate, drops its unclaimed rows in the statement that claims, together with the rows its task owed after them.
- A row that fails at the cap parks its task when the task is ready or waits on anything but a person's review, and a parked task waits on Retry. A task that waits on a review keeps it, as the next entry says. A done task cannot wait for a person, so the rows it owed after the failed row are dropped instead.
- Each task counts its unsettled rows, and its generated `ready` column is true only when that count is zero. The foreign key that ties a live attempt to a ready task then refuses a claim while the task owes an action, and the row lock on the task serializes that claim with the transaction that owes the rows. `owesAction` in `shared/actions.ts` reads the same count, for Land.
- A failed row is claimable again whenever its task is ready, and the claim resets its tries. A person's Retry makes the task ready, so the Retry owes the failed rows again in its own transaction.

Rejected options:

- **Refuse the claim and re-owe on Retry in the task feature's statements.** Each claim path and each Retry would need the same edit, and a fork's claim could miss it. The count on the task puts the rule in the store, where every claim meets it.

### A failed outbox row keeps a person's open review

Decided 25 Sep 2026 (FX3e). A step can pass, owe an action such as a ticket comment, and wait for a person to approve it in one transaction. When that action fails at the cap while the review is open, the task keeps waiting on the same review, and the review's note gains a sentence that names the failed action and its last error. Approve or Send back then makes the task ready, and a ready task owes its failed rows again, so the action is tried again with its tries reset. If it fails again, the task parks on Retry at its new step.

The earlier trigger parked the task on Retry over the review. The review was lost, Retry was the only way on, and Retry ran the step that had already passed. The outbox model now has a review state that only Approve ends, and its invariant `ReviewKeptUntilDecided` fails when the guard `FailureKeepsReview` is off. The simulator checks the same invariant after every step, and its `park-over-review` mutant restores the old trigger and breaks it. The outbox-sim check of a Jira comment that fails while specify waits for approval shows that the review and its note outlive the failure, that Retry changes nothing, and that Approve posts the comment once without running specify again.

Rejected options:

- **Keep the review, and record the retry need in a column beside it.** Approve already makes the task ready, and a ready task already owes its failed rows again, so the column would hold state that the store derives. Every decision path would also need to read and clear it.
- **Park only ready tasks.** A task that waits on something outside, such as an approval on GitHub, may wait for the very action that failed, so it still needs a person to press Retry.

### A lapsed lease cannot be renewed

Decided 24 Sep 2026. A renewal succeeds only while the attempt's lease has not yet lapsed, and one that comes later reports the attempt as lost. The reaper releases every lease that lapsed, so once a lease lapses the attempt stays releasable until the reaper takes it. A worker that keeps stalling therefore loses its task at its first lapse, and the reaper needs only to run on its schedule. The task model states this as weak fairness for the reaper, and its property `LapsedLeaseNeverRenews` fails when a guard lets a worker renew after a lapse. The simulation checks the same property after each step. The condition sits in the renew statement, because a store constraint would need the engine's clock, not the database's. When the engine starts, it gives every live attempt a fresh lease, lapsed or not, so attempts that could not renew while the engine or Postgres was away are not released at once. That grace runs once per start, so it cannot keep a lease alive forever, and the simulation's check skips the step where an engine starts. This closes AUTO-10.

The bridge follows the same rule since 25 Sep 2026. Until then its `admit` renewed a lease on every post, lapsed or not, and `Bridge.tla`'s `Commit` did the same, so the two models disagreed. The audit asked which was right. The task model is, for the reason above: a bridge that stalls and posts again just before each reaper pass would keep its attempt forever. So `admit` renews only a lease that has not lapsed, through the `renewedLease` rule, and a lapsed attempt stays releasable while its bridge may still post. `Bridge.tla`'s guard `LapsedLeaseStaysLapsed` states this for `Commit` and `OpenStream`, and its property `LapsedLeaseNeverRenews` fails without the guard. bridge-sim checks a property of the same name after each step, and its mutant `LapsedLeaseStaysLapsed` renews every lease.

Rejected options:

- **Strong fairness for the reaper.** The model assumed that a lease that lapses again and again is reaped at one of its lapses. Nothing in the code guaranteed it, because a renewal could land between two reaper passes every time.
- **A count of lapses on the attempt.** It adds a column and a cap to bound a case that refusing the late renewal removes.
- **A store constraint.** Postgres would compare the lease with its own clock, while the engine and the simulation run on the engine's clock.

### Each attempt runs in its own Kubernetes Job

Decided 23 Sep 2026. The engine starts one Kubernetes Job per attempt, in the engine's own namespace. The Job clones the repo and runs Codex. It gets only its owner's credentials for that run, and no database or Kubernetes API access. The engine watches the Job, saves what it did as evidence, and records the verdict. This matches how the current AutoWorker runs delivery attempts.

Rejected options:

- **A subprocess in the engine pod.** It starts fastest, but tasks would share one pod's disk and memory, and work in flight would die with the engine.
- **A warm pool of workspace pods.** It starts fast and stays isolated, but it needs pool sizing and a wipe step between tasks that must never miss.

### Agents run under the Codex app server

Decided 23 Sep 2026. Each attempt's Job runs `codex app-server`, pinned to one exact version of the Codex CLI. It is the only way to run Codex that streams every step as it happens and takes a new message in the middle of a turn. The command is labeled experimental and has dropped methods between versions, so the engine uses only the protocol's stable methods, and moving to a new version is its own change.

The evidence comes from a throwaway prototype that ran Codex CLI 0.156.0 in an Ubuntu container, with the model gpt-6-luna, against a small repo with failing tests:

- The first live event arrived 1.1 s after a turn started. One 27-second turn sent 261 events, covering every command and its output, each file change, summaries of the agent's reasoning, and its messages word by word.
- A message sent mid-turn was accepted in 23 ms and joined the same turn, and the agent followed it. The repo's tests went from 1 of 3 passing to 4 of 4, including the new test the message asked for.
- A stop request ended the turn 46 ms later.
- After the connection dropped, a new connection read back both turns and all 15 of their steps.

Rejected options:

- **`codex exec --json`.** Events flow one way, so nothing can reach the agent mid-turn. Messages and command output arrive only after each step ends, approval requests are refused, and stopping it means signaling the process.
- **The Codex TypeScript SDK.** It wraps `codex exec`, so it has the same limits.
- **`codex mcp-server`.** Codex 0.154.0 removed it.
- **Driving the interactive terminal UI.** Its screen text is not an interface.

### Agents run with full permissions

Decided 23 Sep 2026. Routines run with nobody watching, so an agent never stops to ask a person before it acts. The app server in each Job runs with the approval policy `never` and the sandbox mode `danger-full-access`. The Job is the safety boundary. It has its own workspace, only its owner's credentials, and no database or Kubernetes API access. A person who disagrees with what an agent is doing steers or stops it.

Rejected options:

- **Ask when the agent wants to** (`on-request`). An unattended task waits until someone answers.
- **Ask before most commands** (`untrusted`). In the prototype, the agent asked before a read-only `cat` and before `npm test`, so an unattended task would wait at almost every step.

### The agent view lives on each task's page

Decided 23 Sep 2026. The view of an agent is a panel on the page of a routine or task. It is not the dashboard's first view or a page of its own. Opening a task, whether it is running or done, shows its own page with that panel and how long the task took from start to merge. While the task runs, the panel streams each step and takes a message that changes the agent's course or stops it. Once the task is done, the same panel replays what the agent did, read-only, for as long as transcripts are kept. After 30 days the panel says the transcript has expired, and the task's attempts and evidence stay for their 180 days. The owner added the replay on finished tasks the same day. The owner also asked that a task's agent trace be very visible on its page, so a person can easily find where the agent failed.

Rejected option:

- **A standalone agent screen,** like the prototype lab. It shows the agent without the routine, stage, and evidence around its work.

### The backend is one engine program

Decided 23 Sep 2026. One engine program runs all four loops: intake, worker, reaper, and outbox. It runs as a single copy. It can run as several copies if load ever needs it, because Postgres refuses a second claim.

Rejected option:

- **One service per loop.** It would mean four services to deploy and configure, for separate scaling the team does not need.

### Housekeeping is part of the engine

Decided 23 Sep 2026. Expiring lost attempts, deleting leftover Jobs, and pruning history past the retention limits are engine loops, not routines. Correctness never depends on how a routine is set up, and the routine list stays about product work.

Rejected option:

- **Housekeeping as routines,** as in the current AutoWorker. A paused or misconfigured routine could leave stuck work behind.

### The dashboard has no sign-in for now

Decided 23 Sep 2026. A person picks who they are from a list of people, and anyone can act as anyone. Every action is still recorded under the person picked. This is a known gap. Anyone could stop another person's task, change another person's routine, or replace another person's GitHub access. Revisit before AutoWorker is used outside the team.

Rejected options:

- **Company sign-in.** It is the lasting answer, but it is not needed yet.
- **GitHub sign-in.** A GitHub email may not match the company email that identifies people across connectors.

### Routines are goals that anyone on the team edits in the dashboard

Decided 23 Sep 2026. A routine is a goal in plain words and a schedule. The goal states what to do and where to stop, so a routine has no settings for what it may touch or how far it may go. Definitions live in Postgres. Anyone on the team may add or change a routine with no approval step, because AutoWorker is an internal service. A person can pause a routine, change its schedule, or run it now. On 24 Sep the coordinator replaced the five-field cron schedule with an interval, `routine_version.every`, which defaults to 15 minutes, and calendar schedules wait for the Daily update workflow.

Rejected options:

- **Files in a git repo.** Only engineers could add routines, and a sync job would keep a second copy that can drift.
- **A dashboard form that opens a pull request.** Every author would need GitHub access, and it needs the same sync job.
- **A dashboard form with an approval step.** It adds a review step that an internal service does not need.

### Each attempt's Job has a time limit

Decided 23 Sep 2026. Each attempt's Job gets a generous deadline, hours above a normal run. A Job past its deadline is killed, and the reaper marks its attempt lost, so the cap on lost attempts still applies. Without a deadline, an agent in a loop, or one waiting on a command that never returns, keeps its lease alive and holds a worker until a person notices. The TLA+ model's assumption that every attempt ends rests on this deadline. Its length comes from measured run times. The owner first leaned toward no limit and chose the deadline after reading the cases where an attempt never ends.

Rejected option:

- **No time limit.** A long run that is still making progress is never cut off, but a stuck run keeps its worker until someone stops it.

### A stopped task can be resumed

Decided 23 Sep 2026. A person can stop any task that is running or waiting. The stop ends the running attempt at once, its worker slot frees, and housekeeping deletes its Job. A stopped task runs nothing until a person presses Retry, which resumes it at the stage where it stopped and keeps the earlier stages' work. A stopped task keeps its ticket, so no other routine takes that ticket while it is stopped.

Rejected option:

- **A final stop.** A misclick could never be undone, and because a task keeps its ticket, no routine could ever work that ticket again.

### An attempt follows the goal as it is when the attempt starts

Decided 23 Sep 2026. Each edit to a routine's goal saves a new version. When a worker claims an attempt, the engine reads the newest version and records its number on the attempt. An edit therefore reaches a task at its next attempt, whether that is a retry, its next stage, or a new task. A running attempt keeps the version it started with, and a person who wants a fix applied at once presses Retry.

Rejected option:

- **Follow the version that found the task.** A fix to the goal would not reach a task that is already stuck.

### A ticket gets one task across all routines

Decided 23 Sep 2026. A task's key, usually its ticket, is unique across all routines. The first routine to find a ticket owns it, and every other routine skips it, so two agents never work one ticket at once. A task keeps its ticket after it is done, so later routines skip that work too.

Rejected option:

- **A key unique per routine,** as the data model draft had it. Two routines on one ticket would count as two pieces of work, and two agents could work that ticket at once.

### A run acts as a fixed person or as the ticket's assignee

Decided 23 Sep 2026. A routine may name a fixed person to run as. Otherwise each attempt runs as the ticket's current Jira assignee, matched to a person by their Jira account when the attempt is claimed. Each attempt records the person it runs as. A claim with nobody to run as is refused, and the task waits for a person with a note that says to assign the ticket to someone with a connected login or to set the routine's person. The routine's own search in Jira runs as its fixed person, or else as the person who created it. A fixed choice may also be a team's shared account rather than a person. The core decides who a run acts as through one small plug-in, so a fork can add its own rules, such as one that follows a condition on the ticket.

Rejected options:

- **Always the routine's owner.** It is always defined, but one person's name and usage would sit on every ticket the routine touches, whoever the ticket belongs to.
- **Always the ticket's assignee.** A routine that should run as one set person, or on unassigned tickets, would have no way to say so.

### Agents reach the engine through a bridge in the Job

Decided 23 Sep 2026. A small bridge inside each Job runs the app server over its standard input and output and connects out to the engine. The bridge is the Job's main process in the attempt's own pod, so the bridge and the agent share one lifecycle. It numbers every event and resends any the engine has not stored, so an engine restart loses nothing. Steering messages and stops come back on a second stream that the bridge opens to the engine. The Job listens on no port. With the engine stopped for 8 seconds mid-task, the prototype bridge lost none of the run's 275 events.

Rejected option:

- **The engine connects to a WebSocket port in the Job.** In the same outage, 30 of the 31 events sent never arrived, because Codex does not replay events that a disconnected client missed. Every Job would also have to accept traffic from the cluster.

### A new attempt continues a lost one's work

Decided 23 Sep 2026. Each attempt works on its own branch, named for its task and attempt number, and the Job pushes the agent's work after each step the agent finishes. When an attempt is lost, the next one starts in a fresh pod from the lost attempt's branch, with a summary of the lost attempt's transcript, so at most one step is redone. A lost Job that wakes up can push only to its own branch, so it cannot overwrite the new attempt. When a stage passes, its attempt's branch becomes the task's branch, the one behind the draft pull request, and housekeeping deletes the other attempt branches.

Rejected options:

- **Redo the stage from its start.** It is simpler, but a lost Implement throws away all its work so far.
- **Reuse the lost attempt's pod and workspace.** The pod is usually gone, and a hung pod that wakes up would write the same files as the new attempt.

### Streamed text is kept only until its step finishes

Decided 23 Sep 2026. While a step runs, its streamed fragments are stored, so the live panel and a stopped command's partial output work. When the step finishes, the finished step holds the same text, and its fragments are deleted. On the lab's event log of 960 events, fragments were 76% of the rows, and every fragment stream joined back into its finished step exactly. The estimate is about 90 MB per 1,000 agent-minutes, kept for 30 days.

Rejected options:

- **Keep every event for 30 days.** It is more than twice the size, about 210 MB for the same work, and the extra rows add no text.
- **Keep only finished steps.** It is the same size, but a stopped command's partial output is lost.

### Each repository sets its own merge bar

Decided 23 Sep 2026. A change lands only when it passes the checks its own repository defines, such as lint rules, CI, and actions. The agent finds and follows those checks. AutoWorker applies no coverage threshold of its own.

### History is kept for 180 days and transcripts for 30

Decided 23 Sep 2026. Attempts and evidence are kept for 180 days. Agent transcripts are kept for 30 days, so by the end of a month the transcripts from its first days are already gone.

### The dashboard and the engine are separate services

Decided 23 Sep 2026. The UI and the backend deploy separately, as they do in the current AutoWorker.

### Verify runs in an environment faithful to production

Decided 23 Sep 2026, and refined the same day. Verify aims for an environment as faithful to production as a repository can give it, reproduces the bug or exercises the feature there, and saves evidence such as a video. Each repository names a Verify environment provider. A provider starts an environment for one attempt, gives the agent an address or a workspace, and tears the environment down when the engine says the attempt ended. The engine holds any credentials the provider needs, and Jobs still get no Kubernetes access. The core ships a tests-only provider, where the agent runs the repository's fast test command in its own Job. A company's fork adds providers that fit its own infrastructure and policy.

Rejected option:

- **A sandbox namespace per attempt, built into the core.** It hard-codes one cluster policy into every fork, a company's devops policy may not allow it, and it gives Verify Jobs Kubernetes access.

### Verify proves a change with one reproduction, run before and after

Decided 23 Sep 2026. Verify writes one small reproduction, such as a browser script for a user interface bug, or API calls and commands otherwise. It runs the reproduction on the ticket's starting commit, where it must show the bug, and on the change, where it must pass. Each run records video when there is a user interface, and logs and outputs always. The pull request and the task's page show both runs side by side, with the script attached so anyone can rerun it. For a feature, the first run shows the behavior missing, and the second shows the ticket's acceptance criteria met. When the script can run in the repository's CI, Implement also adds it as a regression test.

Rejected options:

- **Record the change working, after only.** It takes one run instead of two, but it can't prove the bug existed or that the script would have caught it.
- **A test in CI only, with no live run.** It repeats for free, but bugs that show only in a live environment slip past it.

Reopened and refined 25 Sep 2026. The rule stays: the script fails on the base commit, passes on the change, and the verdict comes from trusted records. What changed is who runs the script. The agent only writes it, at `/tmp/autoworker-reproduce.sh`. After the turn, the Job's own code checks out the base commit and the change, each fresh, runs the repository's setup command and then the script in each, and posts both exit codes to the engine as one `reproduced` event. The engine settles the behavior from that event alone. Fixed means the base run failed and the change run passed, still wrong means the change run failed, and anything else, such as a base run that passes, a failed checkout or setup, or a run out of time, means Verify could not check it. A Verify Job pushes nothing.

The script is the agent's code, so it runs as a third user, `reproduce`, not as `codex` and never as the bridge. It gets a scrubbed environment with its own home and temporary folder, a time limit per run, and a limit on kept output. It can read neither the bridge's environment nor its git folder, nor the Codex login in the `codex` home. The Job kills every `codex` and `reproduce` process before and between the runs, and each run gets a new folder that only `reproduce` can write, so nothing the agent left behind and nothing the first run did reaches the second.

The evidence came from the old mechanism failing and a prototype of the new one, both on the local world with Codex on gpt-6-luna:

- **Before, at 2445052.** The engine matched the agent's own shell commands word for word. 2 of 4 entries reached clean. On clamp, Verify ran the change in its workspace, where the dependencies weren't installed, and the run exited 127. On slugify, Verify ended `environment_fail` 4 times in a row, at 94k to 174k input tokens each, while every reply said the script failed on the base and passed on the change. The matcher failed, not the agent.
- **An audit of the same mechanism** found that a missing base worktree read as a reproduction, because `cd` failed with a non-zero exit (F1), that the script and the workspace could change between the two runs, and Verify's edits were pushed to the attempt branch (F2), that an Implement push with no net change passed (F3), and that the pull request body held the agent's prose instead of the recorded evidence, and a later Verify never refreshed it (F4).
- **After, with the Job running the script.** Verify passed on all 4 entries on its first attempt, with the script failing on the base commit and passing on the change each time. titleCase, slugify, and clamp reached clean. chunk merged, and missed clean only because its Verify transcript held a reasoning item that Codex started and never completed, which the replay check refuses, outside Verify's evidence. Verify took 60k to 94k input tokens where it had taken up to 174k.

With the same change, Implement's no-change rule compares trees instead of commit ids (F3), and each passing Verify owes the pull request the engine's rendered evidence, which replaces any earlier evidence in its body (F4). A repository's new `setupCommand` installs what a fresh checkout needs, such as `npm ci`.

What it doesn't close: the script is the agent's code, so it can still decide its result by something other than the behavior, such as a file it leaves in the shared `/tmp` during the base run. The evidence shows the whole script beside both runs so a reviewer can see that.

Rejected options for the refinement:

- **Keep matching the agent's commands, with a looser matcher.** Every fix to the matcher still trusts what the agent says it ran and where, and slugify failed 4 times on the matcher alone.
- **Run the script as `codex`, the agent's own user.** It is one user fewer, but the script can then read the Codex login and write into folders the agent's leftover processes can reach.

### The core ships one public Job image

Decided 23 Sep 2026. Every attempt's Job runs from one public image that the core ships, with the pinned Codex CLI. A repository may name its own image and a test command. Registries that need credentials, and images that aren't public, belong to a company's fork. Nothing more is built into the core until a second repository needs it.

Rejected option:

- **A prebuilt image and a test command required for every repository.** Some images aren't public, and a repository that needs neither would have to supply both.

### Stages hand off at artifacts, and a failed Verify returns to Implement

Decided 23 Sep 2026. Each stage ends with something the next one starts from: Specify with a written plan, Implement with a draft pull request, Verify with saved evidence, and Land with a merged pull request. A failure costs one stage. What happens inside a stage comes from the routine's goal and the repository. When Verify finds the behavior still wrong, the task goes back to Implement with Verify's evidence, and Implement pushes a fix to the same pull request. When only Verify's environment fails, Verify runs again on its own, up to 3 times in a row, and a fourth environment failure in a row makes the task wait for a person. When Specify, Implement, or Land fails, that stage runs again on its own, up to 2 times in a row, and a third failure in a row makes the task wait for a person. Agents are not deterministic, so a second try sometimes succeeds where the first failed. After 3 Verify rounds without a pass, the task waits for a person, with exact instructions. The TLA+ model in `features/tasks/` checks that these caps hold and that every task ends done, waiting, or stopped.

Rejected options:

- **Implement ends with a pushed branch.** Most repositories run CI on pull requests, so their checks would first run in Land, after Verify had passed.
- **Retry Verify on every failure.** A retry cannot fix behavior that is still wrong.
- **Wait for a person at the first failure of Specify, Implement, or Land.** It spends no agent time on reruns, but a failure that a second try would clear still reaches a person.

### A routine sets where it ends, its gates, and its stage instructions

Decided 23 Sep 2026. A person should step in before an action that can't be undone, where a judgment belongs to the team, and where a team doesn't trust AutoWorker yet for that kind of work. The last of these changes over time, routine by routine, so it lives in each routine's settings rather than in the core. A routine picks its last stage, so done can be an open pull request that people take from there. After any stage, a routine can add a gate that waits for a person's Approve action. Each stage has a default prompt in the core, and a routine adds its own instructions to any stage. A task keeps the stages and gates of the routine version that found it, and its instructions follow the newest version at each attempt. The engine performs irreversible actions itself, through the outbox, and only when their conditions hold. It merges, or joins the merge queue, only when GitHub reports the pull request mergeable under the repository's own rules and every gate is approved, and no prompt can override that.

If a fault loses a task's approvals at Land, the task keeps its place without them. A later return to Implement does not restore them, so the task cannot merge until a person approves each missing gate again. A gate at or after the return point comes back through Approve on the way to Land. A gate before it never comes back, since no action lets a person approve it again. Land parks the task on the instruction to stop it, Retry keeps the empty approvals so Land parks it again, and Stop is the way out. The fault has no known cause in the code, and the check at Land is defense in depth, so a stuck but safe task is acceptable. The task model records each lost approval as missing. Its invariant `ApprovalsMatchGatesPassed` then says a task's approvals are exactly the gates it has passed, minus those missing, and a gate stays missing until a return sends the task back to or before it.

Rejected options:

- **One fixed pipeline.** No routine could stop at a pull request or ask for a plan review.
- **Stages each routine defines for itself.** No model could check every shape, the dashboard could not show one, and a prompt could decide when to merge.

### A routine picks a workflow, and code defines each workflow's steps

Decided 23 Sep 2026. Not every routine changes code. A daily chat update needs no repository, a clean-up may only close stale branches, and a fork may review pull requests. So the core runs workflows, and a workflow is an ordered list of step kinds. A step kind is code. It names its input, its output schema, and its core prompt when it runs an agent. It also says whether it needs a repository, which actions it may owe, where a failure sends the task, and which [review](#an-agent-step-ends-with-a-review-a-person-can-answer) blocks it requires. Code change, with Specify, Implement, Verify, and Land, is the first workflow. Each workflow lives in its own feature folder, and the engine's entry point hands the runner the list, so the runner never names a workflow or a step. Where tasks come from is chosen the same way, from sources such as a Jira search or a schedule that makes one task per run.

A routine picks its workflow and its source in the dashboard, and the [routine settings](#a-routine-sets-where-it-ends-its-gates-and-its-stage-instructions) apply to that workflow's steps. Adding a workflow or a step kind takes a pull request. The core ships its own workflows, and a fork adds its own in its own folders. No workflow in the core approves a pull request.

Rejected options:

- **One fixed pipeline.** A chat update or a pull request review would be a fork's own program, outside routines and their gates.
- **Steps each routine defines for itself.** The engine would need a generic outside request, TLC could check only what holds for any list of steps, and the dashboard could show a new output only as raw JSON.

### A person's note on Retry or Send back reaches the agent

Decided 23 Sep 2026. A person who turns down a plan or retries a task usually knows what went wrong, and the agent should hear it. Retry takes an optional note. A gate offers Send back beside Approve, which runs the gated step again and needs a note. The note goes into that step's next prompt after the routine's instructions, and the action that carries it records who wrote it.

Rejected options:

- **A note on Retry only.** Turning down a plan would take a Stop and then a Retry.
- **No notes.** A person could steer only a running attempt, or edit the ticket before a Retry.

### An agent step ends with a review a person can answer

Decided 23 Sep 2026. An agent often needs to show a person something and get an answer, such as a plan, a draft chat message, or a list of branches to delete. So every agent step ends its turn with a review in one fixed format, which Codex receives as the turn's output schema. A review has an outcome, which is done, needs input, or blocked, and a list of blocks. The block kinds are text, list, choice, checklist, and draft. A person answers a choice by picking an option, a checklist by unticking items, and a draft by editing it. Approve or Send back covers the whole review. A step kind names the blocks it requires and what happens to the answers, and the answers go into the next prompt. The dashboard draws every review with one component. When an agent returns needs input, the task waits for a person even without a gate, up to a cap. A routine's instructions say what to show, and a new kind of control becomes a new block kind in the core. On 23 Sep, three real turns returned a plan, a draft, and a checklist that all matched this format. A schema with an optional field failed its turn at once, so every field is required and "none" is null.

On 24 Sep, real runs on gpt-6-luna failed every Specify and Implement turn. Codex put the plan in a `list` block. Once a step offered only `text` and `choice`, Codex returned an empty `choice` block instead. The engine stored the output schema in a `jsonb` column, and `jsonb` sorts object keys. So every `text` block reached Codex starting with `body`, and every other block kind started with `kind`. Codex starts a block with `kind`, so it could not reach `text`. A probe of 5 replies per step on Specify, Implement, and Verify measured the effect. With the keys in the declared order, 15 of 15 reviews parsed with the step's required text. With the keys in `jsonb` order, 2 of 15 did. So the column is `json`, which keeps the schema's text as sent, and `strict-schemas` fails a block kind whose first field is not `kind`. The steps offer all five block kinds again. With the keys in order, the full union parsed 15 of 15, so narrowing a step to `text` and `choice` was a workaround and was reverted.

Rejected options:

- **Fields each routine defines.** Anyone can edit a routine, one wrong field fails every attempt, and the engine can't act on fields it doesn't know.
- **A view per step kind.** Every new step kind would need its own page code and its own answer handling.
- **Typed top-level fields per step, such as a `plan` string, with a nullable `questions` list for the blocks.** Measured on 24 Sep, it parsed 15 of 15 in both key orders. The blocks review also parsed 15 of 15 once the keys kept their order. So it fixes nothing that keeping the order does not fix, and it would change every reader of a review.

### Review feedback comes back once, as a whole review

Decided 23 Sep 2026. Land acts on a whole submitted review rather than on single comments, and returns the task to Implement at most once, with every comment as its input. After that round, a routine chooses whether later reviews wait for a person or are ignored, because later rounds tend to be nits and noise. When they are ignored, AutoWorker carries on toward Land, and GitHub's own rules still decide whether the pull request can merge. A repository can list reviewers whose reviews are always ignored, such as review bots. Formally dismissing someone's review on GitHub stays out of the core, because it overrides a reviewer, and a fork can add it.

Rejected options:

- **Answer every review, up to the stage caps.** Where an approval must follow the last push, each round costs the reviewer another approval.
- **Never answer, and always wait.** Small fixes would wait on people too.

### Each repository chooses when a draft leaves draft

Decided 23 Sep 2026. Implement opens its pull request as a draft, and GitHub can't merge a draft, so Land marks it ready. Ready is GitHub's signal to reviewers, and when AutoWorker flips it is a per-repository setting. By default it waits until every check that ran on the head is green, apart from checks the repository marks as ignorable, and a red check returns the work to Implement within the caps. A repository can instead mark the draft ready without waiting for green checks, because in some repositories a red pull request in review is fine. AutoWorker never asks anyone for a review itself.

Rejected option:

- **One rule for every repository.** Review customs differ between repositories, and a generic core can't know them.

### Land runs in the engine, and hands each action it owes to the outbox

Decided 24 Sep 2026 while building Land (L1), to fit `features/code-change/Land.tla` (M4) to the outbox and the task store.

- Land is an engine loop with no Job and no agent. Each pass claims a Land attempt for every ready task at Land through the task claim, renews its lease, reads the pull request's merge state, and acts by one table of rules, `rules` in `features/code-change/land.ts`, in the order `Land.tla` decides. A task that owes an action is skipped before GitHub is read.
- An attempt that owes `pr.mark-ready`, `pr.update-branch`, or `pr.merge` ends with the verdict `handed_off` in the transaction that owes the action, and its task stays at Land. The store refuses to owe an action while its task has a live attempt, and refuses to claim a task that owes one, so the attempt has to end first. The next pass claims a fresh attempt once the row settles.
- Land keeps its memory in the store it already has. An attempt that answered a review or a queue ejection records the id in its output as `answers`, and the head of a refused merge is the refused row's result.
- Merged ends the attempt with a pass, and the same transaction owes a comment on the ticket and `branch.delete`. A required approval ends it with `review_required`, and the same transaction writes the review step's note and owes what the step returns. The core's step returns nothing, because approval comes from the repository's rules and a fork's plug-in (G).
- A conflict returns the task to Implement with the verdict `red_check`, counted in `landRounds`, because Code change declares no other route back from Land.
- Land reads its record again after the claim, because a second engine can finish an attempt between the pass's list and the claim. While the attempt is live the store holds no owed row for the task, so that record stays true until the decision commits.
- Land renews an attempt only after a good read. A read that keeps failing lets the lease lapse, and the reaper's cap on lost attempts parks the task, so a closed pull request or a revoked token reaches a person.
- Land answers each refused merge once, as `Land.tla` clears `refusedAt` when an attempt fails, so a refusal a second try can clear costs one retry. A draft that stays a draft after AutoWorker marked it ready, and a branch still behind after an update at the same head, fail the attempt, so neither action is owed without end.
- Land passes the reader the last ejection and review it answered, and the reader reports what lies beneath them, so an answered ejection never hides a red check. The draft setting comes from the repository row, `repository.draft_leaves`.
- The model moved from `features/github/` to `features/code-change/`, beside the loop it covers (A4). The folder's `invariants.ts` names its seven properties, and `land-sim` checks each one by name.

Rejected options:

- **Keep the attempt live and owe from it.** The store refuses the row while the attempt is live.
- **End the attempt with `pass` or `lost`.** A pass ends the task at Land, and a lost attempt counts toward parking it.

### A request for help says exactly what to do

Decided 23 Sep 2026. When AutoWorker needs a person, it says exactly what the person must do and what AutoWorker does once they have done it. This holds for parked tasks, the list of work that needs someone, and chat posts.

### Stored tokens are write-only

Decided 23 Sep 2026. A stored token can be replaced but is never shown back, so acting as someone else cannot reveal their token. The dashboard's database role has no read access to the token column. In the data model draft, that role replaced a token and was refused when it tried to read one. A replacement is recorded with who made it and when, and nobody is alerted. The owner is alerted when their token expires.

Rejected option:

- **Alert the owner on every replacement.** The record on the People page is enough, and an expired token is the case that needs action.

### The dashboard uses the Graphite color scheme

Decided 23 Sep 2026. The dashboard is neutral grey, and color marks only state: amber for work that needs a person, blue for running, green for landed, and red for failed. The build checks every color pair against contrast floors in light and dark mode.

Rejected options:

- **Cobalt.** Running work and clickable controls would share one blue.
- **Plum.** It is the most a matter of taste.
- **The original green.** The owner found it unpleasant.

### Concurrent protocols are model-checked with TLA+

Decided 23 Sep 2026. Claims and leases, the stage machine with its Verify loop, the outbox, the bridge's event delivery, and the routine schedule each get a TLA+ model, checked with TLC. A model is written before the code it covers, so it checks the design while the design is still cheap to change. It runs in CI whenever the model or that code changes. The repository's verification skill, generated with `/create-verification-skill` once the engine runs, includes the models and the command that checks them. The nightly workflow, which runs only when started by hand (see [the decision on the nightly workflow](#the-nightly-workflow-runs-only-when-started-by-hand)), also checks the task model at 2 tasks and 2 workers at the real caps. On 23 Sep the owner added a second nightly size of 3 tasks and 2 workers, at caps of 2 with 1 person action, for the safety properties only, so that tasks compete for workers.

Rejected options:

- **Lean.** It proves a property for every input, but each proof costs far more effort, and this design's risks are races between processes, which TLA+ checks directly.
- **No formal methods.** The prototypes checked one run of each race. A model checks every ordering of steps within its bounds.
- **A nightly run of 3 tasks and 4 workers at the real caps.** With only 2 workers, that size passed 186 million states and was stopped after 40 minutes on 16 CPUs.
- **A nightly run of 2 tasks only.** Tasks never compete for workers, so a bug that needs a queue of tasks cannot show.

### The engine checks and refreshes every credential

Decided 23 Sep 2026. Each kind of connector comes with a check that proves a stored credential still works. The engine runs the checks where the credentials are stored, as the current AutoWorker does in its parent pod, and a Job inherits only what it needs. For Codex, the check runs `codex exec` on a cheap model with a prompt that must be answered `ack`. Codex refreshes its own login during a check when the access token has 5 minutes or less left, and the engine seals the refreshed login back. A Job gets a copy with the refresh token removed, so it can never refresh. Codex rereads its login file before it refreshes, so a running Job can pick up a newer copy from the engine. A check is claimed like an attempt, so two engine copies never refresh one login at once. Each person gives AutoWorker a login made for it, because a refresh by the engine signs out every other copy of the same login.

The evidence comes from throwaway prototypes against Codex CLI 0.156.0:

- A copy of a login with its refresh token blanked ran a full app server turn and was never rewritten.
- The check replied `ack` in 16.7 s and sent 13,528 input tokens, 11,008 of them cached. On a copy with a broken signature it failed after 22.9 s with a 401.
- Codex's source refreshes early only in the last 5 minutes, and rereads its file before it refreshes after a 401. That part was read, not run.

Rejected options:

- **A Job refreshes its own copy.** A refresh token works once, so a Job's refresh would sign out every other copy, and two Jobs refreshing at once would race.
- **The engine calls OpenAI's refresh endpoint itself.** It is undocumented, and it would be a second implementation of Codex's login.

### A task works in one repository when a step needs one

Decided 23 Sep 2026. A routine names the repository its work happens in, and each task copies that repository when the routine finds it. Every attempt then knows what to clone before its agent starts, and a task's repository never changes while it runs. A workflow with no step that needs a repository, such as a daily chat update, names none. The schema refuses a task with no repository when its workflow has such a step. For now the only repository is AutoWorker's own. Repositories are rows of their own, since several routines will share one, and facts about a repository belong in one place. A row names the repository and the branch changes land on.

Rejected options:

- **A setting in the engine's configuration.** It would be a second record beside Postgres, and it allows one repository per deployment.
- **A repository found per task at intake.** Intake would have no default and nothing to enforce.
- **The agent chooses.** The pod clones the repository before the agent starts.

### AutoWorker checks each repository before it works there, and takes skills from the clone

Decided 23 Sep 2026. AutoWorker should build itself and other repositories, so a repository has to be easy to add and safe to work in. A repository stays a row with its settings, and every change to them records the person's action that made it. A check reads GitHub as each person a routine runs as, and stores findings. Each finding blocks or warns, and says the exact fix. The check runs when a repository is added or edited, and on Check now. It also runs before a claim when its last result is more than 6 hours old, and after an attempt fails to clone or push. A blocking finding keeps the task waiting with that fix, and an unknown result, such as GitHub being down, blocks nothing. By default, a Job starts only when the landing branch requires a pull request under a ruleset its identity cannot bypass. A repository can turn this off.

Skills come from the clone. An attempt uses the skills in its start commit, which Codex loads from `.agents/skills/` and `.codex/skills/` only. A routine names skills for each step, the engine confirms they exist before the claim, and the attempt records which versions it used. The engine never puts skill text in a prompt. A repository's `.codex/config.toml` also loads into Codex, so the bridge pins every setting it relies on when it starts a thread.

A merge never changes the running engine, because images are named by digest and a person deploys. The Job runs its bridge from the image, never from the clone. The bridge and the engine check a protocol number. Codex runs as a different user from the bridge, so the agent cannot read the bridge's token. GitHub holds the bar for AutoWorker's own repository. Since 23 Sep, a ruleset on `main` requires a pull request and the `check` and `models` jobs, and blocks force pushes and deletion. An admin can bypass it only through a pull request. AutoWorker works on itself as a separate team account, starting with draft pull requests, and merges only after the owner approves.

Rejected options:

- **A connect job that loads skills on a schedule.** Each Job's clone already holds the skills at the exact commit, and a copy drifts.
- **A loop that checks every repository on a timer.** It checks pairs no task uses. Checking before use is the credential checks' rule.
- **Copying `.claude/skills` into Codex's home.** No run has shown the need (E2), and those skills name tools Codex lacks.
- **Land waiting when a branch requires no checks.** It would be an AutoWorker merge bar, and each repository's own rules already set that.

### Invariants live in structure, and behavior is checked by simulation

Decided 23 Sep 2026. The owner's experience is that unit tests for models do little, and that simulating behavior finds far more. Each invariant lives where the build or the store enforces it, in a type, a schema constraint, or a TLA+ property. A negative control proves it can fail, such as a planted violation or a mutant that drops a constraint. Behavior is checked by running the real code in a seeded simulation against real Postgres. The simulation injects faults such as crashes, hangs, and bursts of concurrent claims, and checks every invariant after each step, under the same names the TLA+ model uses. A seed replays a failing run. A unit test is kept only for a pure function whose logic a simulation cannot reach. AGENTS.md records this as C6.

Rejected options:

- **A unit test per function or table row.** It restates the code, so it still passes when the code is wrong, and it blocks honest edits to the value it pins.
- **Port the data model draft's 87 checks as unit tests.** Most restate a constraint Postgres already enforces. A mutant per constraint shows each constraint is load-bearing, and the simulation exercises it under concurrency.

### An end-to-end test proves ticket to merge on sandboxes

Decided 23 Sep 2026. Before AutoWorker works on itself, a test proves the whole path on sandboxes. It files a ticket in a sandbox Jira space, and AutoWorker takes the ticket to a merged pull request on a sandbox branch of its own repository, running the real agent with the owner's Codex login. The sandbox project lives in a folder of AutoWorker's repository, and each run gets a fresh branch made from that folder alone, so main never changes and every run starts from the same code. AutoWorker will run where a private repository is out of reach, and it needs write access to its own repository for self-delivery anyway, so the test needs no other repository. The test checks each step against Jira, GitHub, and AutoWorker's own record rather than trusting AutoWorker's report, and posts a timeline with links and evidence to the ticket. Its harness is built first and reports how far a ticket gets, so each later PR shows its progress toward the whole path. Webex joins once the call on chat posts is made.

Rejected options:

- **Fakes of Jira and GitHub.** They run free in CI and may come later for that, but a demonstration needs the real services' behavior, such as Jira's workflow and GitHub's checks.
- **Wait for AutoWorker to deliver its own changes.** That stays the final bar. A sandbox lets a failed run cost nothing, and the test can run as often as needed.
- **A separate private sandbox repository.** Where AutoWorker runs later may not reach a private repository under the owner's account.
- **Merge sandbox changes into main.** Every run would add commits to main and run main's CI, and runs would stop starting from the same code.

### Stop does not recall a pull request from the merge queue

Decided 24 Sep 2026. Once Land has put a pull request in GitHub's merge queue, GitHub owns the merge. Stop ends AutoWorker's own work on the task, and the pull request may still merge. The task page says so. `main` in this repository has no merge queue, so the case can't arise here yet.

When the queue ejects a pull request, the `pr.merge` row records the ejection and its reason, and Land fails that attempt once. Land's next pass reads the pull request past that ejection. Red checks or a conflict send the task back to Implement with the reason, and a ready pull request joins the queue again. These failures count toward the stage's retries, and after them the task waits for a person.

Rejected options:

- **Stop owes a `pr.dequeue` action.** It needs a change to the Land model and one more GitHub performer, for a case no repository here has yet.

### Retry after a Stop at a gate resumes waiting at the gate

Decided 24 Sep 2026. Take a task that a person stops while it waits at a gate. Retry returns it to waiting for Approve on the same review. The gated step already passed, so its work stays. A person who wants the step done again uses Send back, which takes a note. The rule holds in the task model, where `GateStopResumesAtGate` checks it, and in the code: a stopped task keeps the gate's review, and Retry makes it wait on that review again.

Rejected options:

- **Rerun the gated step.** It repeats work that passed, and Send back already covers a redo with a note.

### Retry after a return cap starts again where the failure returns

Decided 25 Sep 2026 by the owner. When Verify finds the behavior still wrong, the task goes back to Implement on its own, up to 3 rounds, and after the third it waits at Verify for a person. Retry used to run Verify again on the same code, so the verdict repeated, and only then did the task go back to Implement. The person's note reached only that wasted Verify run, because an attempt's prompt carries the notes made after the previous attempt started. Implement never saw what the person asked to change.

Now Retry starts again at the step that the failure returns to. That is the `to` of the `return` failure whose counter reached its cap, and the counts the task saved when it parked record which counter that was. For Code change, Retry starts at Implement after Verify's 3 rounds and after Land's 3 rounds of red checks, and the person's note reaches Implement. Each waiting message says so. Every other stop keeps its meaning. A task stopped at a gate returns to waiting for Approve, a `rerun` failure such as Verify's environment runs the same step again, and a step that failed its own retries runs again. Send back is unchanged. The task model checks the rule as `RetryStartsWhereTheFailureRoutes`, and the simulator checks the same property after every step.

Rejected options:

- **Keep today's Retry.** Verify runs again on unchanged code and repeats its verdict, and the note never reaches Implement.
- **Ask each time where Retry starts.** Every Retry card gains a choice, and after a return cap the answer is nearly always the step the failure returns to.

### Run branches keep the harness's sandbox status

Decided 24 Sep 2026. Ruleset 23901469 requires the `sandbox` check on `e2e/run-*` branches. It accepts that check from any source, and it applies the rule when a branch is created. So the end-to-end harness posts a `sandbox` success on each seed commit, which lets it create a run branch. The check stays open to other posters, such as a future Verify environment.

Rejected options:

- **Accept `sandbox` only from GitHub Actions.** Only CI could mark the check passed, and the token would need no commit-status write, but nothing else could post `sandbox`.

### Database grants keep stored credentials write-only for the dashboard

Decided 24 Sep 2026. The dashboard seals new credentials with the same AES-256-GCM key the engine uses to open them. Write-only rests on the database grants, because the dashboard's role can't read the `ciphertext` column. This is the simpler design, both for people adding credentials and for the people who maintain it. Revisit it before the first real deployment.

Rejected options:

- **Seal with a public key.** Only the engine could open a credential. It changes the Stack line, the sealing code, and key rotation, and it means re-sealing every stored credential.

### The nightly workflow runs only when started by hand

Decided 24 Sep 2026. The `nightly` workflow has no schedule. It runs when someone starts it from the repository's Actions tab, or with `gh workflow run nightly.yml`. What it checks is unchanged: every model at its nightly bounds, and each simulator at its long setting. Start it before merging a batch into `main`, and after changing a model's nightly config.

On 23 and 24 Sep, CI and nightly runs came to $24.53 of Actions time at list price. It was free for this public repository, and no minutes were charged. The Tasks model's nightly config also runs out of Java heap during its liveness check, so a scheduled run would fail every night until that is fixed.

Rejected options:

- **Keep the daily schedule.** Each run holds the models job and every simulator shard for up to 4 hours, and it would fail every night on the Tasks model's heap.

### CI runs locally while GitHub Actions is disabled

Decided 25 Sep 2026. GitHub marked the owner's account as spam, and a request to reinstate it is pending. The owner disabled GitHub Actions for the repository on 25 Sep 2026, so no pull request or push gets a CI run on GitHub.

Until Actions is enabled again, `node tools/ci-local/main.ts` runs CI on the machine that integrates. It reads every `run:` step of `.github/workflows/ci.yml`, so the local run and the GitHub run can't drift: a new CI step goes in `ci.yml` alone. It builds the verify image and installs packages once. Then it runs the jobs in parallel, as GitHub does, and each job's steps in order inside the verify container, and it runs every step even after one fails. It prints results in `ci.yml` order and gives the run's wall time. The jobs ran one after another until 25 Sep, when a run took about 3,000 s and each new job would have added its full length. It refuses a worktree with uncommitted changes and names the head SHA first, then writes one log per step and a summary to `ci-local/<sha>/`. A head is integrated only when that summary says `PASS`. Each run records itself in its worktree's `ci-local/run.json` and labels its step containers with its run id. A second run in the same worktree is refused while the recorded one lives, and a run that finds a dead one's record first removes that run's leftover containers. The only way to stop a run is `node tools/ci-local/main.ts --stop` in its worktree, which asks that run to remove its own containers and exit. This came from 25 Sep, when one agent stopping its own run killed the coordinator's by pid twice: every run has the same command line, and each killed run left its step containers running. `npm run ci-plan`, part of `npm run check`, fails on any step that the local run can't perform, such as a `uses:` action other than checkout, so `ci.yml` can't gain a step that CI on GitHub runs and the local run skips.

What the local run doesn't give:

- **A clean machine per run.** Every step shares this machine's Docker, its image cache, and the `node_modules` volume of the worktree's compose project. A step can pass here and fail on a fresh runner.
- **Separate machines per job and time limits.** The jobs run at the same time on one machine, so a slow job slows the others, and `timeout-minutes` is not enforced. The time ceilings in `budget/budget.json` stop a runaway job instead.
- **A record anyone else can see.** The summary stays on this machine, and GitHub shows no check on the pull request.
- **The nightly workflow.** It has no local runner, so its larger model bounds and long simulator runs don't run until Actions returns.

When the account is reinstated, the owner enables Actions again, and `ci.yml` runs on GitHub with the same steps. Then CI on GitHub gates integration again. The local runner can stay as a way to reproduce CI before pushing.

Rejected options:

- **A second list of local steps.** It is quicker to write, but it drifts from `ci.yml` the first time someone adds a step to one and not the other.
- **Let `--stop` kill the recorded pid.** It stops even a run that stopped reading, but Windows reuses pids, so a stale record could kill an unrelated process. Asking the run to stop itself can only reach the run that wrote the record.
- **Run the workflow with a GitHub Actions emulator.** It would run the `uses:` steps too, but it adds a tool the Stack doesn't list and a second way to run CI, and `ci.yml` needs only its `run:` steps.

### Land's rules for a lagging branch or draft sit outside Land.tla

Decided 25 Sep 2026 after the audit before the merge of the end-to-end branch (FX4, finding F9). Three rows of `rules` in `features/code-change/land.ts` have no counterpart in `features/code-change/Land.tla`:

- **Behind.** A pull request whose branch is behind its base owes `pr.update-branch` at the head Land read.
- **Still behind.** A branch still behind after AutoWorker updated it at the same head fails the attempt.
- **Still a draft.** A draft that is still a draft after AutoWorker marked it ready fails the attempt.

The model has no base branch that moves ahead, and its `MarkReady` clears the draft in the same step, so none of these states exist in it. They stay outside the model, for these reasons:

- **They guard progress, not safety.** None of them owes a merge. An update moves the head, so a merge still needs a later ready read at the new head, and the merge performer reads the pull request again and refuses unless that read is ready (F5). The two "still" rows only fail an attempt, which `FailAttempt` already models with its retry cap. So `MergedHeadWasMergeable`, `PerformedMergeWasAllowed`, and `ReadyOnlyWhenChecksGreen` hold with or without them.
- **They answer GitHub's lag, which the model can't bound.** Each row exists so that an update or a ready call that GitHub accepted but did not apply costs one retry instead of an owed action without end. Modeling that needs a base branch, an update row, and a lag between the call and GitHub's state. That multiplies the states TLC explores, and it was more work than this unit's timebox allowed.

What checks them now: `github-sim` reads `behind` and performs `pr.update-branch` through the real client against the fake GitHub, whose update is refused when the head moved and answers "no new commits" when the branch is current. `land-sim` never reads `behind`, and its record's `updatedAt` is always null, so no simulation runs the "still behind" or "still a draft" rows through `decideLand`. That gap stays open.

Rejected options:

- **Model them now.** It is the stronger check, and the next change to these rows should add it. It needs a guard per row, a mutant per guard in `verify.ts`, and matching moves in `land-sim`.

### The engine stores a NUL character from the bridge as U+FFFD

Decided 25 Sep 2026. Postgres can't hold the NUL character (`\u0000`) in `jsonb` or `text`, and the app server can write one, for example in a command's output. Before this decision, one NUL in one line made the engine refuse the whole batch. The bridge resent it until the lease ran out, and the reaper marked the attempt lost. The engine now replaces every NUL with U+FFFD, the Unicode replacement character, where it parses a line and before it stores it. The replacement covers every string and every object key in an app-server line, the text of a line that isn't JSON, a reproduced line, and a pushed line's branch. The stored line then differs from what the app server wrote only where a NUL was, and it shows a visible mark there. `bridge-sim` checks this directly, and its fake app server writes NUL into every step it streams.

Rejected options:

- **Refuse a line that carries NUL.** The attempt would still die, only with a clearer reason.
- **Drop the NUL character.** It hides that anything was there, and it can join two words.
- **Store the escaped text `\u0000` as six characters.** A reader can't tell it from an app server that wrote those six characters.

### Setup keeps a stored login that expires later than the file's

Decided 25 Sep 2026 after the audit before the merge of the end-to-end branch (FX3a). The engine refreshes a Codex login and writes the new one back, and a refresh token works only once. Before this decision, running setup again with the same file sealed the file's older login over the refreshed one, so the engine's next refresh presented a used token and lost the login. Now `applyLogins` in `features/credentials/setup.ts` locks the credential row and seals the file's login only when it expires later than the stored one, and setup prints how many logins it kept. `node services/engine/setup.ts --replace-logins <file>` seals the file's logins anyway. A login with no expiry, such as a GitHub token or a Jira login, is replaced whenever it differs. `ReapplyNeedsNewerLogin` in `features/credentials/Checks.tla` models the rule, and the `setup` scenario refreshes a login and then applies the same file again.

Rejected options:

- **The file always wins.** Setup stays a plain copy of the file, but every run after the engine's first refresh rolls the login back, and the next refresh presents a used token.

### The attempt start lease outlasts the whole start instead of being renewed during it

Decided 25 Sep 2026 after the audit before the merge of the end-to-end branch (FX3a). An attempt's start can run a Codex check for up to `CHECK_TIMEOUT_MS` and then wait for its Verify environment for up to `ENVIRONMENT_START_DEADLINE_MS`, and it renews its lease only after both. The old default lease, 300 s, was shorter than the default start deadline alone, 600 s, so the reaper could release a start that was still running. Now `services/engine/main.ts` refuses to start unless `ATTEMPT_START_LEASE_MS` is more than `ENVIRONMENT_START_DEADLINE_MS` plus `CHECK_TIMEOUT_MS` plus 60 s, and the default lease is 900 s. `npm run verify -- engine-checks` proves the refusal. The cost is recovery time: a start lost to a crashed engine waits up to 15 minutes before the reaper releases it, not 5.

Rejected options:

- **Renew the lease while `provider.start` runs.** Recovery would stay fast, but a heartbeat beside the start changes the task protocol, so `features/tasks/Tasks.tla` would have to model it first (C5), and `tasks-sim` would need matching moves.

### The seed gives the sandbox the product's package types

Decided 25 Sep 2026. The sandbox repository typechecks in its own CI with the same settings as the product and without `skipLibCheck`. Vitest's declarations name `EventTarget`, `AbortSignal`, and `WebSocket`, which `@types/node` declares, and tinybench's name `DOMHighResTimeStamp`, which no package declares. So the sandbox pins the product's `@types/node` and sets `types: ["node"]` as the root tsconfig does. `sandboxSeed` in `features/e2e/sandbox-seed.ts` copies `shared/types/tinybench.d.ts` into the seed as `types/tinybench.d.ts`, and the sandbox's tsconfig includes `types/`. Both the run branch and the stand-in's local copy come from `sandboxSeed`. The repository holds one copy of the declaration, so the root typecheck, which also covers the sandbox's code, never sees two. A copy of the sandbox with `skipLibCheck` removed failed with 21 errors before this change. `npm run shape` now rejects `skipLibCheck` in any config outside `.claude/`.

Rejected options:

- **Keep `skipLibCheck` on in the sandbox.** It hides every error in every package's declarations, and the Package types path forbids it.
- **Add the DOM library to the sandbox's `lib`.** It declares every missing name at once, but it types browser globals such as `document` in code that runs on Node, and the sandbox would typecheck under other globals than the root typecheck gives the same files.
- **Keep a second copy under `features/e2e/sandbox/types/` and exclude it from the root tsconfig.** The repository would hold two copies that can drift, and the root tsconfig would gain an exclusion that only this folder needs.

### The codebase grows only by a raise commit against a checked-in budget

Decided 25 Sep 2026 by the owner, from a colleague's practice. `budget/budget.json` gives each area a ceiling and a written why, and `npm run budget` fails a change that passes one. A ceiling goes down in any commit and goes up only in a commit that changes nothing outside `budget/`, so a reviewer sees every growth decision on its own (B6). The budget is the one place the codebase's aggregate size shows up at merge time. It was seeded at e371a50 with 36,949 non-blank lines across seven roles, 186 named constraints, indexes, and triggers, and 55 scenario declarations. The owner changed the practice in four ways:

- **A ceiling per role.** Product, feature verification, the e2e harness, tools, TLA+ models, migrations, and docs each have their own ceilings, declared as globs in the budget file so a fork can change them. On 24 Sep two units deleted six schema constraints to pass a catalog check, so the shortest path to a passing check is real, and one shared ceiling would make deleting verification the shortest path to room for product code.
- **Structure first, then lines.** Structural counts, such as tables, named guards, dependencies, verify scenarios, CI steps, and each model's distinct states, say more about cost than lines do. Each role also has a non-whitespace character ceiling, which joining lines cannot shrink, and a longest-line ceiling that only goes down, seeded at today's widest line so no file needs reformatting. A longest-line ceiling alone would still let a change join short lines up to it.
- **Generous time ceilings.** Each CI job's ceiling was seeded at about twice its longest recent local run: check 3,500 s, models 4,700 s, sims 2,700 s, and simulation 2,000 s. The owner capped verification at 8 of 16 cores the same day, so `budget/raises/core-cap.json` raises each to about four times that run until runs under the cap are measured. Local CI stops a job that passes its ceiling. Time ceilings never lower themselves.
- **Lowered at landing, never in units.** Each unit raises in its own file under `budget/raises/`, so parallel raises merge without a conflict, and the coordinator's `npm run budget -- --lower` folds them in and sets each count to what landed. `docs/decisions.md` and `docs/feature-map.md` conflicted in almost every candidate on 25 Sep, and a budget file that every unit edits would do the same.

Rejected options:

- **One total line budget.** It is the simplest to read, but it lets a change pay for product code by deleting tests or simulations, which is the failure the per-role ceilings exist to stop.
- **Units lower the ceilings.** Every unit would edit the same numbers, so the budget file would conflict in almost every integration.
- **Tight time budgets.** Local times swing with machine load, so a tight ceiling fails healthy runs and teaches agents to raise it without looking. The distinct state count is the ratchet for model cost, because it does not depend on load.
- **A raise that states the new ceiling.** Two parallel raises of the same area would each count the same room, so a raise states the amount it adds.

## Open

Each open question names the current lean or default. A lean is not a decision.

- **What the dashboard's Overview shows first.** The lean is what needs the person picked, with the pipeline board and the history one click away.
- **When AutoWorker posts to chat.** The default is to post when a task parks as waiting, when a routine is overdue, and once a day as a digest.
- **When sign-in becomes necessary.** Runs now carry personal logins, so picking a person runs an agent with that person's GitHub token and ChatGPT account. The lean is to add sign-in before the first run with real personal credentials.
- **How a person gives AutoWorker a Codex login.** The lean is a Connect button that has the engine run `codex login --device-auth` and show the person its link and code, so the login is made for AutoWorker by construction.
