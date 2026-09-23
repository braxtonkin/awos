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

### The agent view lives on each task's page

Decided 23 Sep 2026. The view of an agent is a panel on the page of a routine or task. It is not the dashboard's first view or a page of its own. Opening a task, whether it is running or done, shows its own page with that panel and how long the task took from start to merge. While the task runs, the panel streams each step and takes a message that changes the agent's course or stops it. Once the task is done, the same panel replays what the agent did, read-only, for as long as transcripts are kept. After 30 days the panel says the transcript has expired, and the task's attempts and evidence stay for their 180 days. The owner added the replay on finished tasks the same day.

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

### Verify runs in an environment faithful to production

Decided 23 Sep 2026. By default, Verify starts a pod that matches the product's real environment as closely as it can, reproduces the bug or exercises the feature there, and saves evidence such as a video. A repository can define its own way to verify, as it defines its own merge bar.

### Stages hand off at artifacts, and a failed Verify returns to Implement

Decided 23 Sep 2026. Each stage ends with something the next one starts from: Specify with a written plan, Implement with a draft pull request, Verify with saved evidence, and Land with a merged pull request. A failure costs one stage. What happens inside a stage comes from the routine's goal and the repository. When Verify finds the behavior still wrong, the task goes back to Implement with Verify's evidence, and Implement pushes a fix to the same pull request. When only Verify's environment fails, Verify runs again on its own. After 3 rounds without a pass, the task waits for a person, with exact instructions.

Rejected options:

- **Implement ends with a pushed branch.** Most repositories run CI on pull requests, so their checks would first run in Land, after Verify had passed.
- **Retry Verify on every failure.** A retry cannot fix behavior that is still wrong.

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

Decided 23 Sep 2026. Claims and leases, the stage machine with its Verify loop, the outbox, the bridge's event delivery, and the routine schedule each get a TLA+ model, checked with TLC. A model is written before the code it covers, so it checks the design while the design is still cheap to change. It runs in CI whenever the model or that code changes. The repository's verification skill, generated with `/create-verification-skill` once the engine runs, includes the models and the command that checks them.

Rejected options:

- **Lean.** It proves a property for every input, but each proof costs far more effort, and this design's risks are races between processes, which TLA+ checks directly.
- **No formal methods.** The prototypes checked one run of each race. A model checks every ordering of steps within its bounds.

### The engine checks and refreshes every credential

Decided 23 Sep 2026. Each kind of connector comes with a check that proves a stored credential still works. The engine runs the checks where the credentials are stored, as the current AutoWorker does in its parent pod, and a Job inherits only what it needs. For Codex, the check runs `codex exec` on a cheap model with a prompt that must be answered `ack`. Codex refreshes its own login during a check when the access token has 5 minutes or less left, and the engine seals the refreshed login back. A Job gets a copy with the refresh token removed, so it can never refresh. Codex rereads its login file before it refreshes, so a running Job can pick up a newer copy from the engine. A check is claimed like an attempt, so two engine copies never refresh one login at once. Each person gives AutoWorker a login made for it, because a refresh by the engine signs out every other copy of the same login.

The evidence comes from throwaway prototypes against Codex CLI 0.156.0:

- A copy of a login with its refresh token blanked ran a full app server turn and was never rewritten.
- The check replied `ack` in 16.7 s and sent 13,528 input tokens, 11,008 of them cached. On a copy with a broken signature it failed after 22.9 s with a 401.
- Codex's source refreshes early only in the last 5 minutes, and rereads its file before it refreshes after a 401. That part was read, not run.

Rejected options:

- **A Job refreshes its own copy.** A refresh token works once, so a Job's refresh would sign out every other copy, and two Jobs refreshing at once would race.
- **The engine calls OpenAI's refresh endpoint itself.** It is undocumented, and it would be a second implementation of Codex's login.

### Every task works in one repository

Decided 23 Sep 2026. A routine names the repository its work happens in, and each task copies that repository when the routine finds it. Every attempt then knows what to clone before its agent starts, and a task's repository never changes while it runs. The schema holds this as a rule and refuses a task with no repository. For now the only repository is AutoWorker's own. Repositories are rows of their own, since several routines will share one, and facts about a repository, such as its default branch, belong in one place.

Rejected options:

