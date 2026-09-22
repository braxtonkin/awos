# Rules for autoworker-oss

These rules apply to every change in this repo, whether an agent or a person wrote it. [docs/spec.md](docs/spec.md) specifies the system these rules build. Every rule has an ID. Cite IDs in reviews and commit messages, for example `move parser into its feature folder (A4)`.

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
- **Database.** Postgres. The schema lives in plain SQL migrations that `dbmate` runs. Invariants are schema constraints.
- **Queries.** Kysely, with types that `kysely-codegen` generates from the database. No ORM.
- **Outside data.** zod parses every payload, file, and environment variable where it enters.
- **Secrets.** The app encrypts secrets with AES-256-GCM from `node:crypto` before they reach Postgres. The key comes from a Kubernetes Secret and never reaches the database.
- **Tests.** Vitest against a real Postgres that Testcontainers starts. No database mocks.
- **Dashboard.** Next.js App Router. Server components read Postgres, and server actions write to it.
- **Connectors.** Octokit for GitHub. `fetch` and zod for Jira and Webex.
- **Agent runtime.** The Codex CLI, run as `codex exec --json` inside the task's workspace.
- **Deployment.** Kubernetes.

## Paved paths

None yet. The first feature, command, or module of each kind defines its paved path; record it here in the same PR.

## Enforcement

| Rule | Enforced by today | Target |
| --- | --- | --- |
| A5 | this file | `dependency-cruiser` in CI |
| A7 | this file | the `tsconfig` flags in [Stack](#stack) and typescript-eslint `strict-type-checked` |
| B1 | this file | a custom ESLint rule that rejects comments |
| B2 | this file | ESLint `linterOptions.noInlineConfig` and `@typescript-eslint/ban-ts-comment` |
| C3 | this file | CI check that changes under `features/` also change the feature map |
| All others | this file | promote when a check becomes possible |

When a rule gains a check, update its row in the same PR.

## Credits

Adapted from two talks by Lauren Tan ([@poteto](https://x.com/poteto)): [how she shipped 2,500 PRs in a month](https://x.com/poteto/status/2102050467505430555) and a [one-hour session on building trust in agents](https://x.com/0xSoural/status/2101310350956048793).
