# How to extend AutoWorker

Each kind of thing in AutoWorker has one approved way to build it, a paved path in [AGENTS.md](../../AGENTS.md), and a file that is its example. This page gives the steps for each kind, with its example and the checks that prove it. Read the paved path in `AGENTS.md` too, because it is the rule and this page is the walkthrough.

## Before you start any change

1. Find the closest existing example and follow its shape (rule D1). Most examples named on this page are the ones `AGENTS.md` names.
2. Read the code the change touches (rule D3). The reference pages list where each part lives.
3. Keep one idea per pull request (rule D4), and finish the whole change in it: code, checks, the feature map, and the docs (rule D5).
4. Expect the budget to need a raise. Most structure ceilings in `budget/budget.json` sit exactly at what landed, so a new feature, migration, table, named guard, scenario, model, dependency, or CI step needs one. Run `npm run budget -- --raise <unit> --why "<why>"` and commit the file it writes, `budget/raises/<unit>.json`, on its own before the change that needs it. Never edit `budget/budget.json` in a feature change.
5. Write no code comments and no suppression directives (rules B1 and B2). Name things so they need no comment.

## Add a feature folder

1. Create `features/<name>/`, named with lowercase letters, digits, and dashes, starting with a letter. `npm run shape` rejects any other name.
2. Put all of the feature's code there: logic, page reads and components, model, simulator, scenarios, and fixtures (rule A4). The page files themselves live in `services/dashboard/app/`.
3. Add `features/<name>/verify.ts` exporting `scenarios`, even if empty at first. The verification tool finds it by folder.
4. Import only from `shared/` and `tools/verify/`. Never import another feature. `npm run boundaries` fails if you do. When a second feature needs your code, move that code to `shared/`.
5. Add the feature's row to [docs/feature-map.md](../feature-map.md) if a person can reach it (rule C3).

## Add a workflow

A workflow is a new kind of work with its own steps. The example is `features/code-change/`.

1. Write `features/<name>/workflow.ts` exporting `workflow`, an object literal with a literal `name` and a list of `step({...})` calls, written `as const satisfies Workflow`. Build every step with `step()` from `shared/workflow.ts`, which is the only way to make a step kind.
2. Give each step its `failures`: a route for every verdict it can end with. `needs_input` must route to `ask`. Give each `return`, `rerun`, and `review` route a counter, a cap, and a `parks` sentence that says exactly what a person must do.
3. For each agent step, write its core prompt at `features/<name>/prompts/<step>.md`, stating its input, its review, and where to stop.
4. Write the workflow's `AgentSteps` plug, the example being `features/code-change/stage-output.ts`. It says what each step's workspace gets before the turn, gives each step's input, settles the reply into output and evidence, and names the actions each verdict owes.
5. List the workflow in `services/engine/workflows.ts`, and map it to its plug in `services/engine/main.ts`.
6. Name no step in `features/tasks/` or `services/engine/`. `npm run step-names` fails if you do, so avoid step names that match the runner's own words, such as `approve` or `done`.
7. Add scenarios to `features/<name>/verify.ts` that check the declaration against the task model's shape and run each step's `judge` on reviews of every outcome, as `npm run verify -- code-change` does.
8. A step the engine runs itself, the way Land is, needs a loop of its own, because the worker claims agent steps only.

Run `npm run check`, your workflow's scenario, `tasks-sim --mutant all`, and `tasks-model` if your routes need the task model to change.

## Add or change a step in Code change

1. Add or edit the `step({...})` in `features/code-change/workflow.ts`.
2. Extend each `switch` in `features/code-change/stage-output.ts`. Each one throws on an unknown step.
3. Add or edit `features/code-change/prompts/<step>.md`.
4. Update the task model's shape in `features/tasks/Tasks.tla` and its configs, and the simulator's copy of Code change, `codeChangeCopy` in `features/tasks/simulate.ts`. A feature never imports another, so the simulator keeps its own copy, and `tasks-sim --mutant all` checks it against the model's shape.
5. A new verdict needs a migration that adds the value to the `verdict` enum and does not use it, because Postgres cannot use a new enum value in the transaction that adds it. It also needs every exhaustive record over verdicts filled in, such as `failing` in `shared/task-status.ts`, which `npm run typecheck` enforces.

Run `code-change`, `tasks-sim --mutant all`, `tasks-model`, and the lanes that exercise the step.

## Change a prompt

