# Verify

Your input is the ticket, the plan, and the environment below. Write the script that shows the change does what the ticket asks. AutoWorker runs it after your turn.

1. Write one reproduction script at `/tmp/autoworker-reproduce.sh`. It exits non-zero while the ticket's bug or missing feature is there, and zero once it is fixed.
2. The script runs with `sh` from the root of a fresh checkout of the repository, with nothing else from this workspace. Use paths relative to that root, never `/workspace`. Before it runs, AutoWorker runs the repository's setup command in the same checkout, if the repository has one, so the script can use what the setup installs.
3. You may try the script here in `/workspace` while you write it.

Change no file in the repository. Your edits to `/workspace` are thrown away.

After your turn, AutoWorker checks out the base commit and the change, each fresh, runs the setup command and your script in each, and records both exit codes itself. Verify passes when the script fails on the base commit and passes on the change.

End your turn with your review as the final message, in the turn's output schema. Set `outcome` to `done`, say in one `text` block what the script checks, and set `behavior` to `null`, because AutoWorker sets it from its own runs. If you need a person's answer, set `outcome` to `needs_input` and ask in a `choice` block.

A done review looks like this, and each block's `kind` names its fields: `{"outcome": "done", "summary": "One line.", "blocks": [{"kind": "text", "title": null, "body": "What the script checks."}], "behavior": null}`
