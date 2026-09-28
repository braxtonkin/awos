# Verification scenarios

Every check in AutoWorker is a scenario of the one verification tool, run as `npm run verify -- <name> [args]`. This page lists every scenario, what it proves, what it needs to run, and whether local CI runs it. [verification.md](../verification.md) explains how to choose and run them.

The tool is [tools/verify/main.ts](../../../tools/verify/main.ts). It finds each feature's scenarios by loading `features/<name>/verify.ts`, so a scenario needs no registration beyond its export. It prints one `PASS` or `FAIL` line per check and an `INFO` line for anything reported but not judged. It exits non-zero when any check fails, when the scenario throws, or when it produced no check at all. An unknown name prints the full list and exits 2.

## How to run a scenario

| Needs | Run it with |
| --- | --- |
| Nothing but Node | `docker compose run --rm verify npm run verify -- <name>` |
| Postgres | The same command. The tool starts Postgres as a sibling container, so the scenario must run inside the verify container |
| Java | The same command. TLC and Java 21 are in the verify image |
| A browser | The same command. The verify image carries a pinned Chromium headless shell |
| The kind cluster | `docker compose run --rm verify sh -c 'npm run verify -- kind up && exec node tools/verify/main.ts <name> [args]'` |
| Real accounts | `docker compose run --rm live npm run verify -- <name>`, with `kind up &&` first when it needs the cluster too |

The `live` service loads `~/.autoworker/sandbox.env` and mounts `~/.autoworker/codex/` read-only, as [operations.md](../operations.md) describes. Never run `docker compose config` or print a `live` container's environment, because both show the sandbox values.

## Repository-wide scenarios

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `guardrails` | Every check rejects its planted violations and accepts its allowed cases, across three copies of the repository | Postgres, a browser, Java, git | `check` job |
| `doctor` | Node 24, the Docker API, and sibling containers work from the verify container, and nothing was left behind | Docker | `check` job |
| `migrations` | Each migration applies, rolls back to the exact schema before it, and all apply again | Postgres | `simulation` job |
| `kind` | `up` creates or reuses the `autoworker` cluster, `status` reports it, `down` deletes it for every worktree | Docker | no |
| `accounts` | The four sandbox keys are set and well formed, the mounted Codex login has no refresh token, and Jira and GitHub accept the tokens. It prints no value | Real accounts | no |
| `models` | Runs every `*-model` scenario, passing on its arguments, such as `nightly` | Java | `models` job |
| `sims` | Runs every `*-sim` scenario, passing on its arguments, such as `--mutant all`. `sims nightly --shard k/n` runs share k of n of every simulator's nightly runs | Postgres | `sims` job, with `--mutant all` |
| `dashboard-grants` | The `dashboard` role holds exactly the privileges in `tools/verify/dashboard-grants.json`, and a planted ciphertext grant is caught | Postgres | **no**, and in no batch |

## Models

Each model scenario reviews its configs, runs TLC on the real config, which must hold, then runs each mutant, which must fail. `--mutant <guard>` runs one guard's mutants, and `nightly` checks the nightly config, which is larger for every model but `checks-model`.

| Scenario | Model | What it covers |
| --- | --- | --- |
| `tasks-model` | `features/tasks/Tasks.tla` | Claims, leases, steps, routes, caps, gates, reviews, person actions, and rework obligations |
| `land-model` | `features/code-change/Land.tla` | Land's decisions against checks, reviews, the merge queue, and outbox rows |
| `bridge-model` | `features/bridge/Bridge.tla` | Event and command delivery between a Job and the engine |
| `outbox-model` | `features/outbox/Outbox.tla` | Claiming and performing outside actions once, in order |
| `requests-model` | `features/requests/Requests.tla` | Applying person requests once, in order per target |
| `schedule-model` | `features/routines/Schedule.tla` | Routine slots, Run now, catch-up, pause, and one task per ticket |
| `checks-model` | `features/credentials/Checks.tla` | Credential checks, refreshes, and write-backs |

## Simulators

Each simulator runs the feature's real code with seeded actors on a virtual clock, injects faults, and checks every model property after every step. `--mutant all` proves that each mutant is reported. Most simulators also prove their plants and audit their catalog there. `requests-sim` and `routines-sim` prove their plants in their profile runs, `environments-sim` has no catalog check, and `land-sim` has neither plants nor a catalog. The five simulators with profiles skip them under `--mutant all`, and `--profile all` runs them.