Change a prompt only for a failure you watched happen, and prove the change with an eval before relying on it (rule E2). Some wording is read by code. The Codex stand-in finds the reproduction path by the phrase "reproduction script at" in `verify.md`, and `stand-in-solutions` reads the prompt files. Update `features/e2e/codex-stand-in.ts` in the same change when you move that wording, and run `stand-in-solutions`.

## Add a person request kind

A person's action reaches the engine only as a `person_request` row. The example is `stop`.

1. Add the kind to `requestKinds` in `shared/requests.ts`, with its target and its zod payload in `targets` and `payloads`.
2. Add it to the `request_kind_fits_target` check in a new migration.
3. If it records a new kind of human action, add that value to the `human_action_kind` enum in its own migration first, then fit it into `target_fits_kind`.
4. Add its handler to the `handlers` record in `services/engine/main.ts`, which `satisfies Handlers<RequestKind>`, so a kind with no handler fails `npm run typecheck`. A handler takes the transaction and the request, and returns `recorded` or `refused` with a sentence a teammate understands. It never waits on a person or an outside service.
5. Add the action to `services/engine/act.ts` if the command line should offer it, and a server action if the dashboard should. A server action parses its form with zod, sends one request with `request`, and waits at most 2 s with `answerWithin`.

Run `requests-sim --mutant all`, `setup`, and the page's lanes.

## Add an engine loop

A loop is a `Loop` from `shared/loop.ts`. The example is `reaper` in `features/tasks/reaper.ts`.

1. Write a function in your feature folder that builds the loop: a `name`, an interval `everyMs`, and a `pass` that takes the database and the pass's `now` and returns one log line per thing it did.
2. Give it a `resume` if its pass depends on how long the engine was away from Postgres.
3. Add its interval setting to the zod `settings` object in `services/engine/main.ts`, and add the loop to `loopsFor` there, passing only the values it needs.
4. Take every time as a parameter, so its simulator can run the same `Loop` through `runLoop` on a virtual clock.
5. If the loop coordinates concurrent actors, model it in TLA+ first (rule C5), and simulate it (rule C6).

## Add a connector kind

A connector kind is a new outside service with personal credentials. The example is `features/github/`, and the credential side is `features/credentials/`.

1. Add the value to the `connector_kind` enum in a migration of its own, copying `db/migrations/20260924220100_jira_kind.sql`.
2. Insert its row into `connector` in a later migration, and run `npm run db:types`.
3. Add its reader to `features/credentials/kinds.ts`. `npm run typecheck` then requires it everywhere a record covers every kind.
4. Write its check in `features/credentials/<kind>-check.ts`, add it to `checksFor` in `features/credentials/checks.ts`, and add its fake to `features/credentials/simulate.ts`. The example check is `features/credentials/codex-check.ts`.
5. Fill in the dashboard's records over connector kinds, such as the login names and labels in `features/people/`, which `npm run typecheck` also requires.
6. Write the connector's folder: a client that parses every field it reads with zod and sends each request once with no retry, a `Performers<Kind>` record, and a simulator that runs the real client against a seeded fake.
7. Spread its performers into `performers` in `services/engine/main.ts`, and register a `Source` in `sourcesByKind` if routines find work through it.

Run `credentials`, `credentials-sim --mutant all`, `checks-model`, `setup`, and the connector's own simulator.

## Add an outside action kind

1. Add its `ActionSpec`, a zod payload and result, to `actionKinds` in `shared/actions.ts`.
2. Add it to the connector's list of kinds, and write its performer with `performer(spec, target)`. A target that catches duplicates itself uses `{catches: 'duplicates', call}`. One that does not uses `{catches: 'nothing', find, call}`, where `find` looks for the row's marker first.
3. Declare it in the `owes` of each step that owes it, so it joins `ActionKind` and `services/engine/main.ts` fails to compile until a performer exists.
4. Owe it with `owe(kind, payload)` and `enqueue`, inside `inTransaction`, after the attempt that owes it has finished.

## Add a source of work

A source is how a routine finds work, a `Source` from `shared/routine-source.ts`. The example is `scheduleSource` in `features/routines/schedule-source.ts`.

1. Write a `Source` with a literal `kind` and a `find` that takes the claimed run and returns work items, each with a `key` that names the task across every routine, a `title`, and the ticket's assignee where there is one.
2. Parse its own fields of the routine's `source` JSON with zod, and throw when the search fails.
3. Register it once in `sourcesByKind` in `services/engine/main.ts`.
4. The routine draft's `source` schema in `shared/routine-draft.ts` accepts `jql` and `pageSize` only for `jira-search`. A source with other fields changes that schema and the routine editor's form.

