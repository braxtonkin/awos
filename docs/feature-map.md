# Feature map

Every user-facing feature, how to reach it, and where its code lives. Update this file in the same PR as the feature (rule C3 in [AGENTS.md](../AGENTS.md)).

| Feature | What it does | How to reach it | Code |
| --- | --- | --- | --- |
| Stored credentials | Stores each person's GitHub token and Codex login sealed with AES-256-GCM. The dashboard's database role can replace a credential but never read one back, and each replacement records who made it and when. The engine opens a credential for the person a run acts as. | No screen yet. `npm run verify -- credentials` runs every behavior against Postgres. | `features/credentials/`, `db/migrations/20260923232000_credential_kinds.sql`, `db/migrations/20260923232100_credentials.sql` |
