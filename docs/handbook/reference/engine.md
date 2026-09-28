# Engine reference

The engine is one program, [services/engine/main.ts](../../../services/engine/main.ts). It reads its settings once, refuses to start on a bad combination, publishes the workflows and Verify providers it runs, serves the bridge endpoint, and then runs every loop until SIGTERM. This page lists its loops, settings, start checks, admin commands, and the person actions it applies. [architecture.md](../architecture.md) explains how the loops work together.

## Loops

Each loop is a `Loop` from [shared/loop.ts](../../../shared/loop.ts), built by a function in its feature folder and listed in `loopsFor` in `services/engine/main.ts`. `runLoop` runs a loop at a fixed rate, logs a failed pass and keeps going, and on SIGTERM lets the current pass finish. A loop with a `resume` runs it before its first pass and again after any pass that fails.

| Loop | Built in | Runs every (default) | Runs when | What one pass does |
| --- | --- | --- | --- | --- |
| `reaper` | `features/tasks/reaper.ts` | `REAPER_EVERY_MS` 30,000 | always | Marks live attempts whose lease lapsed `lost`, and parks a task after 3 lost attempts in a row. `resume` extends every live lease after downtime |
| `requests` | `features/requests/apply.ts` | `REQUESTS_EVERY_MS` 250 | always | Applies open person requests, oldest first per target, one transaction each |
| `scheduler` | `features/routines/scheduler.ts` | `SCHEDULER_EVERY_MS` 10,000 | always | Claims each routine's due slot or Run now press, runs its source, and records tasks |
| `environments` | `features/environments/lifecycle.ts` | `ENVIRONMENTS_EVERY_MS` 30,000 | always | Stops every Verify environment whose attempt has ended |
| `land` | `features/code-change/land-loop.ts` | `LAND_EVERY_MS` 10,000 | always | Reads each task at Land and decides: merged, owe an action, wait, or send back |
| `sweep` | `features/jobs/sweep.ts` | `SWEEP_EVERY_MS` 30,000 | `JOB_IMAGE` is set | Deletes the Jobs and Secrets of finished attempts |
| `outbox` | `features/outbox/perform.ts` | `OUTBOX_EVERY_MS` 1,000 | a performer is registered | Expires lapsed claims, then claims and performs owed actions |
| `checks` | `features/credentials/check-loop.ts` | `CHECKS_EVERY_MS` 60,000 | `CREDENTIAL_KEY` is set | Claims and runs due credential checks, and refreshes Codex logins near expiry |
| `worker` | `features/tasks/worker.ts` | `WORKER_EVERY_MS` 5,000 | the key, `JOB_IMAGE`, and `JOB_ENGINE_URL` are set | Relaunches unlaunched attempts, then claims ready tasks at agent steps and launches their Jobs |

The bridge endpoint is not a loop. It is a listener the engine opens on `BRIDGE_PORT` before the loops start, and closes on SIGTERM.

## Settings

The zod `settings` object in `services/engine/main.ts` reads these environment variables once. Job settings are parsed in `features/jobs/settings.ts`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | The engine's Postgres URL |
| `DATABASE_POOL_SIZE` | 10, at least 2 | Connections in the engine's pool |
| `DATABASE_CONNECT_TIMEOUT_MS` | 10,000 | How long the pool waits to open each Postgres connection |
| `LEASE_MS` | 60,000 | Lease an attempt holds between renewals |
| `ATTEMPT_START_LEASE_MS` | 900,000 | Lease a new attempt holds for its whole start, including the Verify environment |
| `REQUEST_TIMEOUT_MS` | 10,000 | Statement and idle-transaction timeout for each person request |
| `ROUTINE_LEASE_MS` | 300,000 | Lease on a routine run |
| `ENVIRONMENT_START_DEADLINE_MS` | 600,000 | How long a Verify provider may take to start an environment |
| `LAND_READ_TIMEOUT_MS` | 20,000 | Timeout for Land's reads of a pull request |
| `OUTBOX_LEASE_MS` | 60,000 | Lease on a claimed outbox row |
| `OUTBOX_MARGIN_MS` | 5,000 | Time an outbox performer leaves before its lease ends |
| `OUTBOX_MAX_TRIES` | 3 | Tries before an outbox row ends `failed` |
| `CHECK_LEASE_MS` | 300,000 | Lease on a credential check |
| `CHECK_TIMEOUT_MS` | 120,000 | Time limit on one credential check |
| `CREDENTIAL_KEY` | unset | Base64 of exactly 32 bytes that seals credentials. Without it the engine opens and checks nothing |
| `CREDENTIAL_KEY_VERSION` | unset, and required with `CREDENTIAL_KEY` | A whole number from 1 to 999,999,999 stored beside each sealed value |
| `GITHUB_API_URL` | `https://api.github.com` | The GitHub API the engine calls |
| `GIT_BASE_URL` | `https://github.com/` | Where Jobs clone repositories from |
| `JIRA_SITE` | unset | The Jira site. Without it the engine uses the stored assignee, Jira checks return `unknown`, and prompts get no ticket description |
| `JIRA_TIMEOUT_MS` | 30,000 | Timeout for Jira searches and reads |
| `JOB_IMAGE` | unset | The attempt image, by digest. Without it no Jobs launch |
| `JOB_ENGINE_URL` | unset | The address Jobs use to reach the bridge |
| `JOB_NAMESPACE` | `default` | The namespace Jobs run in |
| `JOB_SERVICE_ACCOUNT` | `autoworker-job` | The Jobs' service account, which has no role binding |
| `JOB_DEADLINE_SECONDS` | 14,400 | Each Job's time limit |
| `BRIDGE_PORT` | 4520 | The bridge endpoint's port |
| `BRIDGE_POLL_MS` | 250 | How often the bridge endpoint checks for new commands |
| `BRIDGE_KEEPALIVE_MS` | 5,000 | Keepalive interval on the bridge's streams |
| `BRIDGE_BODY_LIMIT_BYTES` | 64 MiB | Largest request body the bridge accepts |