## Add a Verify provider

A Verify provider makes the environment Verify checks behavior in, one per attempt. The contract is `Provider` in `features/environments/provider.ts`, and the example is `features/environments/tests-only.ts`.

1. Write `features/<name>/provider.ts`, exporting a plain object with a `name`, a `start`, and a `stop`, each idempotent per attempt id. `start` returns the agent's own workspace with a command to run, the workspace with the repository's CI checks, or an address the agent can reach.
2. Import nothing from `features/environments/`. `tsc` checks your object against `Provider` by its structure.
3. Make `start` honor its `signal`. Once it aborts at the start deadline, cancel or stop anything still starting, because the engine may already have recorded the stop.
4. Keep the provider's credentials in the engine. Never return one, because a Job has no cluster access.
5. Pass the object to `providersByName` in `services/engine/providers.ts`.
6. Set `verify_provider` on each repository that should use it.

Run `environments-sim --mutant all` and `environments-engine`.

## Replace a rule in a fork

A fork changes a rule by passing its own value in `services/engine/main.ts`, and changes nothing under `features/tasks/`.

- **The run-as rule.** Write a `RunAsRule`, which takes the task and returns the person or team account an attempt runs as, or `null`. The core's `coreRunAs` in `features/tasks/run-as.ts` is the example. Keep `nobodyToRunAs`, the waiting reason, in step with your rule. The simulator claims through `coreRunAs`, not your rule, so `tasks-sim` does not exercise a replacement. Prove your rule with a scenario in your own feature.
- **The review step.** Write a `ReviewStep` that tells Land what to owe and what the waiting task shows when a pull request needs a review. It may owe only `ticket.comment` and `ticket.transition`, which it builds with `reviewOwes`. The type refuses anything else, including `pr.merge` and an approval. To allow another kind, add it to `ReviewKind` in `features/code-change/land.ts` in its own pull request.

## Add a repository setting

1. Add the column, its default, and a named check, in a migration.
2. Grant the dashboard read access in a grants migration, and add the line to `tools/verify/dashboard-grants.json`.
3. Add the field to `repositorySave` in `shared/repository-settings.ts`, and to setup's `repositorySettings`, `settingColumns`, and `wantedFrom` in `features/tasks/setup.ts`.
4. Add it to the form in `features/repository-settings/` and to its read.
5. Read it where it applies.

Run `setup`, `repository-form`, `dashboard-grants`, and the repositories lane.

## Add a migration

The paved path is the Migrations section of `AGENTS.md`, and the example is `db/migrations/20260923220000_tasks.sql`.

1. Name the file `db/migrations/<YYYYMMDDHHMMSS>_<name>.sql` with a version no other migration uses.
2. Write the `-- migrate:up` part, and a `-- migrate:down` part that undoes exactly what it does. Put no other comment in it, and no `COMMENT ON`.
3. Name every check, unique constraint, foreign key, index, and trigger for the rule it enforces. A guard one feature adds to another feature's table takes the adding feature's folder name as a prefix.
4. Default no column to `now()`. Pass every time as a parameter.
5. Add a new enum value in a migration that does not use it, and use the value only in a later migration, because Postgres cannot use an enum value in the transaction that adds it.
6. Run `npm run db:types` to regenerate `shared/db/types.ts`, and never edit that file by hand. Resolve a merge conflict in it the same way.
7. Give every new named guard a mutant in its feature's simulator, or list it in `noMutantYet` in that feature's catalog with the reason.
8. When a page needs a new read, add its grants and its lines in `tools/verify/dashboard-grants.json`.

Run `migrations`, `npm run check`, which fails if `shared/db/types.ts` is stale, the owning feature's `<name>-sim --mutant all`, and `dashboard-grants` if grants changed. [reference/data-model.md](reference/data-model.md) lists the rules and every existing guard.

## Add a dashboard page, action, or stream

The example is `features/task-page/`.