| Scenario | Profiles | Local CI |
| --- | --- | --- |
| `tasks-sim` | `default`, `races`, `hangs`, `verdicts`, `people`, `reviews`, `needs-input`, `mixed`, `behavior`, `environment`, `conflicts`, `crashes`, `db-pause`, `two-engines`, `jobs` | `--mutant all` only. `npm test` runs `mixed`, `verdicts`, and `reviews` in its fast gate. The nightly runs every profile except `crashes`, `db-pause`, and `two-engines`, which run only by hand |
| `land-sim` | one | `--mutant all` |
| `bridge-sim` | one | `--mutant all`, and a plain run |
| `outbox-sim` | `mixed`, `crashes`, `two-engines`, `always-fails`, `skewed`, `late` | `--mutant all` and `--profile all` |
| `requests-sim` | `default`, `two-engines`, `crashes`, `failures`, `races` | `--mutant all` and `--profile all` |
| `routines-sim` | `default`, `two-engines`, `downtime`, `pause`, `hangs`, `run-now`, `shared-key`, `assignee` | `--mutant all` and `--profile all` |
| `environments-sim` | `default`, `crashes` | `--mutant all`, `--mutant all --profile crashes`, and `--profile all` |
| `credentials-sim` | one, with three checkers | `--mutant all` |
| `github-sim` | one | `--mutant all` |

Every simulator takes `--seeds`, `--seed`, `--steps`, and `--mutant`, and refuses a flag it does not know. `--profile` works on the five with profiles. `--from` works on all but `bridge-sim`, `environments-sim`, and `github-sim`. `--trace <dir>`, which writes a failing seed's full trace, works on `tasks-sim`, `bridge-sim`, `outbox-sim`, `requests-sim`, and `routines-sim`. `land-sim` also takes `--tasks`, and `credentials-sim` takes `--checkers`. A failure prints the command that replays it.

## `npm test`

`npm test` runs `vitest run --dir features`, excluding the sandbox. It holds the simulators' fast gates, `simulate.test.ts` in every simulated feature except `code-change`, which run fixed seeds, and the tasks and bridge gates also replay every seed in their `failed-seeds.ts`. It also runs `features/credentials/store.test.ts`, `features/credentials/seal.test.ts`, and `features/e2e/lanes.test.ts`. Local CI runs it in the `simulation` job.

## Feature scenarios

### Tasks and the engine

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `engine-start` | The engine publishes its workflows and providers, restarts idempotently, refuses an unknown workflow and missing settings, idles, stops cleanly on SIGTERM mid-pass, and survives a Postgres restart | Postgres | `simulation` |
| `tasks-seed` | Writes a past task story into a database through `begin`, `claim`, and `advance`, then reads it back | a database | no |
| `reaper-perf` | The reaper releases 100 expired attempts in one pass within 1 s | Postgres | no |
| `routines-engine` | The real engine runs routines for 3 minutes | Postgres | no |
| `routines-perf` | The scheduler handles 100 routines per pass within 1 s | Postgres | no |
| `outbox-perf` | The outbox performs at least 50 rows a second | Postgres | no |

### Code change and Land

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `code-change` | The workflow's declaration matches the shape the task model checks, each step's judge gives the right verdict for every outcome, and each prompt is built right | nothing | `simulation` |
| `land-live` | Always fails with "PARKED: gate 1". It is a placeholder | nothing | no |

### Jobs, the bridge, and Verify environments

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `jobs` | The launcher's invariants, and that the attempt image and the verify image pin the same base image and Codex version | Postgres | **no** |
| `jobs-live` | Jobs on kind, pulled by digest. Lanes include `ready`, `no-kube`, `reproduce`, `sweep`, and others. Name lanes, or `all` | kind, Postgres, and real accounts, `GITHUB_TOKEN` and the mounted Codex login, so it runs in the `live` service | no |
| `bridge-live` | The real `codex app-server` through the bridge, with lanes such as `outage`, `steer`, `stop`, and `late-push` | Postgres, real Codex | no |
| `launch-faults` | The worker against a fake Kubernetes API that fails launches | Postgres | `simulation` |
| `environments-live` | The `tests-only` provider | Postgres | no |
| `environments-engine` | The engine refuses an unknown provider | Postgres | no |
| `environments-perf` | Stopping 100 environments, five times | Postgres | no |

