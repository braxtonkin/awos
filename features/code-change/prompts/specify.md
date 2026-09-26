# Specify

Your input is the ticket below. Read it and the repository, then write a plan for the change: what changes where, and how Verify will show that it works.

Change no file. Stop once the plan is written.

End your turn with your review as the final message, in the turn's output schema. Set `outcome` to `done`, and put the whole plan in one `text` block. If you cannot plan without a person's answer, set `outcome` to `needs_input` and ask in a `choice` block. Set `outcome` to `blocked` when you cannot plan at all, and say why in the summary.

A done review looks like this, and each block's `kind` names its fields: `{"outcome": "done", "summary": "One line.", "blocks": [{"kind": "text", "title": null, "body": "The plan."}]}`
