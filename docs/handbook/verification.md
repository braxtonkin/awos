# How to prove a change works

`AGENTS.md` asks you to run every change for real and to report the exact commands and what you saw (rule C1), with the one checked-in verification tool (rule C2). This page tells you what each kind of check proves, which checks to run for which change, how to reproduce a bug before you fix it, and how to run local CI before you integrate. [reference/scenarios.md](reference/scenarios.md) lists every scenario.

## Know what each layer proves

AutoWorker proves correctness in layers, and each layer catches a different kind of mistake. Pick the layer that can fail on the mistake you are guarding against.

| Layer | Proves | Where |
| --- | --- | --- |
| Types | Shapes, exhaustive records over a union, and brands that only one function can make | `npm run typecheck` in `npm run check` |
| Static checks | Rules written as code: no comments, import boundaries, no step names in the runner, strict output schemas, budgets | the `npm run check` chain |
| Schema constraints | What must never be stored, refused by Postgres | `db/migrations/`, proved by simulator mutants |
| Models | The protocol is right in every interleaving within its bounds, and each guard is needed | `<Model>.tla`, run by `<name>-model` |
| Simulators | The real code keeps every model property under seeded faults, each predicate can fail, and each constraint matters | `<name>-sim`, with fast gates in `npm test` |
| Feature scenarios | One feature's behavior against real Postgres and fakes | `features/<name>/verify.ts` |
| Lanes | The whole system on kind, with the Codex stand-in or real Codex, or a page in a real browser | `p7-lane`, `jobs-live`, `dashboard-lane` |
| Screens | A page meets the 19 objective gates and two reviewers' scores | `screens`, `screen-review` |
| Live runs | Real Jira, GitHub, and Codex agree with AutoWorker's record | `e2e` in the sandbox world, `e2e-hold` |

Rule C6 sets the balance. Put an invariant where the build or the store enforces it, prove it can fail with a negative control, and check behavior by simulation. Write a unit test only for a pure function a simulation cannot reach, and never one that restates the code.

## Set up once per worktree

1. Build the verify image with `docker compose build verify`. Run it again after any change to `tools/verify/Dockerfile`.
2. Install packages into the worktree's `node_modules` volume with `docker compose run --rm verify npm ci`. Run it again after any change to `package-lock.json`.
3. Run `docker compose run --rm verify npm run verify -- doctor`. It checks that the verify container can start sibling containers.

[operations.md](operations.md) covers a new machine from scratch.

## Run the fast loop while you work

Run `docker compose run --rm verify npm run check` after each meaningful edit. It chains the fast file checks first, then typecheck, lint, and import boundaries, then checks that `shared/db/types.ts` matches a fresh generation, and it stops at the first failure. It takes about five minutes.

Then run the scenarios for the part you changed, from the table below. Heavy checks such as models, simulators with `--mutant all`, and lanes each take minutes to an hour. Run at most two at once on a machine shared with other work, because they compete for CPU and memory.

## Run the checks the change needs

| You changed | Run at least |
| --- | --- |
| Claims, `begin`, `advance`, `decide`, the worker, or the reaper in `features/tasks/` | `tasks-sim --mutant all`, `tasks-sim --profile <the profile your change affects>`, `npm test`, `engine-start`, and `tasks-model` when a route, cap, or guard changed |
| A workflow, a step, or its plug in `features/code-change/` | `code-change`, which compares the declaration to the model's shape, `tasks-sim --mutant all`, which compares the simulator's copy, `codeChangeCopy`, so update that copy too, and `tasks-model` when the shape changed |
| How a rework, Verify, or Land behaves | The lanes that replay each case: `p7-lane <n> --world local` for lanes 11 to 19 |
| Land | `land-sim --mutant all`, `land-model`, and `code-change` |
| The attempt Job or `services/job/` | `jobs`, and `jobs-live <lanes>` on kind |
| The bridge | `bridge-sim --mutant all`, `bridge-model`, and `bridge-live` when the Codex protocol is involved |
| The outbox | `outbox-sim --mutant all`, `outbox-sim --profile all`, and `outbox-model` |
| Person requests | `requests-sim --mutant all`, `requests-sim --profile all`, `requests-model`, and `setup` |
| Routines or the scheduler | `routines-sim --mutant all`, `routines-sim --profile all`, and `schedule-model` |
| Credentials or their checks | `npm test`, which runs `credentials` with its mutants, then `credentials-sim --mutant all`, `checks-model`, `setup`, and `engine-checks` |
| A connector | `github-sim --mutant all` or `jira`, and its live lane when real behavior matters |
| A migration | `migrations`, `npm run db:types` to regenerate `shared/db/types.ts`, the owning feature's `<name>-sim --mutant all` for its catalog, and `dashboard-grants` when grants changed |
| A dashboard page | `npm run check`, then the page's `dashboard-lane`, `screens <group>`, and `task-page-stream` when a stream changed |
| A check in `tools/` | `guardrails`, and the check's own script |
| Anything, before you integrate | Local CI, as below |

## Reproduce a bug before you fix it

Rule D2 asks you to show the failure with the verification tool before you change code. It proves you found the cause, and it leaves a check that keeps the bug fixed.

1. Find the closest existing scenario or lane, and make it fail on the unfixed code. If none exists, add one that fails.
2. Keep its `FAIL` line for your report.
3. Fix the code, and show the same check's `PASS` line.

