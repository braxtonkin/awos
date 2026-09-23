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

### The agent view lives inside running work

Decided 23 Sep 2026. The live view of an agent, where a person watches each step and sends it messages, is a panel on the page of an in-progress routine or task. It is not the dashboard's first view or a page of its own.

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

- **What the dashboard's Overview shows first.** The lean is what needs the person picked, with the pipeline board and the history one click away.
- **When AutoWorker posts to chat.** The default is to post when a task parks as waiting, when a routine is overdue, and once a day as a digest.
- **Where the stage boundaries fall.** The default is to cut where the work changes hands. Specify ends with a written plan, implement with a pushed branch, verify with saved evidence, and land with a merged pull request.
- **How stored credentials behave without sign-in.** The proposal is that a stored credential can be replaced but never shown back, so switching to someone else's identity cannot reveal their token.
- **How the engine reaches the app server.** The lean is a small bridge inside the Job that runs the app server over its standard input and output and connects out to the engine. It numbers every event and resends any the engine has not stored, so an engine restart loses nothing, and the Job listens on no port. The prototype instead had the engine connect to a WebSocket port in the Job, guarded by a token made for that attempt. That needs traffic into Job pods, and reading the Codex source found no replay of events a disconnected client missed.
- **Codex sign-in.** Parked for now. The app server ignores the `CODEX_API_KEY` variable that `codex exec` reads, so it signs in from `auth.json` or through a sign-in call in its protocol.
