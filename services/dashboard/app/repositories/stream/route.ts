import { frames } from '../../../../../features/repository-settings/stream.ts';
import { sse } from '../../../../../shared/sse.ts';
import { database } from '../../../database.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return sse(frames(database(), request.signal));
}
