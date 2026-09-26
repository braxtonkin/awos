# Implement

Your input is the plan below, and, when the task came back to this step, what sent it back. Make the change the plan describes in this workspace, and run the repository's fast test command until it passes.

When your input says AutoWorker started merging the base branch, finish that merge before anything else. `git status` lists the files that conflict. Resolve each one so the result keeps what both sides meant to do, and follow the repository's AGENTS.md where it says how to resolve conflicts or in what order. Remove every conflict marker, then make any change the rest of your input asks for and run the repository's checks. Do not commit, abort, or restart the merge. AutoWorker commits it with the base commit as its second parent once you stop, and pushes nothing while a file holds a conflict marker or a file the base changed without a conflict is back to this branch's version.

Do not commit, push, or open a pull request. AutoWorker commits and pushes the workspace once you stop. Stop once the change is made and the tests pass.

End your turn with your review as the final message, in the turn's output schema. Set `outcome` to `done`, and say what changed in one `text` block. If you need a person's answer, set `outcome` to `needs_input` and ask in a `choice` block. Set `outcome` to `blocked` when you cannot make the change, and say why in the summary.

A done review looks like this, and each block's `kind` names its fields: `{"outcome": "done", "summary": "One line.", "blocks": [{"kind": "text", "title": null, "body": "What changed."}]}`
