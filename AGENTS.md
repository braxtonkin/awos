# Rules for autoworker-oss

These rules apply to every change in this repo, whether an agent or a person wrote it. [docs/spec.md](docs/spec.md) specifies the system these rules build. [docs/decisions.md](docs/decisions.md) records the settled design decisions and the options that lost. Do not reopen a settled decision without new evidence. Every rule has an ID. Cite IDs in reviews and commit messages, for example `move parser into its feature folder (A4)`.

## The rule behind the rules

When an agent makes a mistake, or when you are about to leave a review comment, fix the cause at the highest level that works:

1. **Architecture**: make the mistake impossible through types, data structures, or module boundaries.
2. **Static checks**: compiler, type checker, lint, CI. A violation must fail the build.
3. **Guidance**: this file, skills, AI review. Useful, but an agent can skip it.
4. **Human review**: the last resort. A review comment that keeps coming back points to something missing in levels 1 to 3.

Never fix a repeated mistake only by rewording a prompt. Most rules below are enforced by this file alone for now; the [enforcement table](#enforcement) tracks moving each one up to a check.

## A. Codebase design

- **A1. The codebase is the example.** Agents copy the patterns they see. Merge only code you would be happy to see copied everywhere.
- **A2. The shortest path is the correct path.** Agents take the quickest route. If the quick way to do something is wrong, change the codebase until the quick way is right.
- **A3. One paved path.** Each kind of thing (feature, command, config, test) has exactly one approved way to build it, recorded under [Paved paths](#paved-paths). Do not add a second way. If the paved path does not fit, change it in its own PR.
- **A4. A feature lives in one folder.** All code for a feature, including logic, interface, tests, and fixtures, lives in `features/<name>/`. Code moves to a shared module only when a second feature needs it.
- **A5. Boundaries are checked by machine.** Which modules may import which is declared in config and checked in CI, not left to convention.
- **A6. Design for the contributor with the least context.** A newcomer, a non-engineer, or a small model should be able to add a feature by copying an existing one. Accept constraints that feel heavy to humans; agents absorb the friction.
- **A7. Prefer strict tools.** Choose languages, compilers, and settings that turn mistakes into build errors, and enable their strictest modes.

## B. Keeping the codebase clean

- **B1. No code comments.** Names, types, and structure carry meaning. If code needs a comment to be understood, restructure it. If it is a workaround, fix the cause or open an issue. Agents write comments that go stale and treat workaround comments as permission to repeat the workaround. The only exceptions are lines a tool needs in order to run, such as a shebang.
- **B2. No suppression directives.** No `eslint-disable`, `@ts-ignore`, `noqa`, `#[allow]`, or similar. If a check is wrong, change its config in its own PR.
- **B3. No quiet workarounds.** One merged workaround becomes the pattern within days. Fix the cause, or record it as an issue and stop.
- **B4. Stop the bleeding first.** When you find a bad pattern, first add a check that blocks new instances, then remove the existing ones in follow-up PRs.
- **B5. Delete freely.** Remove dead code, unused exports, and stale docs when you find them.

## C. Verification

- **C1. Agents verify their own work.** Every change is run for real: the app, the CLI, the service. Report the exact commands you ran and what you observed. "Should work" is not verification.
- **C2. One verification tool.** Verification lives in a checked-in tool that agents extend. Do not write throwaway scripts each session.
- **C3. Keep the feature map current.** [docs/feature-map.md](docs/feature-map.md) lists every user-facing feature: what it does, how to reach it, and where its code lives. Update it in the same PR as the feature.
- **C4. Correct is not the same as good.** Verification proves a change works. Quality comes from sections A and B.
- **C5. Model concurrent protocols before building them.** Code that coordinates concurrent actors, such as claims and leases, the stage machine, the outbox, or event delivery, gets a TLA+ model before the code is written. The model runs in CI whenever it or the code it covers changes, and the verification skill says how to run it.
- **C6. Put invariants in structure and check behavior by simulation.** Put each invariant where the build or the store enforces it, in a type, a schema constraint, or a TLA+ property, and prove it can fail with a negative control, such as a planted violation or a mutant. Check behavior by running the real code in a seeded simulation that injects faults and checks those invariants after every step. Write a unit test only for a pure function whose logic a simulation cannot reach, and never one that restates the code.

## D. Adding a feature

- **D1. Copy the closest example.** Find the most similar existing feature and follow its shape.
- **D2. Reproduce before fixing.** For a bug, show the failure with the verification tool before changing code.
- **D3. Do not guess.** Read the code the change touches. If you cannot find evidence for a claim, say so.
- **D4. Small, atomic PRs.** One idea per PR, so history stays readable and reverts stay cheap. Split large changes.
- **D5. Finish the whole change.** Tests, the feature map, and paved-path docs are updated in the same PR as the code.

## E. Working with agents

- **E1. Repeated corrections become checks.** If you correct an agent for the same thing twice, apply the ladder above.
- **E2. Skills come from observed failures.** Write or change an agent skill only after watching an agent fail at something specific. Test the change with an eval before relying on it.
- **E3. Autonomy is earned in steps.** Watched local agents come first, then background or cloud agents, then auto-merge. Move up a step only when verification (C1, C2) and the checks in the enforcement table are in place.

## Stack

Each tool below is the only approved tool for its job (A3). To replace one, or to add a second tool for the same job, change this list in its own PR.

- **Language.** TypeScript on Node 24 LTS, with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` on.
- **Lint.** ESLint with typescript-eslint `strictTypeChecked`, typed from the root tsconfig, from one config at the repository root, run only through `npm run lint`.
- **Boundaries.** dependency-cruiser, from `.dependency-cruiser.json`, run only through `npm run boundaries`.
- **Database.** Postgres. The schema lives in plain SQL migrations that `dbmate` runs. Invariants are schema constraints.
- **Queries.** Kysely, with types that `kysely-codegen` generates from the database. No ORM.
- **Outside data.** zod parses every payload, file, and environment variable where it enters.
- **Secrets.** The app encrypts secrets with AES-256-GCM from `node:crypto` before they reach Postgres. The key comes from a Kubernetes Secret and never reaches the database.
- **Tests.** Vitest against a real Postgres that Testcontainers starts. No database mocks.
- **Formal models.** TLA+, checked with TLC from `tla2tools.jar` v1.7.4 on Java 21, both pinned in the verify image. A model lives in the feature folder of the code it covers (A4).
- **Dashboard.** Next.js App Router. Server components read Postgres, and server actions write to it.
- **Connectors.** Octokit for GitHub. `fetch` and zod for Jira and Webex.
- **Agent runtime.** The Codex app server (`codex app-server`), pinned to one exact Codex CLI version and run inside each attempt's Job. Use only the protocol's stable methods.
- **Deployment.** Kubernetes.

## Paved paths

The first feature, command, or module of each kind defines its paved path. Record it here in the same PR.

- **Layout.** Feature code lives in `features/<name>/`. Entry points live in `services/engine/`, `services/dashboard/`, and `services/job/`, and hold no logic. Code moves to `shared/` only when a second feature needs it. Migrations live in `db/migrations/`, and tools live in `tools/`.
- **TypeScript.** Node 24 runs `.ts` files directly, so there is no build step. Import with the `.ts` extension, use `import type` for types, and write only syntax Node can erase, so no `enum` and no `namespace`. `npm run check` runs `npm run typecheck`, then `npm run lint`, which lints against the root ESLint config and the root tsconfig, so a nested config of either kind changes nothing.
- **Verification.** `npm run verify -- <scenario>` runs one scenario, prints `PASS` or `FAIL` per check, and exits non-zero on any failure. A feature's scenarios live in `features/<name>/verify.ts`, which exports `scenarios`. Run everything inside the verify container, which CI uses too. Install with `docker compose run --rm verify npm ci`, again after any change to the lockfile, then run `docker compose run --rm verify npm run verify -- <scenario>`.
- **Guardrails.** Every check that enforces a rule gets a case in `tools/verify/guardrails.ts`. The case plants a violation in a copy of the repository and passes only when the check rejects it. An exception the check allows gets an allowance case that plants the allowed line and passes only when the check accepts it, beside cases that prove the exception allows nothing more. Each check is an npm script that `npm run check` chains, and a case runs that same script, so it proves the check CI runs. One case per chained script runs `npm run check` itself, so a script dropped from the chain fails too.
- **Boundaries.** `.dependency-cruiser.json` declares them, and `npm run boundaries` enforces them as part of `npm run check`. Imports only point down: `services/` may import `features/` and `shared/`, `features/` may import `shared/`, and `shared/` imports neither. Features never import each other, and no service imports another. `tools/` never imports product code, so it cannot carry one module to another, and neither can a file outside a feature folder, a service folder, `shared/`, or `tools/`. Code in `services/job/` never imports a Postgres client, `kysely`, `shared/db/`, or a `@kubernetes` package, even through a helper. No import rule can see `fetch`, a raw socket, or a module loaded by a computed name, so the Job's pod spec stays its runtime boundary. No import is circular or orphaned.
- **Formal models.** A model is `features/<name>/<Model>.tla` with `<Model>.cfg`, written before the code it covers. Give each guard in the design a boolean constant that the real config sets to `TRUE`. The feature's `verify.ts` runs TLC through `tools/verify/tlc.ts` on the real config, then once per guard with that guard set to `FALSE` and only its property checked. The scenario passes only when the real config holds and every mutant fails. It first parses the config strictly: each invariant sits under `INVARIANTS` and each action or liveness property under `PROPERTIES`, each constant is assigned once, every property and every guard has a mutant, and each bound is at or above the floor `verify.ts` sets. So demoting an invariant, shrinking the model, or dropping a mutant fails too. Larger bounds go in `<Model>.nightly.cfg`. Add the scenario to the `models` job in CI and to the nightly workflow. `features/tasks/` is the example.

## Enforcement

| Rule | Enforced by today | Target |
| --- | --- | --- |
| A5 | `dependency-cruiser` with `.dependency-cruiser.json`, run by `npm run boundaries` and proved by `guardrails` in CI | met |
| A7 | the `tsconfig` flags in [Stack](#stack) and typescript-eslint `strict-type-checked`, run by `npm run check` and proved by `guardrails` in CI | met |
| B1 | `autoworker/no-comments` in `tools/eslint/no-comments.ts`, run by `npm run lint` and proved by `guardrails` in CI | met for TypeScript; TLA+ models have no check yet, and SQL gets its check with the first migration |
| B2 | ESLint `linterOptions.noInlineConfig` with `--max-warnings 0`, `@typescript-eslint/ban-ts-comment`, `no-warning-comments` for `@ts-` in any case, and a config that refuses a suppressions file, run by `npm run lint` and proved by `guardrails` in CI | met |
| C3 | this file | CI check that changes under `features/` also change the feature map |
| C5 | the `models` job runs each model and its mutants in CI on every PR, and the nightly workflow runs larger bounds | met |
| C6 | this file | a CI check that every TLA+ property has a simulator check of the same name, and a mutant run per schema constraint |
| All others | this file | promote when a check becomes possible |

When a rule gains a check, update its row in the same PR.

## Credits

Adapted from two talks by Lauren Tan ([@poteto](https://x.com/poteto)): [how she shipped 2,500 PRs in a month](https://x.com/poteto/status/2102050467505430555) and a [one-hour session on building trust in agents](https://x.com/0xSoural/status/2101310350956048793).
