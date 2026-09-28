# Glossary

The words AutoWorker's code, docs, and logs use, each with one meaning. Where a term names a symbol, the symbol and its file are given.

**`act.ts`.** The command-line way to act as a person on a task or a routine: `node services/engine/act.ts <action> <task key or routine name> --as <email>`, where the action is `approve`, `send-back`, `answer`, `stop`, `retry`, `steer`, `pause`, `resume`, or `run-now`. It writes the same person request the dashboard writes.

**Admin command.** A file in `services/engine/` that an admin runs with `node`, such as `setup.ts`. It parses all input with zod before writing, and prints no secret.

**Attempt.** One try at one step of one task, a row in `attempt`. It holds a lease while it runs, ends with a verdict, and keeps its output, its branch, the commits it started from and pushed, and its rework obligation.

**Attempt image.** The container image every attempt's Job runs, built from `services/job/Dockerfile`. A repository may name its own image that extends it.

**Base.** The branch a repository's tasks start from and merge back into, usually `main`. Each repository row names its own.

**`begin`.** The function in `features/tasks/begin.ts` that prepares a claim: where the attempt starts, and the rework obligation it owes. `claim` accepts only what `begin` built.

**Blind repeat.** An Implement attempt that makes no change right after another no-change attempt on the same task, with no person acting in between. The rework obligation exists to prevent it.

**Bridge.** The process in each Job that runs the agent and talks to the engine over HTTP, and the engine endpoint it talks to (`features/bridge/`). It streams the agent's events and receives commands such as steers.

**Budget.** The ceilings in `budget/budget.json` on how much each area of the codebase may grow. A **raise** lifts a ceiling in a commit of its own. A **fold**, `npm run budget -- --lower` after an integration, folds in the raise files and sets each line and structure ceiling, and each state count a models log reports, to what landed. It never lowers a time ceiling.

**Cap.** The limit on a counter. When a counter reaches its cap, the task parks. Route caps live in the workflow, and a few global caps live in `features/tasks/claim.ts`.

**Catalog.** The list, per feature, of every named constraint, index, and trigger on the tables that feature owns, each either covered by a simulator mutant or listed in `noMutantYet` with a reason.

**Check.** Two different things, so name which one. A **credential check** proves a stored login still works (`features/credentials/checks.ts`). A **GitHub check** is a CI result on a pull request, which Land reads.

**Claim.** Inserting an attempt row for a ready task (`features/tasks/claim.ts`). Postgres refuses a second live claim through a partial unique index.

**Code change.** The one workflow the core ships: Specify, Implement, Verify, then Land (`features/code-change/workflow.ts`).

**Conflict.** The verdict Land gives when the pull request conflicts with its base branch. It has its own route, counter, and cap, apart from failed checks.

**Connector.** A feature folder that talks to one outside service, `features/github/` or `features/jira/`, with a client and performers. Its credential check lives in `features/credentials/`. `codex` is a connector kind with a check but no folder.

**Continuation.** Where a new attempt starts: a lost attempt's last push, the task branch's head, or the repository branch (`features/tasks/continuation.ts`).

**Counter.** A per-task count, kept in `task.counts`, of how many times one failure route has run, such as `rounds`, `reruns`, `landRounds`, or `conflicts`.

**Engine.** The one backend program, `services/engine/main.ts`. It runs every loop and serves the bridge endpoint.

**Environment.** Where Verify checks behavior, made by a Verify provider for one attempt (`features/environments/`). The core provider is `tests-only`.

**Epoch.** A counter on each task that goes up when a person stops, retries, approves, or sends back the task. A claim that `begin` prepared under an older epoch is refused as `moved`.

**Evidence.** What Verify saved to show the behavior: the reproduction script and its runs on the base commit and on the change, in the `evidence` table.

**Fault.** A failure the end-to-end test injects on purpose, such as `engine-restart`, `lost-job`, or `base-conflict`, or a failure a simulator injects into a seed.

**Gate.** A step a routine marks as needing a person's approval before the task goes on.

**Guardrail.** A case in `tools/verify/guardrails.ts` that plants a violation in a copy of the repository and passes only when the check it covers rejects it.

**Hold.** `npm run verify -- e2e-hold`, a standing engine and dashboard against a real repository, with a kept database.

**Human action.** The audit row in `human_action` for anything a person did, with the same id as the request that caused it, when a request did. Setup and a credential replacement record their actions directly.

**Instruction.** A sentence that tells a person what to do, such as a task's waiting reason. The `instruction` domain requires a capital first letter and a final period.

**Job.** The Kubernetes Job one attempt runs in (`features/jobs/`). It holds three Unix users: `bridge`, `codex`, and `reproduce`.

**Judge.** The function `step()` derives for each step kind, which turns the agent's final review into a verdict (`shared/workflow.ts`).

**kind.** The local Kubernetes cluster, named `autoworker`, that lanes and holds run Jobs on. Every worktree on a machine shares it.

