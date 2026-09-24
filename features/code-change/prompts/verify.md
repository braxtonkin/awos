# Verify

Your input is the ticket, the plan, and the environment below. Show that the change does what the ticket asks.

1. Write one reproduction script at `/tmp/autoworker-reproduce.sh`. It exits non-zero while the ticket's bug or missing feature is there, and zero once it is fixed. Keep it outside the repository.
2. Run exactly `cat /tmp/autoworker-reproduce.sh`.
3. Run `git worktree add --detach /tmp/autoworker-base <base commit>`, with the base commit named below.
4. Run exactly `cd /tmp/autoworker-base && sh /tmp/autoworker-reproduce.sh`. It must fail.
5. Run exactly `cd /workspace && sh /tmp/autoworker-reproduce.sh`. It must pass.

Change no file in the repository. Stop once both runs are done.

End your turn with your review as the final message, in the turn's output schema. Set `outcome` to `done`, put the script and both runs in one `text` block, and set `behavior` to `fixed` when the second run passed, `still_wrong` when it failed, or `null` when the environment kept you from running both. AutoWorker checks both runs against its own record of your commands. If you need a person's answer, set `outcome` to `needs_input` and ask in a `choice` block.
