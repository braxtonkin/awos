import { frames } from '../../../../features/overview/stream.ts';
import { sse } from '../../../../shared/sse.ts';
import { database } from '../../database.ts';
import { acting } from '../../identity.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return sse(frames(database(), await acting(), request.signal));
}