Each loop also has its `*_EVERY_MS` setting, listed in the loop table.

## Start checks

The engine refuses to start, and says why, when any of these hold:

- `CHECK_LEASE_MS` is not more than `CHECK_TIMEOUT_MS` plus 60,000.
- `ATTEMPT_START_LEASE_MS` is not more than `ENVIRONMENT_START_DEADLINE_MS` plus `CHECK_TIMEOUT_MS` plus 60,000.
- `JOB_IMAGE` is set while `CREDENTIAL_KEY` or `JOB_ENGINE_URL` is missing.
- `CREDENTIAL_KEY_VERSION` is set without `CREDENTIAL_KEY`.
- `CREDENTIAL_KEY` is set but is not base64 of exactly 32 bytes, or `CREDENTIAL_KEY_VERSION` is missing or not a whole number from 1 to 999,999,999. The engine then says "The engine did not start, because its sealing key is wrong."
- A routine's newest version, or a version with an unfinished task, names a workflow that `services/engine/workflows.ts` does not list (`startProblems` in `features/tasks/start.ts`).
- A repository, or an environment nobody has stopped, names a Verify provider the engine was not given.

Then it publishes each workflow's steps to `published_workflow_step` and each provider to `published_provider`, writing only rows that differ, in one transaction per table. The dashboard reads step and provider names only from those tables.

## Plug-in wiring

`services/engine/main.ts` is where a fork swaps a rule. Each value below is typed, so a replacement of the wrong shape fails `npm run typecheck`.

| Value | Type | Core value |
| --- | --- | --- |
| Workflows | the list in `services/engine/workflows.ts` | Code change |
| Agent step plugs | `AgentSteps<K>` per workflow | `features/code-change/stage-output.ts` |
| Run-as rule | `RunAsRule` | `coreRunAs` in `features/tasks/run-as.ts` |
| Review step | `ReviewStep` | `coreReview` in `features/code-change/land.ts` |
| Verify providers | `Provider` objects, by `providersByName` in `services/engine/providers.ts` | `tests-only` |
| Performers | `Performers<ActionKind>`, spread from each connector | GitHub and Jira |
| Sources | `sourcesByKind` | the schedule source and `jira-search` |
| Request handlers | `Handlers<RequestKind>` | one per request kind |

## Admin commands

An admin command is a file in `services/engine/` run with `node`. It parses all of its input with zod before it writes, and prints no secret.

### `setup.ts`

`node services/engine/setup.ts [--replace-logins] <setup file>` needs `DATABASE_URL`, `CREDENTIAL_KEY`, and `CREDENTIAL_KEY_VERSION`. It is idempotent. It matches each record by a natural key, writes only what differs, applies each section in one transaction, and prints one count per section.

The setup file is JSON with these fields. The schema is `fileSchema` in [features/tasks/setup.ts](../../../features/tasks/setup.ts), and the login sources are in [features/credentials/setup.ts](../../../features/credentials/setup.ts).

| Field | Contents |
| --- | --- |
| `admin` | The email of the person recorded as making the changes |
| `people` | Each with `name`, `email`, optional `jiraAccountId`, and `logins` |
| `teamAccounts` | Each with `name`, `email`, and `logins` |
| `repositories` | Each with `github` (`owner/name`), `branch`, and optional `image`, `fastTestCommand`, `setupCommand`, `verifyProvider` (default `tests-only`), `ignorableChecks`, `draftLeaves` (default `when-green`), and `ignoredReviewers` |
| `routines` | Each with `name`, `goal`, `workflow`, `source`, `creator`, optional `runAs`, `repository` (`{github, branch}`), `gates`, `lastStep`, `steps` (per-step `instructions` and `skills`), `everyMinutes` (default 15), `jiraStartStatus`, `jiraEndStatus`, and `ignoreLaterReviews` |

