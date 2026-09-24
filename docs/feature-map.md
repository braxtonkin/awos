# Feature map

Every user-facing feature, how to reach it, and where its code lives. Update this file in the same PR as the feature (rule C3 in [AGENTS.md](../AGENTS.md)).

| Feature | What it does | How to reach it | Code |
| --- | --- | --- | --- |
| End-to-end test | Makes a run branch, `e2e/run-<id>`, from the sandbox folder alone, files an SBX ticket on it, lets a driver play AutoWorker, and checks each step against Jira, GitHub, and the `task` table: ticket filed, task recorded, plan posted, draft pull request, evidence posted, and merged. Then it posts a report on the ticket. The `throwaway` driver runs the real agent on gpt-6-luna. The `identity` driver implements the ticket as a function that returns its input, so the acceptance test must fail. The `none` driver is the negative control. | `docker compose run --rm live npm run verify -- e2e --driver throwaway`. Add `--driver none --timeout 120` for the negative control, `--branch <run branch>` to reuse a run branch, and `--entry <name>` to pick a catalog entry. `npm run verify -- e2e-branch` prints a new run branch. `npm run verify -- e2e-payload` proves that each payload schema rejects a missing field by name. | `features/e2e/` |
