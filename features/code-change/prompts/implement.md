# Implement

Your input is the plan below, and, when the task came back to this step, what sent it back. Make the change the plan describes in this workspace, and run the repository's fast test command until it passes.

Do not commit, push, or open a pull request. AutoWorker commits and pushes the workspace once you stop. Stop once the change is made and the tests pass.

End your turn with your review as the final message, in the turn's output schema. Set `outcome` to `done`, and say what changed in one `text` block. If you need a person's answer, set `outcome` to `needs_input` and ask in a `choice` block. Set `outcome` to `blocked` when you cannot make the change, and say why in the summary.

A done review looks like this, and each block's `kind` names its fields: `{"outcome": "done", "summary": "One line.", "blocks": [{"kind": "text", "title": null, "body": "What changed."}]}`
