import type { z } from 'zod';

export class PayloadRejected extends Error {
  override readonly name = 'PayloadRejected';
}

const fieldOf = (path: readonly PropertyKey[]): string => (path.length === 0 ? 'the payload' : path.map(String).join('.'));

export function parsePayload<Schema extends z.ZodType>(source: string, schema: Schema, payload: unknown): z.output<Schema> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map(issue => `${fieldOf(issue.path)}: ${issue.message}`);
  throw new PayloadRejected(`${source} rejected, ${fields.join('; ')}`);
}
