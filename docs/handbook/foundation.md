# Why AutoWorker is built this way

AutoWorker carries a ticket to a merged change without a person driving it. This page explains the few ideas the whole design follows. Read it before you extend a part or rework one, because most rules in the code exist to protect one of these ideas, and a change that keeps them rarely breaks anything else.

Each idea below says what goes wrong without it, how the code prevents that, and where to look. [architecture.md](architecture.md) shows how the parts fit together, and [docs/decisions.md](../decisions.md) records each settled choice with the options that lost.

## Trust comes before throughput

A team can only run as many agents as it can verify ([docs/spec.md](../spec.md)). So AutoWorker is designed to be checked, not to be fast. Every step can be verified on its own, a person can always see what the system is doing and why, a failure costs one step instead of the whole task, and every action traces back to a named person.

That bet explains choices that look slow at first. A task moves through four separate stages instead of one long agent session. Verify reruns the agent's reproduction itself instead of trusting the agent's report. A change lands only when the repository's own checks pass. Each of these trades speed for a result someone can check.

## Postgres is the only record

When two places both claim to know the state of a task, they eventually disagree, and then every piece of code has to pick one. AutoWorker keeps one authoritative record, in Postgres. Claims, the current step, attempts, verdicts, and evidence are rows. Branches, pull requests, tickets, and cluster resources are observations. The engine reads them, records what it saw, and reconciles, but never treats them as a second authority.

There is no fallback that rebuilds state from files or from GitHub. A fallback becomes the real path the first time it runs, and then both paths need maintaining.

For you, this means new state goes into a migration first, with its rules as constraints, and code reads it from there. The schema is in `db/migrations/`, and [reference/data-model.md](reference/data-model.md) describes each table.

## The store refuses what must never happen

Code that checks a condition and then acts has a race between the check and the act. AutoWorker puts each invariant where Postgres enforces it, so the second writer is refused outright instead of being prevented by a check that can go stale.

- A task has at most one live attempt, because the partial unique index `one_live_attempt_per_task` refuses a second.
- A live attempt belongs to a ready task at the same step and epoch that owes no outside action, because the foreign key `live_attempt_matches_ready_task` refuses anything else.
- A finished attempt never changes, because the trigger `finished_attempt_is_final` refuses the write.

The code expects refusals. It catches the error, passes it to `refusal()` from `shared/db/client.ts`, and maps each expected constraint name to an answer of its own, such as `busy` or `not-ready` in `features/tasks/claim.ts`.

In each feature with a catalog, every named constraint, index, and trigger on its tables has one of two things. Either a mutant in the feature's simulator drops it and shows that the simulator then reports a broken property, or it has an entry in `noMutantYet` with the reason. So a rule in the schema is proved to matter, not just assumed to. The `evidence`, `verify_environment`, `published_workflow_step`, and `published_provider` tables have no catalog yet.

## Concurrency is designed in a model before any code

Claims, leases, the step machine, the outbox, person requests, credential checks, and the routine schedule all coordinate concurrent actors. Bugs in that kind of code hide in rare interleavings that tests do not reach. So each protocol gets a TLA+ model first (rule C5), and TLC checks every interleaving within its bounds.

Each guard in a design is a boolean constant in its model. The model's scenario runs TLC once with every guard on, which must pass, and then once per mutant, with that mutant's guard off and only its property checked, which must fail. A guard that no mutant can break is a guard nobody has shown to be needed.

Then the real code runs in a seeded simulation (rule C6). Seeded workers act on a virtual clock, faults are injected, and after every step a SQL predicate for each model property looks for rows that break it. The simulator and the model share property names, and `npm run model-names` fails the build when a model names a property the simulator does not check. [verification.md](verification.md) explains both layers and how to run them.

## Time is a parameter

No column defaults to `now()`, and every statement that reads or writes a time takes it as a `Date` parameter. The simulator can then run the real statements on a virtual clock, and a failing seed replays the same moves. Code that reads the wall clock inside a query cannot be simulated, so keep time a parameter in anything you add.

## Every outside effect goes through the outbox

