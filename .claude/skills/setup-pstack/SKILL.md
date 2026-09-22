---
name: setup-pstack
description: Configure pstack for Claude Code on Opus 5.5. Confirms every role resolves to Opus 5.5, sets panel sizes and review lenses, and writes ~/.claude/pstack-config.md, which the other pstack skills read. Use for /setup-pstack, "configure pstack", "pstack panel size", or changing pstack's defaults.
disable-model-invocation: true
model: claude-opus-5-5
---

# Setup pstack

This port of pstack runs on one model. Every role runs on Opus 5.5 (`claude-opus-5-5`): the parent, code delegates, judgment, prose, and review panels. Subagents get it through the Agent tool's `model: "opus"`. Panels get their diversity from independent fresh contexts and distinct lenses, not from different model families.

Write `~/.claude/pstack-config.md`. Every pstack skill reads it when present and falls back to the defaults in step 4 when it is absent.

## Steps

### 1. Confirm the model

Check that this session runs on Opus 5.5. The environment names the model ID `claude-opus-5-5`. If it does not, tell the user pstack expects Opus 5.5 and that `/model` or the app's model picker switches it.

Read `~/.claude/settings.json`. Both `env.ANTHROPIC_DEFAULT_OPUS_MODEL` and `env.CLAUDE_CODE_SUBAGENT_MODEL` should be `claude-opus-5-5`, so the `opus` alias and any subagent spawned without a model resolve to Opus 5.5. If either is missing or different, offer to set it. Merge into the existing file and keep every other key.

### 2. Load current state

If `~/.claude/pstack-config.md` exists, read it and treat its values as the current choices. Otherwise start from the defaults in step 4.

### 3. Ask

Use AskUserQuestion. Name the current value in each question.

- **Panel size** for architect runners, arena runners, and interrogate reviewers. Options `4 (default)`, `3`, `2`, `6`. More runners cost more tokens and give more independent samples.
- **Swarm default N**, used when the user does not name one. Options `4 (default)`, `2`, `8`.

### 4. Write the config

Overwrite the whole file so re-runs stay idempotent. Shape:

```
# pstack configuration for Claude Code. Every role runs on Opus 5.5.
# Spawn every subagent with the Agent tool's model: "opus". Never another model.
model: claude-opus-5-5 (Agent tool alias: opus)
panel size: 4
swarm default N: 4
interrogate lenses: correctness and edge cases; state, concurrency, and ordering; API and design shape, reader load; security, failure modes, and blast radius
architect lenses: smallest viable shape; domain model first; caller ergonomics first; performance and data layout first
arena lenses: none
```

Lenses are separated by semicolons. A lens list shorter than the panel size repeats from the start. `none` means every runner gets the identical prompt.

### 5. Confirm

Tell the user the config was written. It applies from the next skill invocation. Re-running this skill updates it.

### 6. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof, such as a `verify-*` skill or an existing harness. If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on without pushing.
