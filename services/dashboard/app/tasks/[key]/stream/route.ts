import { cursorOf } from '../../../../../../features/task-page/protocol.ts';
import { taskIdOf } from '../../../../../../features/task-page/read.ts';
import { frames } from '../../../../../../features/task-page/stream.ts';
import { sse } from '../../../../../../shared/sse.ts';
import { database } from '../../../../database.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { readonly params: Promise<{ readonly key: string }> }): Promise<Response> {
  const { key } = await context.params;
  const db = database();
  const task = await taskIdOf(db, key);
  if (task === undefined) return new Response('No task has that key.', { status: 404 });
  const after = cursorOf(request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after'));
  return sse(frames(db, task, after, request.signal));
}