Posting a comment, opening or merging a pull request, and moving a ticket are effects outside AutoWorker. If a process dies after the effect and before it records the effect, a naive retry does it twice. AutoWorker commits each effect as an `outbox` row in the same transaction as the state that owes it. A separate pass claims the row with a lease, performs it once within a deadline, and records the result.

A target that cannot catch its own duplicates, such as a Jira comment, carries the row's marker, which the performer attaches to what it creates and looks for before it acts. So performing an action twice has the same result as performing it once. A task whose outbox rows are not settled is not ready, which the generated column `task.ready` states, so no next step starts until the last one's effects landed.

## The agent is capable and untrusted

An agent can write good code and can also be wrong, stuck, or confused about its own results. AutoWorker gives it full permissions inside a box and trusts nothing it says without checking.

- **Isolation.** Each attempt runs in its own Kubernetes Job from the attempt image. The Job holds no database or Kubernetes credentials, and its service account has no role binding. The design also limits its network to its repository, the engine's address, and the Codex API, but nothing in this repository enforces that limit yet. A deployment must add it, for example as a NetworkPolicy.
- **Separate users inside the Job.** `bridge` holds the GitHub token and the attempt token, and commits and pushes. `codex` runs the agent and owns the workspace. `reproduce` runs Verify's script. The agent cannot read the bridge's environment or change what a push sends.
- **Evidence the system produces.** Verify's agent writes a reproduction script. The Job then runs that script itself, as `reproduce`, in fresh checkouts of the base commit and the change, with clean temp directories. The verdict comes from those exit codes, not from what the agent says.
- **A structured reply.** Every agent step ends with a JSON review that a strict schema checks. `judge` in `shared/workflow.ts` turns it into a verdict, and an unreadable reply gets the verdict the step declares for `blocked`, such as `fail`, never a pass.
- **Access-only logins.** A Job gets a Codex login with its refresh token blanked, so only the engine ever refreshes a login.

## Failure is the normal path

Most attempts that matter fail at least once. The design treats that as the main path.

- Every step ends in a verdict, and the workflow declares what each failure verdict does: return to an earlier step, rerun this one, wait for a review, wait for a person, or fail.
- Every loop has a counter and a cap. At the cap, the task parks and waits for a person with a short reason that says exactly what to do. The `instruction` type in Postgres, and `Instruction` in TypeScript, require the reason to start with a capital and end with a period.
- A rework owes what sent it back. `begin` builds a typed `ReworkObligation` from the attempt that sent the task back, such as the failing check's log, Verify's whole evidence, the conflict's base head, or a person's note. A rework that owes a change and pushes nothing ends at once, and the task waits for a person with the agent's own words. It never repeats blindly.
- A rework must be able to reproduce what sent it back. A conflict or failed-check rework starts from its branch merged with the current base, which is the tree CI tested.
- Dead work is released. An attempt holds a lease, the reaper releases an expired one within one interval, and a new attempt continues from the lost attempt's last push.

[lessons.md](lessons.md) describes how each of these rules came from a failure seen in a live run.

## People act through requests

A person can stop, retry, approve, answer, send back, or steer a task, pause, resume, or run a routine now, and save a routine or a repository. Each of those writes one `person_request` row. The dashboard offers them all, and `services/engine/act.ts` offers the task and routine actions. The engine applies requests in order per target, one transaction per request, and records a `human_action` with the same id. The dashboard's Postgres role can read what the pages need and insert only a request's question columns, so a page can never change engine state directly. The one other write it has is replacing a login, which goes through the `security definer` function `replace_credential` and records a `human_action` in the same statement.

## Every action runs as a named person

A task runs as a person, and every action it takes is traceable to that person. The run-as rule names the person for each attempt: the routine's fixed identity, or else the ticket's current assignee. That person's own GitHub token and Codex login do the work. Credentials are sealed with AES-256-GCM before they reach Postgres, the key never reaches the database, and each connector kind has a check that proves a stored credential still works.

## A generic core, with plug-in points for a fork

AutoWorker is an open core that a company forks and adapts. Company rules never go into the core as special cases. They go into typed plug-in points and per-repository settings.

