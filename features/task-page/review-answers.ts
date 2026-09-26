import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { connect } from '../../shared/db/client.ts';
import { answerWithin, request, type RequestAnswer } from '../../shared/requests.ts';
import { review, type Answer, type Review } from '../../shared/review.ts';
import { fail, pass, type Line } from '../../tools/verify/check.ts';
import { withWorld } from '../../tools/verify/dashboard.ts';
import { actingPerson } from '../../tools/verify/screens/screens.ts';

const answerWaitMs = 60_000;

const extraBlocks: Review['blocks'] = [
  { kind: 'checklist', title: 'Checks to keep', items: [{ id: 'unit', label: 'Run the unit tests' }, { id: 'lint', label: 'Run the linter' }] },
  { kind: 'draft', title: 'Pull request text', body: 'Retry the sandbox client with backoff.' },
];

type Sent = { readonly name: string; readonly answer: Answer; readonly kind: string | null };

const said = (answer: RequestAnswer | undefined): string => (answer === undefined ? 'no row' : JSON.stringify(answer));

export async function reviewAnswers(): Promise<readonly Line[]> {
  const echo = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  return withWorld(['question'], echo, async world => {
    const db = connect(world.ownerUrl, 2);
    try {
      const key = world.keys.get('question');
      if (key === undefined) throw new Error('local-engine printed no key for the question seed');
      const task = await db.selectFrom('task').select(['id', 'review_attempt']).where('key', '=', key).executeTakeFirstOrThrow();
      if (task.review_attempt === null) throw new Error(`task ${key} waits on no review`);
      const attempt = await db.selectFrom('attempt').select('output').where('id', '=', task.review_attempt).executeTakeFirstOrThrow();
      const asked = review.loose().parse(attempt.output);
      const choice = asked.blocks.findIndex(block => block.kind === 'choice');
      const picked = asked.blocks[choice];
      if (picked?.kind !== 'choice') throw new Error(`the review of task ${key} holds no choice block`);
      const planted = { ...asked, blocks: [...asked.blocks, ...extraBlocks] };
      const reviewed = task.review_attempt;
      await db.transaction().execute(async tx => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await tx.updateTable('attempt').set({ output: JSON.stringify(planted) }).where('id', '=', reviewed).execute();
      });
      const person = (await db.selectFrom('person').select('id').where('name', '=', actingPerson).executeTakeFirstOrThrow()).id;
      const at = asked.blocks.length;
      const sends: readonly Sent[] = [
        { name: 'a pick on the choice block', answer: { kind: 'pick', block: choice, option: picked.recommended ?? picked.options[0]?.id ?? '' }, kind: 'pick_choice' },
        { name: 'an untick on the checklist block', answer: { kind: 'untick', block: at, items: ['lint'] }, kind: 'untick_items' },
        { name: 'an edit of the draft block', answer: { kind: 'edit', block: at + 1, body: 'Retry the sandbox client with capped backoff.' }, kind: 'edit_draft' },
        { name: 'the plant, an answer to a block that does not exist', answer: { kind: 'pick', block: at + 9, option: 'none' }, kind: null },
      ];
      const lines: Line[] = [];
      for (const sent of sends) {
        const id = randomUUID();
        await request(db, { id, person, at: new Date(), kind: 'answer', target: task.id, payload: { review: task.review_attempt, answer: sent.answer } });
        const answer = await answerWithin(db, id, answerWaitMs);
        if (sent.kind === null) {
          const refused = answer !== undefined && answer !== 'waiting' && 'refused' in answer;
          lines.push((refused ? pass : fail)(`the engine refuses ${sent.name}`, said(answer)));
          continue;
        }
        const action = await db.selectFrom('human_action').select(['kind', sql<string>`detail::text`.as('detail')]).where('id', '=', id).executeTakeFirst();
        const recorded = answer !== undefined && answer !== 'waiting' && 'recorded' in answer;
        const fields = Object.keys(sent.answer).sort();
        const same = action?.kind === sent.kind && JSON.stringify(JSON.parse(action.detail), fields) === JSON.stringify(sent.answer, fields);
        lines.push((recorded && same ? pass : fail)(`the engine records ${sent.name} as ${sent.kind}`, `${said(answer)}, action ${action === undefined ? 'missing' : `${action.kind} ${action.detail}`}`));
      }
      return lines;
    } finally {
      await db.destroy();
    }
  });
}
