# AutoWorker handbook

This handbook explains AutoWorker for the engineer or coding agent who will extend it or rework part of it. It covers why the system is built this way, how it works end to end, how to prove a change, how to add each kind of thing, how to run it on a new machine, and what the live runs taught. It sits beside the four documents that already govern the repository and does not repeat them:

| Document | What it is |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | The rules every change follows, each with an ID, and the paved path for each kind of thing |
| [docs/spec.md](../spec.md) | The system AutoWorker is meant to be |
| [docs/decisions.md](../decisions.md) | Every settled design decision, with the options that lost |
| [docs/feature-map.md](../feature-map.md) | Every user-facing feature, how to reach it, and where its code lives |

## Pick a reading path

Read only the path your task needs. Each page is written to stand alone.

- **New to AutoWorker.** Read [foundation.md](foundation.md), then [architecture.md](architecture.md), then skim [glossary.md](glossary.md).
- **Adding a feature or a plug-in.** Read the recipe for it in [extending.md](extending.md), the rules in `AGENTS.md`, and [verification.md](verification.md) for what to run.
- **Fixing a bug.** Reproduce it first with a scenario or a lane, as [verification.md](verification.md) describes, then read the part of [architecture.md](architecture.md) the bug is in.
- **Reworking a subsystem.** Read "What any rework must keep" in [foundation.md](foundation.md), the architecture section for that subsystem, its decisions in [reference/decisions-index.md](reference/decisions-index.md), and [lessons.md](lessons.md).
- **Setting up a machine or running AutoWorker for real.** Read [operations.md](operations.md).
- **Looking something up.** Use the reference pages below.

## Pages

| Page | Kind | Contents |
| --- | --- | --- |
| [foundation.md](foundation.md) | Explanation | The ideas the design follows, and what any rework must keep |
| [architecture.md](architecture.md) | Explanation | The programs, the life of a ticket, failure routes, Land, Verify, the Job, and the dashboard |
| [lessons.md](lessons.md) | Explanation | Each failure the live runs found, and the rule it left |
| [verification.md](verification.md) | How-to | What proves what, and which checks to run for which change |
| [extending.md](extending.md) | How-to | Recipes for each kind of thing, with its example file |
| [operations.md](operations.md) | How-to | Setting up a machine, connecting accounts, holding AutoWorker against a real repository, reading a live task, landing a change, and fixing common problems |
| [glossary.md](glossary.md) | Reference | Every term, with one meaning |
| [reference/data-model.md](reference/data-model.md) | Reference | Every table, column, enum, and named guard |
| [reference/engine.md](reference/engine.md) | Reference | Loops, settings, admin commands, and person actions |
| [reference/code-change.md](reference/code-change.md) | Reference | The Code change workflow's steps, verdicts, routes, caps, obligations, and Land's rules |
| [reference/scenarios.md](reference/scenarios.md) | Reference | Every `npm run verify` scenario, what it proves, and what it needs |
| [reference/decisions-index.md](reference/decisions-index.md) | Reference | All settled decisions, grouped by area |

## Keep the handbook true

When a change makes a page wrong, fix the page in the same pull request, as rule D5 asks for the feature map and the paved-path docs. Prefer linking to the code over copying it, because a copied value goes stale. The pages cite paths and symbol names, not line numbers, for the same reason.
