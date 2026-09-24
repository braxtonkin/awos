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

Decided 23 Sep 2026. A routine is a goal in plain words and a schedule. The goal states what to do and where to stop, so a routine has no settings for what it may touch or how far it may go. Definitions live in Postgres. Anyone on the team may add or change a routine with no approval step, because AutoWorker is an internal service. A person can pause a routine, change its schedule, or run it now.

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

If a fault loses a task's approvals at Land, the task keeps its place without them. A later return to Implement does not restore them, so the task cannot merge until a person approves each missing gate again. A gate at or after the return point comes back through Approve on the way to Land. A gate before it never comes back, so Land parks the task and asks a person to stop it. The task model records each lost approval as missing. Its invariant `ApprovalsMatchGatesPassed` then says a task's approvals are exactly the gates it has passed, minus those missing, and a gate stays missing until a return sends the task back to or before it.

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

Rejected options:

- **Fields each routine defines.** Anyone can edit a routine, one wrong field fails every attempt, and the engine can't act on fields it doesn't know.
- **A view per step kind.** Every new step kind would need its own page code and its own answer handling.

### Review feedback comes back once, as a whole review

Decided 23 Sep 2026. Land acts on a whole submitted review rather than on single comments, and returns the task to Implement at most once, with every comment as its input. After that round, a routine chooses whether later reviews wait for a person or are ignored, because later rounds tend to be nits and noise. When they are ignored, AutoWorker carries on toward Land, and GitHub's own rules still decide whether the pull request can merge. A repository can list reviewers whose reviews are always ignored, such as review bots. Formally dismissing someone's review on GitHub stays out of the core, because it overrides a reviewer, and a fork can add it.

Rejected options:

- **Answer every review, up to the stage caps.** Where an approval must follow the last push, each round costs the reviewer another approval.
- **Never answer, and always wait.** Small fixes would wait on people too.

### Each repository chooses when a draft leaves draft

Decided 23 Sep 2026. Implement opens its pull request as a draft, and GitHub can't merge a draft, so Land marks it ready. Ready is GitHub's signal to reviewers, and when AutoWorker flips it is a per-repository setting. By default it waits until every check that ran on the head is green, apart from checks the repository marks as ignorable, and a red check returns the work to Implement within the caps. A repository can instead mark the draft ready without waiting for green checks, because in some repositories a red pull request in review is fine. AutoWorker never asks anyone for a review itself.

Rejected option:

- **One rule for every repository.** Review customs differ between repositories, and a generic core can't know them.

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

Decided 23 Sep 2026. Claims and leases, the stage machine with its Verify loop, the outbox, the bridge's event delivery, and the routine schedule each get a TLA+ model, checked with TLC. A model is written before the code it covers, so it checks the design while the design is still cheap to change. It runs in CI whenever the model or that code changes. The repository's verification skill, generated with `/create-verification-skill` once the engine runs, includes the models and the command that checks them. Each night, TLC also checks the task model at 2 tasks and 2 workers at the real caps. On 23 Sep the owner added a second nightly size of 3 tasks and 2 workers, at caps of 2 with 1 person action, for the safety properties only, so that tasks compete for workers.

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

## Open

Each open question names the current lean or default. A lean is not a decision.

- **What the dashboard's Overview shows first.** The lean is what needs the person picked, with the pipeline board and the history one click away.
- **When AutoWorker posts to chat.** The default is to post when a task parks as waiting, when a routine is overdue, and once a day as a digest.
- **Whether outbox rows need a claim.** The data model draft has no claim on outbox rows, and Jira comments and chat posts are not idempotent on the other side. The outbox's TLA+ model settles this before the outbox is built.
- **When sign-in becomes necessary.** Runs now carry personal logins, so picking a person runs an agent with that person's GitHub token and ChatGPT account. The lean is to add sign-in before the first run with real personal credentials.
- **How a person gives AutoWorker a Codex login.** The lean is a Connect button that has the engine run `codex login --device-auth` and show the person its link and code, so the login is made for AutoWorker by construction.
- **How a worker that keeps stalling loses its task.** The TLA+ model in `features/tasks/` assumes that a lease that keeps lapsing is reaped at one of its lapses, which it states as strong fairness for the reaper. Nothing guarantees that yet, and the reaper's ticket, AUTO-10, picks the mechanism.