A failure from a live run usually becomes a lane in the local world with the Codex stand-in, or a new simulator profile or seed. Lanes 16 to 19 were written this way from SBX-66's conflicts and SBX-93's merge-only failure. Lanes 16, 18, and 19 failed before their fixes, and lane 17 is the control that must still park on red checks. The `reproduce` lane of `jobs-live` planted the `/tmp` leak SBX-73 hit before the fix that clears temp. [lessons.md](lessons.md) tells each story, and [operations.md](operations.md#diagnose-a-task-that-waits) shows how to read a live task's record.

A seed that failed and was then fixed goes into the feature's `failed-seeds.ts` with the simulator's fingerprint, so the feature's fast gate in `npm test` replays it. Only the tasks and bridge features keep one today.

## Read a scenario's output

Every scenario prints one line per check:

- `PASS  <name>  (<detail>)` for a check that passed.
- `FAIL  <name>  (<detail>)` for a check that failed. The detail says what was expected and what happened.
- `INFO  <name>  (<observed>: <detail>)` for something reported but not judged, where observed is `passed`, `failed`, or `n/a`. It never fails a run.

The last line counts the checks that passed. The exit code is 0 only when every check passed. A simulator failure also prints the command that replays that seed. On `tasks-sim`, `bridge-sim`, `outbox-sim`, `requests-sim`, and `routines-sim`, `--trace <dir>` writes the seed's full trace as soon as it fails.

## Run local CI before you integrate

The `ci` and `nightly` workflows are disabled on GitHub, so CI runs on the integrating machine. See "CI runs locally while GitHub Actions is disabled" in [docs/decisions.md](../decisions.md#ci-runs-locally-while-github-actions-is-disabled). Integrate a head only when local CI's summary says `PASS`.

1. Commit everything. Local CI refuses a worktree with uncommitted or untracked files.
2. From the worktree's root on the host, run `node tools/ci-local/main.ts`. It needs Node 24 and the repository's packages on the host, as [operations.md](operations.md#install-the-host-tools) describes.
3. It builds the verify image, runs `npm ci` once, then runs the four jobs of `.github/workflows/ci.yml` at the same time: `check`, `models`, `sims`, and `simulation`. It never stops early, and it prints each step's exit code and seconds.
4. Read `ci-local/<sha>/summary.txt`. A job that passes its time ceiling in `budget/budget.json` is stopped and reported. On 8 cores a run took between 32 and 78 minutes in September 2026, depending on what else the machine ran.

To stop a run, use `node tools/ci-local/main.ts --stop` from the same worktree. Never stop it with `kill`, `Stop-Process`, or `taskkill`. Every run has the same command line, so a process list cannot tell whose run it is, and a killed run leaves its containers behind.

Do not edit a worktree while its CI runs, because the verify containers mount it. Build the next change in another worktree.

## Know what local CI does not run

These checks exist but no CI job runs them, so run them yourself when you touch their area:

- `dashboard-grants` and `jobs`.
- Every lane: `p7-lane`, `jobs-live`, `dashboard-lane`, and `dashboard-batch`.
- Every live scenario, which needs real accounts.
- The perf scenarios, such as `reaper-perf`, `outbox-perf`, and `routines-perf`.
- Every other scenario that no CI step names, such as `environments-engine`, `routines-engine`, `screens`, and the dashboard scenarios that run only in `dashboard-batch`. The Local CI column of [reference/scenarios.md](reference/scenarios.md) marks each one.
- The fault profiles of `tasks-sim`, `credentials-sim`, and `github-sim`, apart from the fast gates in `npm test`.
- The nightly model configs and the nightly simulator seeds. The nightly workflow runs only when someone starts it, and only on GitHub.

## Know where the checks fall short of AGENTS.md

A few paved paths in `AGENTS.md` ask for more than the code does today. Treat each as work to finish, not as a pattern to copy:

- `e2e-payload` plants a missing field in 9 of its 18 payload schemas. `jira.created`, `jira.comment`, `github.ref`, `github.refs`, `github.sha`, `github.status`, `github.timeline`, `github.merged`, and `github.readyForReview` have no plant.
- The outbox and credentials features audit their catalogs with checks of their own, `checkCatalog` in `features/outbox/simulate.ts` and the catalog checks in `features/credentials/mutants.ts` and `features/credentials/verify.ts`, rather than with `auditCatalog`.
- No catalog covers `evidence`, `verify_environment`, `published_workflow_step`, or `published_provider`, so a new guard on one of them escapes every audit. [reference/data-model.md](reference/data-model.md) lists their guards.
- `dashboard-grants` is in no batch and no CI job, so it runs only when someone runs it.
- `tools/verify/screens/scope.json` still lists the status card, the agent activity line, the task actions, and the Routines page as later items, although each has shipped, and it has no entry for the `task`, `routines`, and `settings` groups. Reviewers read it with every packet.

## Add a check of your own

Every kind of check has a paved path in `AGENTS.md`, and [extending.md](extending.md#add-a-check) walks through each one. The rule that ties them together is that a check must be shown able to fail. A new static check gets a guardrail case that plants a violation. A model guard gets a mutant. A simulator predicate gets a plant. A schema constraint gets a store mutant, or an entry in `noMutantYet` with its reason.
