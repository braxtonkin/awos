# Decisions

This file holds the settled design decisions for AutoWorker and the questions still open. Each entry says what was decided, why, and which options lost, so the same argument does not need to happen twice. The behavior these decisions serve is in [spec.md](spec.md).

## Settled

### Workers claim a task by inserting an attempt row

Decided 23 Sep 2026. Every try at a stage is a row in the `attempt` table. A partial unique index on `task_id`, limited to rows where `finished_at` is null, allows one unfinished attempt per task. Postgres refuses a second claim, so no code has to check first. A reaper marks attempts whose lease has expired as `lost`. That frees the task and keeps a record the dashboard can show. A late write from a lost attempt matches no rows.

The evidence comes from a throwaway prototype on Postgres 18 with a 2 s lease:

- 20 workers raced for one task, and exactly 1 won.
- A hung worker's task was claimed again after 2.09 s, and the hung worker's late write was rejected.
- A chaos run of 13 tasks, with workers dying mid-stage, finished every task. No task ever had two unfinished attempts, and all 5 late writes from dead workers were rejected.

Rejected options:

- **Lease columns on the task row.** It measured as safe as the attempt row, but the claim and the attempt history end up in two records that must agree.
- **A session advisory lock.** A hung worker held its task forever, and its late write was accepted. Both break the spec.

### Routines are goals that anyone on the team edits in the dashboard

Decided 23 Sep 2026. A routine is a goal in plain words and a schedule. The goal states what to do and where to stop, so a routine has no settings for what it may touch or how far it may go. Definitions live in Postgres. Anyone on the team may add or change a routine with no approval step, because AutoWorker is an internal service. A person can pause a routine, change its schedule, or run it now.

Rejected options:

- **Files in a git repo.** Only engineers could add routines, and a sync job would keep a second copy that can drift.
- **A dashboard form that opens a pull request.** Every author would need GitHub access, and it needs the same sync job.
- **A dashboard form with an approval step.** It adds a review step that an internal service does not need.

### Each repository sets its own merge bar

Decided 23 Sep 2026. A change lands only when it passes the checks its own repository defines, such as lint rules, CI, and actions. The agent finds and follows those checks. AutoWorker applies no coverage threshold of its own.

### History is kept for 180 days and transcripts for 30

Decided 23 Sep 2026. Attempts and evidence are kept for 180 days. Agent transcripts are kept for 30 days, so by the end of a month the transcripts from its first days are already gone.

### The dashboard and the engine are separate services

Decided 23 Sep 2026. The UI and the backend deploy separately, as they do in the current AutoWorker.

## Open

Each open question names the current lean or default. A lean is not a decision.

- **Where the agent runs.** The lean is one Kubernetes Job per attempt, in the engine's namespace. The Job gets no database or Kubernetes API credentials, only its owner's credentials for that run. This matches how the current AutoWorker runs delivery attempts.
- **How the backend is split.** The lean is one engine image run as a few copies, with every copy running all four loops: intake, worker, reaper, and outbox. Extra copies are safe because Postgres refuses a second claim.
- **What the dashboard's Overview shows first.** The lean is what needs the signed-in person, with the pipeline board and the history one click away.
- **When AutoWorker posts to chat.** The default is to post when a task parks as waiting, when a routine is overdue, and once a day as a digest.
- **Where the stage boundaries fall.** The default is to cut where the work changes hands. Specify ends with a written plan, implement with a pushed branch, verify with saved evidence, and land with a merged pull request.
- **Whether housekeeping belongs to the engine.** The proposal is that expiring lost attempts, deleting leftover Jobs, and pruning old history are engine loops rather than routines, so correctness never depends on how a routine is set up.
- **Codex sign-in.** Parked for now.
