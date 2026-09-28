# Settled decisions by area

This index lists all 75 settled decisions in [docs/decisions.md](../../decisions.md), grouped by the part of AutoWorker they shape. Each line says what the decision settles, and each link opens the full entry with its reasons and the options that lost. `AGENTS.md` asks you not to reopen a settled decision without new evidence, so find the relevant one here before you change how a part behaves. Three of them are decided but not built yet, and are marked **Not built**.

## Scope and the shape of the system

| Decision | What it settles |
| --- | --- |
| [AutoWorker is a generic core that a company forks](../../decisions.md#autoworker-is-a-generic-core-that-a-company-forks) | Company rules live in per-repository settings and plug-ins, never in the core |
| [The backend is one engine program](../../decisions.md#the-backend-is-one-engine-program) | Every loop runs in `services/engine/main.ts`, not one service per loop |
| [Housekeeping is part of the engine](../../decisions.md#housekeeping-is-part-of-the-engine) | Sweeps and releases are engine loops, not routines |
| [The dashboard and the engine are separate services](../../decisions.md#the-dashboard-and-the-engine-are-separate-services) | They deploy separately and talk only through Postgres. Both hold the sealing key |
| [History is kept for 180 days and transcripts for 30](../../decisions.md#history-is-kept-for-180-days-and-transcripts-for-30) | Retention periods. **Not built**: nothing prunes |

## Tasks, claims, and leases

| Decision | What it settles |
| --- | --- |
| [Workers claim a task by inserting an attempt row](../../decisions.md#workers-claim-a-task-by-inserting-an-attempt-row) | A partial unique index allows one live attempt per task, and three lost attempts in a row park it |
| [A lapsed lease cannot be renewed](../../decisions.md#a-lapsed-lease-cannot-be-renewed) | Only an unlapsed lease renews, with one grace per engine start |
| [The attempt start lease outlasts the whole start instead of being renewed during it](../../decisions.md#the-attempt-start-lease-outlasts-the-whole-start-instead-of-being-renewed-during-it) | `ATTEMPT_START_LEASE_MS`, 900 s by default, covers the whole start |
| [A new attempt continues a lost one's work](../../decisions.md#a-new-attempt-continues-a-lost-ones-work) | It starts from the lost attempt's last push |
| [A stopped task can be resumed](../../decisions.md#a-stopped-task-can-be-resumed) | Stop is not final. Retry resumes it |
| [A ticket gets one task across all routines](../../decisions.md#a-ticket-gets-one-task-across-all-routines) | A task key is unique across every routine |
| [A task works in one repository when a step needs one](../../decisions.md#a-task-works-in-one-repository-when-a-step-needs-one) | The routine names the repository |

## Workflows, steps, and failure routes

| Decision | What it settles |
| --- | --- |
| [A routine picks a workflow, and code defines each workflow's steps](../../decisions.md#a-routine-picks-a-workflow-and-code-defines-each-workflows-steps) | Steps are code, workflows are chosen by name, and the runner names neither |
| [Stages hand off at artifacts, and a failed Verify returns to Implement](../../decisions.md#stages-hand-off-at-artifacts-and-a-failed-verify-returns-to-implement) | A plan, a draft pull request, evidence, then a merged pull request, with the first caps |
| [An agent step ends with a review a person can answer](../../decisions.md#an-agent-step-ends-with-a-review-a-person-can-answer) | Every agent step replies with a typed review of blocks |
| [A request for help says exactly what to do](../../decisions.md#a-request-for-help-says-exactly-what-to-do) | A waiting task states the action a person must take |
| [Retry after a Stop at a gate resumes waiting at the gate](../../decisions.md#retry-after-a-stop-at-a-gate-resumes-waiting-at-the-gate) | Retry does not rerun a gated step |
| [Retry after a return cap starts again where the failure returns](../../decisions.md#retry-after-a-return-cap-starts-again-where-the-failure-returns) | For example, a Verify cap retries from Implement |
| [A person's note on Retry or Send back reaches the agent](../../decisions.md#a-persons-note-on-retry-or-send-back-reaches-the-agent) | Notes travel in the rework obligation |
| [A rework owes what sent it back](../../decisions.md#a-rework-owes-what-sent-it-back) | A typed obligation from `begin`, and an unmet one ends the step |
| [A conflict rework merges the base head its claim read](../../decisions.md#a-conflict-rework-merges-the-base-head-its-claim-read) | The Job starts the merge before the turn |
| [A conflict has its own verdict and its own count](../../decisions.md#a-conflict-has-its-own-verdict-and-its-own-count) | `conflict`, counter `conflicts`, cap 10, apart from failed checks |
| [A check rework starts from the tree CI tested](../../decisions.md#a-check-rework-starts-from-the-tree-ci-tested) | A check rework merges the current base first |

## Land and merging

| Decision | What it settles |
| --- | --- |
| [Land runs in the engine, and hands each action it owes to the outbox](../../decisions.md#land-runs-in-the-engine-and-hands-each-action-it-owes-to-the-outbox) | A rules table decides, and an owed action ends the attempt `handed_off` |
| [Each repository sets its own merge bar](../../decisions.md#each-repository-sets-its-own-merge-bar) | The repository's rulesets and checks decide, and AutoWorker adds no bar |
| [Each repository chooses when a draft leaves draft](../../decisions.md#each-repository-chooses-when-a-draft-leaves-draft) | `draft_leaves` is `when-green` or `at-once` |
| [Review feedback comes back once, as a whole review](../../decisions.md#review-feedback-comes-back-once-as-a-whole-review) | The first requested-changes review sends the task back once. A later one parks the task, or waits for the pull request to become mergeable when the routine ignores later reviews |
| [Stop does not recall a pull request from the merge queue](../../decisions.md#stop-does-not-recall-a-pull-request-from-the-merge-queue) | There is no dequeue action |
| [Land's rules for a lagging branch or draft sit outside Land.tla](../../decisions.md#lands-rules-for-a-lagging-branch-or-draft-sit-outside-landtla) | Those rows are not modeled yet |

## Verify and evidence

| Decision | What it settles |
| --- | --- |
| [Verify runs in an environment faithful to production](../../decisions.md#verify-runs-in-an-environment-faithful-to-production) | Providers are per repository, and the core ships `tests-only` |
| [Verify proves a change with one reproduction, run before and after](../../decisions.md#verify-proves-a-change-with-one-reproduction-run-before-and-after) | The Job runs the agent's script as `reproduce` on the base and on the change |
| [Only a person contests Verify's evidence](../../decisions.md#only-a-person-contests-verifys-evidence) | No route for a rework to contest Verify, and no Verify-only rerun |

## Jobs, agents, and the bridge

| Decision | What it settles |
| --- | --- |
| [Each attempt runs in its own Kubernetes Job](../../decisions.md#each-attempt-runs-in-its-own-kubernetes-job) | Not a subprocess, and not a warm pool |
| [Each attempt's Job has a time limit](../../decisions.md#each-attempts-job-has-a-time-limit) | `JOB_DEADLINE_SECONDS`, 4 hours by default |
| [Agents run under the Codex app server](../../decisions.md#agents-run-under-the-codex-app-server) | A pinned `codex app-server`, using only its stable methods |
| [Agents run with full permissions](../../decisions.md#agents-run-with-full-permissions) | Approval `never`. The Job is the boundary |
| [Agents reach the engine through a bridge in the Job](../../decisions.md#agents-reach-the-engine-through-a-bridge-in-the-job) | The Job calls out to the engine, not the reverse |
| [Streamed text is kept only until its step finishes](../../decisions.md#streamed-text-is-kept-only-until-its-step-finishes) | Fragments are pruned once their item completes |
| [The engine stores a NUL character from the bridge as U+FFFD](../../decisions.md#the-engine-stores-a-nul-character-from-the-bridge-as-ufffd) | Postgres text cannot hold NUL |
| [The core ships one public Job image](../../decisions.md#the-core-ships-one-public-job-image) | A repository may extend it, and private registries belong to a fork |
| [The setup command runs before Implement's and Verify's turns](../../decisions.md#the-setup-command-runs-before-implements-and-verifys-turns) | It runs as `codex` in the bridge's before-turn step |
| [Each repository ignores its own scratch files](../../decisions.md#each-repository-ignores-its-own-scratch-files) | The Job commits what the workspace holds |
| [AutoWorker checks each repository before it works there, and takes skills from the clone](../../decisions.md#autoworker-checks-each-repository-before-it-works-there-and-takes-skills-from-the-clone) | Prompts name each routine skill by its path in the clone. **Not built**: the repository check, the skill check before a claim, and the record of skill versions |

## Routines

| Decision | What it settles |
| --- | --- |
| [Routines are goals that anyone on the team edits in the dashboard](../../decisions.md#routines-are-goals-that-anyone-on-the-team-edits-in-the-dashboard) | Routines are data in Postgres, and each save is a version |
| [A routine sets where it ends, its gates, and its stage instructions](../../decisions.md#a-routine-sets-where-it-ends-its-gates-and-its-stage-instructions) | The last step, gates, and per-step instructions are routine settings |
| [An attempt follows the goal as it is when the attempt starts](../../decisions.md#an-attempt-follows-the-goal-as-it-is-when-the-attempt-starts) | Each attempt reads the newest routine version |

## People, identity, and requests

| Decision | What it settles |
| --- | --- |
| [A run acts as a fixed person or as the ticket's assignee](../../decisions.md#a-run-acts-as-a-fixed-person-or-as-the-tickets-assignee) | The run-as rule is a plug-in, and nobody to run as parks the task |
| [A person's action reaches the engine as a request row](../../decisions.md#a-persons-action-reaches-the-engine-as-a-request-row) | One ordered path for the dashboard and the command line |
| [A task waits on its assignee, or else on its routine's creator](../../decisions.md#a-task-waits-on-its-assignee-or-else-on-its-routines-creator) | Whose Needs you list a waiting task appears in |
| [The dashboard has no sign-in for now](../../decisions.md#the-dashboard-has-no-sign-in-for-now) | A person picks who they are |
| [The dashboard ships a person picker with no guard](../../decisions.md#the-dashboard-ships-a-person-picker-with-no-guard) | The pick is trusted. Serve the dashboard only where that is safe |

## Credentials

| Decision | What it settles |
| --- | --- |
| [Stored tokens are write-only](../../decisions.md#stored-tokens-are-write-only) | A token can be replaced but never shown back |
| [The engine checks and refreshes every credential](../../decisions.md#the-engine-checks-and-refreshes-every-credential) | Only the engine refreshes, and Jobs get access-only copies |
| [Database grants keep stored credentials write-only for the dashboard](../../decisions.md#database-grants-keep-stored-credentials-write-only-for-the-dashboard) | One symmetric key, with write-only enforced by grants |
| [Setup keeps a stored login that expires later than the file's](../../decisions.md#setup-keeps-a-stored-login-that-expires-later-than-the-files) | Setup never rolls back a refreshed login |
| [A person gives AutoWorker a Codex login by pasting an auth.json](../../decisions.md#a-person-gives-autoworker-a-codex-login-by-pasting-an-authjson) | A login made for AutoWorker, pasted on the People page |

## The outbox

| Decision | What it settles |
| --- | --- |
| [Outbox rows are claimed with a lease](../../decisions.md#outbox-rows-are-claimed-with-a-lease) | A leased claim, a marker check, and Postgres's clock |
| [An outbox row can end refused, and the store holds a task that owes an action](../../decisions.md#an-outbox-row-can-end-refused-and-the-store-holds-a-task-that-owes-an-action) | A refused row drops the rows behind it. `task.owed_actions` counts the unsettled rows, and `task.ready` is null while it is above zero |
| [A failed outbox row keeps a person's open review](../../decisions.md#a-failed-outbox-row-keeps-a-persons-open-review) | A failed row does not erase a waiting review |

## The dashboard

| Decision | What it settles |
| --- | --- |
| [The agent view lives on each task's page](../../decisions.md#the-agent-view-lives-on-each-tasks-page) | There is no separate agent screen |
| [The dashboard uses the Graphite color scheme](../../decisions.md#the-dashboard-uses-the-graphite-color-scheme) | Grey by default, with color only for state |
| [The board shows one row per workflow](../../decisions.md#the-board-shows-one-row-per-workflow) | The board's columns come from published steps |
| [A failed task that needs a person shows red Failed beside amber Needs you](../../decisions.md#a-failed-task-that-needs-a-person-shows-red-failed-beside-amber-needs-you) | How the two marks combine |
| [The screen word limit counts one view](../../decisions.md#the-screen-word-limit-counts-one-view) | 244 words above the fold, counting the open tab only |
| [Two full-effort reviewers judge each page group](../../decisions.md#two-full-effort-reviewers-judge-each-page-group) | Two blind reviews per group of screens |
| [The dashboard runs on the local kind cluster, in its own pod](../../decisions.md#the-dashboard-runs-on-the-local-kind-cluster-in-its-own-pod) | **Not built**: there are no Kubernetes manifests yet |
| [The Overview shows what needs you first](../../decisions.md#the-overview-shows-what-needs-you-first) | The home page is Needs you |

## Verification and the codebase

| Decision | What it settles |
| --- | --- |
| [Concurrent protocols are model-checked with TLA+](../../decisions.md#concurrent-protocols-are-model-checked-with-tla) | A model comes before the code it covers |
| [Invariants live in structure, and behavior is checked by simulation](../../decisions.md#invariants-live-in-structure-and-behavior-is-checked-by-simulation) | No unit tests that restate code |
| [An end-to-end test proves ticket to merge on sandboxes](../../decisions.md#an-end-to-end-test-proves-ticket-to-merge-on-sandboxes) | Real Jira, GitHub, and Codex on `e2e/run-*` branches |
| [Run branches keep the harness's sandbox status](../../decisions.md#run-branches-keep-the-harnesss-sandbox-status) | The test posts `sandbox` success on the commits it writes |
| [The seed gives the sandbox the product's package types](../../decisions.md#the-seed-gives-the-sandbox-the-products-package-types) | The run branch carries the type files the sandbox needs |
| [The codebase grows only by a raise commit against a checked-in budget](../../decisions.md#the-codebase-grows-only-by-a-raise-commit-against-a-checked-in-budget) | `budget/budget.json`, raises, and folds |
| [The nightly workflow runs only when started by hand](../../decisions.md#the-nightly-workflow-runs-only-when-started-by-hand) | No schedule |
| [CI runs locally while GitHub Actions is disabled](../../decisions.md#ci-runs-locally-while-github-actions-is-disabled) | `node tools/ci-local/main.ts` runs `ci.yml` on the integrating machine |

## Open

One question is open: [when AutoWorker posts to chat](../../decisions.md#open). The lean is to post when a task parks, when a routine is overdue, and in a daily digest. A chat connector joins the end-to-end test once it is decided.
