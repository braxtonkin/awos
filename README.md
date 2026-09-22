# autoworker-oss

AutoWorker takes a ticket all the way to a merged change without a person driving it. A person decides what should happen and reviews the result. The full behavior is specified in [docs/spec.md](docs/spec.md).

## Rules

This repo is built to be worked on by coding agents. Before writing code, whether you are a person or an agent, read [AGENTS.md](AGENTS.md). It sets out how the codebase is designed, how changes are verified, and how features are added. Each rule has an ID you can cite in reviews.

In short: make mistakes impossible instead of reviewing them away, keep one approved way to do each thing, have agents verify their own work, and turn repeated corrections into automated checks.

## Agent skills

`.claude/skills/` and `.claude/agents/` hold a Claude Code port of Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) and three skills from Cursor's [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit). Claude Code loads them for anyone working in this repo. Start with `/poteto-mode`.

## License

[MIT](LICENSE). The agent skills keep their own MIT licenses and copyright notices, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