- **A setting in the engine's configuration.** It would be a second record beside Postgres, and it allows one repository per deployment.
- **A repository found per task at intake.** Intake would have no default and nothing to enforce.
- **The agent chooses.** The pod clones the repository before the agent starts.

### Invariants live in structure, and behavior is checked by simulation

Decided 23 Sep 2026. The owner's experience is that unit tests for models do little, and that simulating behavior finds far more. Each invariant lives where the build or the store enforces it, in a type, a schema constraint, or a TLA+ property. A negative control proves it can fail, such as a planted violation or a mutant that drops a constraint. Behavior is checked by running the real code in a seeded simulation against real Postgres. The simulation injects faults such as crashes, hangs, and bursts of concurrent claims, and checks every invariant after each step, under the same names the TLA+ model uses. A seed replays a failing run. A unit test is kept only for a pure function whose logic a simulation cannot reach. AGENTS.md records this as C6.

Rejected options:

- **A unit test per function or table row.** It restates the code, so it still passes when the code is wrong, and it blocks honest edits to the value it pins.
- **Port the data model draft's 87 checks as unit tests.** Most restate a constraint Postgres already enforces. A mutant per constraint shows each constraint is load-bearing, and the simulation exercises it under concurrency.

### An end-to-end test proves ticket to merge on sandboxes

Decided 23 Sep 2026. Before AutoWorker works on itself, a test proves the whole path on sandboxes. It files a ticket in a sandbox Jira space, and AutoWorker takes the ticket to a merged pull request in a private sandbox repository, running the real agent with the owner's Codex login. The test checks each step against Jira, GitHub, and AutoWorker's own record rather than trusting AutoWorker's report, and posts a timeline with links and evidence to the ticket. Its harness is built first and reports how far a ticket gets, so each later PR shows its progress toward the whole path. Webex joins once the call on chat posts is made.

Rejected options:

- **Fakes of Jira and GitHub.** They run free in CI and may come later for that, but a demonstration needs the real services' behavior, such as Jira's workflow and GitHub's checks.
- **Wait for AutoWorker to deliver its own changes.** That stays the final bar. A sandbox lets a failed run cost nothing, and the test can run as often as needed.

## Open

Each open question names the current lean or default. A lean is not a decision.

- **What the dashboard's Overview shows first.** The lean is what needs the person picked, with the pipeline board and the history one click away.
- **When AutoWorker posts to chat.** The default is to post when a task parks as waiting, when a routine is overdue, and once a day as a digest.
- **Who starts Verify's environment pod.** The lean is the engine, so attempt Jobs keep no Kubernetes API access.
- **Whether outbox rows need a claim.** The data model draft has no claim on outbox rows, and Jira comments and chat posts are not idempotent on the other side. The outbox's TLA+ model settles this before the outbox is built.
- **How much of each agent run to keep.** The lean is to keep streamed text only until its step finishes. On the lab's own event log, streamed fragments were 76% of stored events and added no content once their step finished.
- **How the engine reaches the app server.** The lean is a small bridge inside the Job that runs the app server over its standard input and output and connects out to the engine. It numbers every event and resends any the engine has not stored, so an engine restart loses nothing, and the Job listens on no port. The prototype instead had the engine connect to a WebSocket port in the Job, guarded by a token made for that attempt. That needs traffic into Job pods, and reading the Codex source found no replay of events a disconnected client missed.
- **Whose credentials a run uses.** The spec names the ticket's assignee, and the owner described the person who launched the run. A scheduled run has no launcher, so a routine needs an owner either way. The lean is that a routine's runs use its owner's credentials, and a task starts owned by its routine's owner.
- **When sign-in becomes necessary.** Runs now carry personal logins, so picking a person runs an agent with that person's GitHub token and ChatGPT account. The lean is to add sign-in before the first run with real personal credentials.
- **How a person gives AutoWorker a Codex login.** The lean is a Connect button that has the engine run `codex login --device-auth` and show the person its link and code, so the login is made for AutoWorker by construction.
- **Which goal version an attempt follows.** The data model draft uses the latest version at claim time, so a goal fixed before a retry applies to the retry.
- **Whether a task key is unique per routine or across routines.** The data model draft makes it unique per routine. The cost is that two routines can put two agents on one ticket at once.