`logins` holds `github` and `codex`, and optionally `jira`. Each names an environment variable as `{"env": "NAME"}` or a file as `{"file": "path"}`, and never holds the secret itself. A Codex login that holds a refresh token needs `"madeForAutoWorker": true`, because the engine's refresh signs out every other copy of that login. A `source` is `{"kind": "jira-search", "jql": "...", "pageSize": n}` or another registered source kind.

Without `--replace-logins`, setup keeps a stored login that expires later than the file's, so it never rolls back a login the engine refreshed.

### `act.ts`

`node services/engine/act.ts <action> <task key or routine name> --as <email> [options]` needs `DATABASE_URL`. It writes a person request and waits up to 10 s for the engine's answer. It exits 3 when the engine has not answered in that time, and the request stays queued. `--id <uuid>` makes a rerun record nothing new.

| Action | Options |
| --- | --- |
| `approve <key>` | `--step <step>` |
| `send-back <key>` | `--step <step> --note <text>` |
| `answer <key>` | `--step <step> --answer <json>` |
| `stop <key>` | none |
| `retry <key>` | optional `--note <text>` |
| `steer <key>` | `--message <text>` |
| `pause <routine>` | none |
| `resume <routine>` | none |
| `run-now <routine>` | none |

`--step` names the review the action answers, so an action never lands on a review its person did not name. An `--answer` is JSON of one of three shapes from [shared/review.ts](../../../shared/review.ts): `{"kind": "pick", "block": n, "option": "id"}`, `{"kind": "untick", "block": n, "items": [...]}`, or `{"kind": "edit", "block": n, "body": "..."}`.

## Person actions

Every person action arrives as a `person_request` row, written by the dashboard or by `act.ts` through `request` in [shared/requests.ts](../../../shared/requests.ts). The `requests` loop applies it, records a `human_action` with the request's id, and writes the answer. The table below is what each one does. The task actions are in `features/tasks/advance.ts` and `features/tasks/decide.ts`, the routine actions in `features/routines/actions.ts`, and the saves in `features/tasks/setup.ts`.

| Action | Allowed when | Effect |
| --- | --- | --- |
| Stop | the task is ready or waiting | Ends any live attempt as `stopped`, and marks the task `stopped`. A stop at a gate keeps the gate's review |
| Retry | the task is ready, stopped, or waiting on anything but an approval | Ends any live attempt, and starts the step again. After a return route's cap, it starts at the step that route returns to. After a stop at a gate, it waits at the gate again. It resets retries, input waits, and lost attempts, and keeps review counters. A note reaches the next attempt |
| Approve | the task waits on an approval or an answer for the named review | At a gate, the task goes on to the next step. After an answer, the asking step runs again |
| Send back | the task waits on the named review | Retries the reviewed step with the person's note in its obligation |
| Answer | the task waits on an approval or an answer for the named review, and the answer fits a block | Records the answer. The task keeps waiting until Approve |
| Steer | an attempt is live and its turn has started | Delivers the message into the running turn |
| Pause and Resume | on a routine | Stops or restarts its scheduled runs |
| Run now | on a routine that is not paused | Runs it once, with the version at the press. One waiting press per routine |
| Save routine | on a routine, or none to create one | Saves a new routine version |
| Save repository | on a repository, or none to create one | Saves the repository's settings |

Stop, Retry, Approve, and Send back end any live attempt and raise the task's epoch, so an older claim is refused as `moved`. Answer and Steer do neither, and the routine and repository actions touch no task. The request kinds and their payloads are `requestKinds` and `payloads` in `shared/requests.ts`.

## Outside actions

Each effect on an outside service is an outbox action kind from [shared/actions.ts](../../../shared/actions.ts), carried out by a connector's performer.

| Kind | Performer | Duplicates |
| --- | --- | --- |
| `ticket.comment` | Jira | Not caught by Jira, so the performer looks for its marker first |
| `ticket.transition` | Jira | Reads the ticket's status first |
| `pr.open-draft` | GitHub | Caught |
| `pr.mark-ready` | GitHub | Caught |
| `pr.evidence` | GitHub | Caught |
| `pr.update-branch` | GitHub | Caught |
| `pr.merge` | GitHub | Caught. It performs only while the task is at Land |
| `branch.advance` | GitHub | Caught |
| `branch.delete` | GitHub | Caught |

A row whose kind has no registered performer is never claimed, and its task stays not ready until a person stops it, which drops the row.

## Log lines that tests read

Scenarios match these engine log lines as text, in `features/tasks/verify.ts`, `features/environments/verify.ts`, `features/jobs/live.ts`, `features/e2e/hold.ts`, and `tools/verify/engine.ts`, which the credentials and tasks scenarios use. Rewording any of them breaks those scenarios:

- `The engine runs`
- `The engine serves the bridge on port`
- `The engine stopped.`
- `reaper: gave `
- `released attempt N of task`
- `reaper: stopped after N passes, 0 of them failed`
- `Postgres restarted at `
- `sweep: `