### Credentials and connectors

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `credentials` | The sealed store, its grants, replays, refusals, and that a dump holds no secret. `--mutant all` proves every guard and missing privilege | Postgres | through `npm test` |
| `engine-checks` | The engine's check loop against a fake GitHub, and its refusals of bad keys and settings | Postgres | `simulation` |
| `setup` | `services/engine/setup.ts` as a child process: refusals, idempotence, logins kept or replaced, and no secret printed | Postgres | `simulation` |
| `codex-check` | The Codex check on the mounted access-only login | real Codex | no |
| `github-check` | The GitHub check against a fake, or against the real API with `--live` | none, or real GitHub | no |
| `jira` | The Jira source and performers against a local fake, with a marker-less negative control | nothing | `simulation` |
| `jira-live` | The Jira connector against the sandbox project. Needs `JIRA_PROJECT` | Postgres, real Jira | no |
| `github-live` | Reads real pull requests | Postgres, real GitHub | no |

### Dashboard

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `screens <group>` | Captures each screen of a group, or `all`, at 1440 by 900 in both themes, and judges the 19 gates | kind, Postgres, a browser | no |
| `screen-gates` | The gates judge the frozen fixtures correctly, and captures are stable and fast enough | a browser | through `guardrails` |
| `screen-review <group>` | Writes a review packet, or with `--judge` checks the returned reviews | a browser and a world, unless `--fixtures` or `--judge` | through `guardrails` |
| `dashboard-lane <unit> <lane>` | Runs named browser lanes, or `all`, against a local engine world | kind, Postgres, a browser | no |
| `dashboard-batch` | Every screen group, batch scenario, lane, and engine check, once | kind, Postgres, a browser | no |
| `task-page-stream` | The task page's stream frames reduce to the stored transcript across a reconnect | Postgres | batch only |
| `review-answers` | Each answer kind the page sends, sent through `request`, is recorded as its action, and an answer to a missing block is refused. It needs an existing dashboard build and opens no browser | kind, Postgres | batch only |
| `overview-read` | The Needs you read, with a plant | Postgres | batch only |
| `login-never-shown` | A replaced login never appears on a page or in a log | kind, a browser | batch only |
| `repository-form` | The repository form parses | nothing | batch only |

### End to end

| Scenario | What it proves | Needs | Local CI |
| --- | --- | --- | --- |
| `e2e` | A ticket goes to a merged pull request and a clean record. Flags choose the driver, world, agent, fault, and number of runs | kind. The sandbox world also needs real accounts | no |
| `p7-lane <n>` | One numbered end-to-end lane. Lanes 11 to 19 need `--world local` | as `e2e` | no |
| `e2e-world` | The local fakes drive a change to a merge and to Done | kind | no |
| `e2e-branch` | Creates an `e2e/run-*` branch | real GitHub | no |
| `e2e-payload` | Nine of the 18 payload schemas reject a planted missing field by name. The other nine have no plant yet | nothing | `simulation` |
| `e2e-clean` | The clean check finds each planted leftover | kind, Postgres | no |
| `e2e-report` | The run report renders to a fake Jira | Postgres | `simulation` |
| `round-trip` | Send-back, outage, stop, and retry round trips on kind, and one with real Codex | kind, Postgres, and the mounted Codex login for the `real` part, which runs by default | no |
| `stand-in-solutions` | The Codex stand-in solves every catalog entry, and every identity solution fails | the npm registry | `simulation` |
| `local-engine` | Holds a local world with named seeds for browser lanes and people | kind, Postgres | no |
| `local-engine-read` | Reads a held world | a database | no |
| `e2e-hold` | Holds AutoWorker against a repository with a kept database | kind, and real accounts in the sandbox world | no |
| `p3-parked` | Always fails with "PARKED: gate 1". It is a placeholder | nothing | no |

## What local CI runs

Local CI runs the four jobs of `.github/workflows/ci.yml`. `check` runs `npm run check`, `guardrails`, `doctor`, and the budget's range check. `models` runs `models`. `sims` runs `sims --mutant all`, then the fault profiles of the environments, outbox, routines, and requests simulators, and a plain `bridge-sim`. `simulation` runs `migrations`, `npm test`, `engine-checks`, `engine-start`, `setup`, `code-change`, `jira`, `e2e-report`, `launch-faults`, `e2e-payload`, and `stand-in-solutions`. Everything else on this page runs by hand, or in `dashboard-batch`.
