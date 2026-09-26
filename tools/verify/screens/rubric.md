# Screen quality rubric

Every screen of the AutoWorker dashboard prototype is judged on the dimensions below. The agent conversation is its own group, `agent`, with its own find questions, because the owner ranks it among the most important parts of the product. A screen passes when it clears every objective gate, and when both independent reviewers score it 4 or higher on every scored dimension. A group passes when every screen in it passes and the group clears the two group dimensions. The loop runs until every group passes.

The owner's standing taste applies to every judgment:
- Visuals are clean and minimal, with no noise.
- Finding the work you want is obvious and not messy.
- The Graphite palette uses color only for state. Amber means a person is needed, blue means running, and red means failed. Green appears only on the small "landed" dot or pill, and never anywhere else.

## Screen dimensions

Each dimension has an objective gate where one can be measured from the DOM at 1440 pixels wide, above the fold. Each also gets a reviewer score from 1 to 5, where 5 means nothing to fix, 4 means minor polish only, 3 means a real problem a user would notice, 2 means it gets in the way, and 1 means it's broken.

1. **Visual clutter.** How much competes for the eye.
   - The gate counts boxed regions (a visible border or a fill that differs from the page), distinct font sizes, distinct font weights, non-grey colors, visible controls outside the top bar, and words above the fold.
   - Words count per view as the person sees it: the page with its open tab, above the fold. Each tab is its own screen. The limit is `limits.words` in `limits.json`.
   - The limits are set by calibration: `task-a-live`, the busy page the owner rejected, must fail, and each limit keeps a margin. Record the calibration table beside the limits.
   - The reviewer asks whether the screen is calm, and whether anything is there that the person doesn't need right now.
2. **Hierarchy.** One focal point. The most important thing, usually the state and the next action, is the most prominent. The gate is at most one primary-styled button per screen. The reviewer asks where the eye lands first and whether that is the right place.
3. **Findability.** The person finds what they came for at a glance. Each group lists three find questions, such as "Which task needs your approval?" The reviewer answers each from the screenshot alone and notes how long the path was. The score falls when an answer needs scrolling, a tab switch, or a guess.
4. **State clarity.** What is happening now, what needs a person, and what failed are plain at a glance. The gate is that every state color sits beside a text label, so color never carries meaning alone, and that green appears only on landed. The reviewer asks whether a newcomer could say the state of every item shown.
5. **Actionability.** The next action is obvious, named with a verb, and sits beside what it acts on. Destructive actions, such as Stop, are neither primary nor next to Approve. The reviewer asks what they would click next, and whether that is correct.
6. **Language.** Plain, short, and specific text in sentence case, using one name per thing: task, step, routine, repository, login. A note that asks for help says exactly what to do. The gate allows no title-case headings, no button label over 4 words, and none of these internal terms: attempt id, lease, outbox, verdict, enum, stage machine. The reviewer asks whether each sentence would make sense to a teammate who has never seen the code.
7. **Spacing and alignment.** Elements sit on shared edges, and gaps come from one scale. The gate is that every margin, padding, and gap is in {0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64} pixels, and every font size is in the prototype's type scale. The reviewer asks whether anything is cramped, orphaned, or misaligned.
8. **Palette and contrast.** The gate is text contrast of at least 4.5:1 for body text and 3:1 for large text and icons, in both light and dark themes, plus the green rule above. There is no reviewer score, because the gate decides.
9. **Communication with the agent.** The owner calls this one of the most important parts of the product, above all on the task page a person opens by clicking a task that is in progress or has failed. It applies to every screen that shows an agent, its messages, or a way to talk to it. On a failed task, the person learns in one sentence why it failed and what the agent tried. They can tell the agent what to do differently, through Retry with a note, and then see that the next attempt received the note.
   - The person can tell what the agent is doing now, and why, in plain words, without reading raw logs.
   - Every message the person sends, whether a steer, a note, or an answer, shows whether it was sent, whether the agent received it, and what the agent did about it.
   - An agent's question stands out and can be answered in place.
   - Who said what, and in what order, is clear, with times.
   - Tool output is collapsed by default, with details one click away.
   - Stop is always reachable while the agent runs, and it says what stopping will keep.

   The gate: every message the person sent carries a delivery state, no raw JSON or stack trace is visible by default, and an open agent question has an answer control in view. The reviewer asks whether they could hold a useful conversation with the agent from this screen alone, and whether they would trust that it heard them.

## Group dimensions

10. **Consistency.** The same thing looks and behaves the same across the group's screens: status marks, buttons, headers, and the type and spacing scales. A reviewer sees the whole group at once and scores it from 1 to 5.
11. **Coverage.** The group shows its empty, busy, waiting, and error states wherever those can happen. The gate is a checklist the group's owner fills in and a reviewer confirms.

## Reviewers

- Each group gets two reviewers per round, the number `reviewers` in `limits.json`. They are fresh Opus 5.5 contexts that never see the fixer's reasoning, earlier rounds' scores, or each other.
- A reviewer gets this rubric, the group's screenshots, the objective metrics, and the find questions.
- For every score below 5, the reviewer names the problem, gives its box on the screenshot in pixels, and proposes a fix in one sentence.
- A reviewer scores what they see. They don't soften a score because the screen is only a prototype.

## The loop

1. Capture every scene and measure the gates.
2. Review each group that has not yet passed.
3. Fix the prototype for every failing item.
4. Capture again and review again.
5. Stop when every group passes, or after 6 rounds, and report what still fails.

The fixer never edits this rubric, the gate limits, the find questions, or the control scenes. A fix that passes a gate by hiding information the person needs is a failure. Findability and state clarity catch that. The controls are recaptured every round, and `task-a-live` must keep failing visual clutter. If it passes, the gates have drifted and the round is void.