**Land.** The last step of Code change, run by the engine, not by an agent (`features/code-change/land.ts`). It reads the pull request, owes actions such as marking it ready or merging it, and sends the task back on a conflict or a failed check.

**Lane.** A numbered end-to-end or browser scenario that plants one situation and names the checks that decide it, such as `p7-lane 19` or `dashboard-lane u4 1`.

**Lease.** The time until which a claim holds. The reaper releases an attempt whose lease has lapsed, and neither a worker nor a bridge can renew a lapsed lease. When the engine starts, and after a failed reaper pass, every live attempt gets a fresh lease first, so downtime alone loses nothing.

**Live service.** The `live` service in `compose.yaml`, which loads the sandbox tokens and the read-only Codex login for scenarios that reach real services.

**Local CI.** `node tools/ci-local/main.ts`, which runs every step of `.github/workflows/ci.yml` on this machine while GitHub Actions is disabled.

**Local world.** The end-to-end world with a fake GitHub, a fake Jira, and a git daemon, run with the Codex stand-in unless `--agent real`. The **sandbox world** uses the real services.

**Loop.** One recurring engine pass, a `Loop` from `shared/loop.ts`, such as `worker`, `reaper`, `land`, or `outbox`.

**Model.** A TLA+ specification, `features/<name>/<Model>.tla`, that TLC checks before the code it covers exists.

**Mutant.** A deliberately broken version, of a model guard or of a schema constraint, that must make its check fail. It proves the guard matters.

**Needs input.** The verdict of an agent step that asks a person a question. The task waits on an answer.

**Obligation.** Short for rework obligation. The typed reason a rework came back, derived at claim time (`shared/rework.ts`). Its kinds are `conflict`, `check`, `behavior`, `review`, and `note`.

**Outbox.** The table of effects owed to outside services, each committed with the state that owes it and performed once by the `outbox` loop.

**Owed action.** An outbox row not yet settled. A task that owes one is not ready.

**Park.** To make a task wait for a person, with an instruction, usually because a counter reached its cap.

**Paved path.** The one approved way to build each kind of thing, listed in `AGENTS.md`, with a file that is its example.

**Performer.** The code that carries out one action kind for a connector, with a deadline, and records the result.

**Person request.** A row in `person_request` that asks the engine to act for a person: stop, retry, approve, answer, send back, steer, pause, resume, run now, or save a routine or repository.

**Plant.** SQL or a file that breaks a property on purpose, to prove the check for that property reports it.

**Plug.** A typed value `services/engine/main.ts` passes into the core, which a fork replaces: the run-as rule, the review step, the Verify providers, the performers, the sources, and each workflow's `AgentSteps`.

**Reaper.** The loop that releases attempts whose lease lapsed, marking them `lost` (`features/tasks/reaper.ts`).

**Reproduction.** The script Verify's agent writes at `/tmp/autoworker-reproduce.sh`, which the Job runs as `reproduce` on fresh checkouts of the base commit and of the change.

**Review.** Two different things. An agent step's **review** is its final JSON reply (`shared/review.ts`). A pull request **review** is a GitHub review, which Land's review step handles.

**Routine.** A goal in plain words, a schedule, a source of work, and a workflow, stored in Postgres and versioned on every save.

**Run-as.** The person an attempt acts as, chosen by the run-as rule: the routine's fixed identity, or else the ticket's assignee (`features/tasks/run-as.ts`).

**Scenario.** One named check in the verification tool, run as `npm run verify -- <name>`.

**Seed.** A number that fixes a simulator run's choices so it replays exactly. Separately, a **local-engine seed** is a named task story planted in a local world, such as `waiting-gate`.

**Send-back.** A failure verdict that returns the task to an earlier step, such as Verify's `behavior_fail` returning to Implement.

**Simulator.** The `<name>-sim` scenario of a feature, which runs the real code with seeded workers on a virtual clock, injects faults, and checks every model property after every step.

**Source.** How a routine finds work, such as a Jira search. A `Source` returns work items, each with a stable key.

**Stand-in.** `features/e2e/codex-stand-in.ts`, a program that plays the Codex app server in a Job so lanes run without the real agent.

**Steer.** A message a person sends to an agent while its turn runs.

**Step.** One stage of a workflow, built only with `step()` in `shared/workflow.ts`, run by an agent or by the engine.

**Task.** One piece of work a routine found, usually a ticket, keyed by the ticket's key across all routines.

**Verdict.** How an attempt ended: `pass`, a failure such as `behavior_fail` or `red_check`, `needs_input`, or an engine verdict such as `lost` or `handed_off`.

**Verify.** The third step of Code change. Its agent writes a reproduction, and the Job runs it before and after the change.

**Waiting.** A task state in which the task needs a person. `waiting_on` says which action answers it: `retry`, `approval`, `answer`, or `outside_approval`.

**Worker.** The loop that claims ready tasks at agent steps and launches their Jobs (`features/tasks/worker.ts`).

**Workflow.** A list of steps with a route for every failure, defined in code in `features/<name>/workflow.ts` and listed in `services/engine/workflows.ts`.