- **Routines are data.** A routine is a goal in plain words, a schedule, a source of work, and a workflow name, stored in Postgres and edited from the dashboard.
- **Workflows are code, but the runner never names them.** The runner in `features/tasks/` and `services/engine/` never names a workflow or a step, and `npm run step-names` fails the build if it does. Only `services/engine/workflows.ts` may name workflows, and the check skips tests and the simulator's files.
- **Rules a fork changes are one typed value each.** `services/engine/main.ts` passes each one in, for example the run-as rule, the review step, the Verify providers, the connectors' performers, and the sources.
- **Repositories carry their own settings.** Examples are the Job image, the setup command, the fast test command, the Verify provider, the checks to ignore, and when a draft leaves draft.

A fork replaces a plug-in value and keeps taking upstream changes. [extending.md](extending.md) walks through each plug-in point.

## The codebase is built for agents to work on

Agents copy the patterns they see and take the shortest path. So the repository makes the shortest path the correct one. [AGENTS.md](../../AGENTS.md) holds the rules, each with an ID. The rule behind all of them is a ladder. Fix a mistake with architecture where you can, a failing check where you cannot, and guidance only when neither works. Human review is the last resort.

- Each kind of thing has one approved way to build it, a paved path, and the first example of each kind is the template.
- There are no code comments, because names, types, and structure carry the meaning.
- One checked-in verification tool, `npm run verify`, holds every scenario. Each check has a guardrail case that plants a violation and proves the check fails on it.
- A budget in `budget/budget.json` caps how much each area of the codebase can grow. A ceiling rises only in a commit of its own.

## What any rework must keep

You can rework any part of AutoWorker. These properties are what make the rest of it safe, so keep them, or replace them with something that enforces the same thing at the same level or higher.

| Keep | Because |
| --- | --- |
| One record in Postgres, with invariants as constraints | Every other part trusts the store to refuse bad states |
| Time as a parameter | The simulators and seed replay depend on it |
| Models before concurrent code, with a mutant per guard | It is how a race gets found before production |
| Model property names equal to simulator predicate names | `npm run model-names` checks the link |
| The outbox with markers and leases | Effects happen at most once |
| Agent isolation, and evidence the system produces | Verdicts come from runs, not claims |
| Verdict routes, counters, and caps declared in the workflow | `decide` reads them from the workflow, and `code-change` and `tasks-sim --mutant all` check the declaration and the simulator's copy against the model's shape |
| Typed rework obligations, derived at claim time | A rework never repeats blindly |
| Person actions only as request rows | One ordered path with an audit trail |
| No workflow or step names in the runner | Forks add workflows without editing the core |

What can change freely, with evidence: prompt wording (it grows from observed failures, rule E2), page layout within the screen gates, loop intervals, query shapes that keep the same statement-level rules, and the values of caps, which are settled decisions rather than code accidents.

## Where the design is thin today

These gaps are known, and none has code yet. Treat each as open work, not as a hidden feature.

- The spec keeps attempts and evidence for 180 days and transcripts for 30, but no loop prunes them.
- The spec says a routine that stops running is noticed, but nothing notices it.
- The spec lets a person give a task to a different owner, but no request kind does that. Today the ticket's assignee or the routine's run-as identity decides.
- The worker runs agent steps only. A workflow step that the engine runs itself, the way Land does, needs its own loop.
- An outbox row whose kind has no registered performer is never claimed, so its task stays unready until a person stops it, which drops the row.
- The Job's network limit is part of the design but has no enforcement in this repository, as noted above.
- The check loop retries a credential check that returns `unknown` only inside a Codex login's refresh window, and a Job checks a Codex login again only once its last check is over 6 hours old. A GitHub or Jira login is never checked again after a `valid` result, and the engine passes a GitHub token to a Job without looking at its check state.
- There is no tool to rotate the sealing key. A credential sealed under another key version must be replaced.
- The decision that AutoWorker checks each repository before it works there has no code yet.
- The dashboard has no sign-in. A person picks who they are, and the pick is trusted.
