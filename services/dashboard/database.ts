import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';

const settings = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });

const connections = 10;

let opened: Database | undefined;

export const database = (): Database => {
  opened ??= connect(settings.parse(process.env).DATABASE_URL, connections);
  return opened;
};