1. **A page.** Add `services/dashboard/app/<path>/page.tsx`, a server component that holds no logic. It reads the acting person with `acting()` when it needs one, calls one read of its page feature with `database()`, calls `notFound()` when the read finds nothing, and renders the feature's component.
2. **The read and components.** Write them in the page feature, with Kysely queries and zod parsing of JSON. A component that runs in the browser starts with `'use client'` and takes plain values and server actions as props.
3. **Colors and status.** Take colors only from `color()` in `shared/ui/tokens.ts`, and draw a status with `StatusMarks` from `shared/ui/status.tsx`.
4. **Grants.** Add a grants migration and its lines in `tools/verify/dashboard-grants.json` for any new read.
5. **A server action.** Add it in a `'use server'` file beside the page, following `stopTask`.
6. **A stream.** Add `services/dashboard/app/<path>/stream/route.ts` returning `sse(frames(...))`. Its `frames` polls one query every 250 ms and yields frames its `protocol.ts` declares. A frame that moves the cursor carries an SSE id. In the browser, read it with `useFrames`.
7. **Screens and lanes.** Declare them in the feature's `verify.ts`: `screens` for each page state, `lanes` for browser flows, and `batch` for the scenarios and engine checks the page depends on.

A page unit runs only `npm run check`, and `dashboard-batch` runs everything once at the end of a batch. Before a person sees a new screen, it must pass the 19 gates and two reviewers' scores, run with `screens <group>` and `screen-review <group>`.

## Add a check

A check that no tool in the stack can express is a script at `tools/<name>/main.ts`, run as `npm run <name>`. The example is `tools/shape/`.

1. Write the script. It prints one line per violation, starting with the path it rejects, and exits 1 when there is any. It parses product code as text and never imports it statically.
2. Add its npm script, and chain it into `npm run check`. A check that only reads files runs before `npm run typecheck`. A check that starts a container runs last.
3. Add guardrail cases in `tools/verify/guardrails.ts`: one that plants a violation and passes only when the check rejects it, one per allowed exception with cases proving the exception allows nothing more, and one that runs `npm run check` itself.
4. Update the rule's row in the Enforcement table of `AGENTS.md`.

Run the check, then `guardrails`.

## Add a model

A model is `features/<name>/<Model>.tla` with `<Model>.cfg`, written before the code it covers (rule C5). The example is `features/tasks/`.

1. Give each guard in the design a boolean constant that the real config sets to `TRUE`.
2. Declare the model with `defineModel` from `tools/verify/models.ts` in the feature's `verify.ts`: the module, the configs with a floor per bound, the guards, each property with its section, the liveness properties, and at least one mutant per property and per guard.
3. Put larger bounds in `<Model>.nightly.cfg`.
4. With the model in the worktree, run `npm run budget -- --raise <unit> --why "<why>" --add states/<Model>=<n>`, using the state count that `<name>-model` reports, and commit the raise file alone. `--raise` measures `structure/tla-models` itself.
5. Once code lands, name every property the config lists as a key of `properties` in the feature's `invariants.ts`, `TypeOK` included. `npm run model-names` checks it.

Run `<name>-model`, then `models`.

## Add a simulator

A feature whose code coordinates concurrent actors runs that code in a seeded simulation (rule C6). The example is `features/tasks/`.

1. Write `features/<name>/invariants.ts` exporting `properties`, one entry per model property, each with a SQL predicate that returns the rows breaking it, and a plant that breaks it in a scratch database.
2. Write `features/<name>/simulate.ts`: seeded actors on a virtual clock, fault moves, a check of every predicate after each step, a mutant table that drops one named guard per entry, and a fingerprint of its moves.
3. Write the feature's catalog, calling `auditCatalog` from `tools/verify/catalog.ts` with `noMutantYet`, and add the feature to `catalogOwners` if it adds guards to another feature's tables.
4. Add a fast gate, `simulate.test.ts`, that runs fixed seeds and replays `failed-seeds.ts`.
5. Add the `<name>-sim` scenario with a `nightly` list, and a `ci.yml` step for its fault profiles.

## Add an end-to-end lane

A lane is a numbered situation the end-to-end test plants, with the checks that decide it. The examples are the lanes in `features/e2e/lanes.ts`.

1. If the lane needs a new failure, add a fault to `features/e2e/autoworker.ts`, or a rehearsal to `features/e2e/solutions.ts` that the Codex stand-in plays.
2. Add the lane to `lanes`, with its number, slug, procedure, and the checks that decide it.
3. Make the lane fail on the code before your fix, and keep that output.
4. Run it with `p7-lane <n> --world local`. A rehearsal needs the local world, because real Codex ignores the rehearsal line.

## Give a repository its own Job image

When a repository's checks need a tool the attempt image lacks, such as Chrome for a browser smoke test, give the repository an image that extends the attempt image. [operations.md](operations.md#give-a-repository-its-own-job-image) shows how to build one and save it.
