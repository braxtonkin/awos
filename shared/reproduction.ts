import { z } from 'zod';

export const reproductionPath = '/tmp/autoworker-reproduce.sh';

export const setupLog = '/tmp/autoworker-setup.log';

export const outputLimit = 16_000;

const commit = z.string().regex(/^[0-9a-f]{40}$/);

const ranScript = z.object({ exitCode: z.int().nullable(), timedOut: z.boolean(), output: z.string().max(outputLimit + 200) });

export type RanScript = z.infer<typeof ranScript>;

const side = z.object({ commit, checkout: z.string().max(outputLimit + 200).nullable(), setup: ranScript.nullable(), run: ranScript.nullable() });

export type Side = z.infer<typeof side>;

export const reproduction = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ran'), script: z.string().max(outputLimit + 200), base: side, change: side }),
  z.object({ state: z.literal('no_script'), reason: z.string().max(outputLimit + 200) }),
]);

export type Reproduction = z.infer<typeof reproduction>;

export type Behavior = 'fixed' | 'still_wrong' | null;

const cleanExit = (ran: RanScript | null): number | null => (ran === null || ran.timedOut ? null : ran.exitCode);

const setupFailed = (given: Side): boolean => given.checkout !== null || (given.setup !== null && cleanExit(given.setup) !== 0);

export function behaviorOf(given: Reproduction): Behavior {
  if (given.state === 'no_script' || setupFailed(given.base) || setupFailed(given.change)) return null;
  const before = cleanExit(given.base.run);
  const after = cleanExit(given.change.run);
  if (before === null || after === null || before === 0) return null;
  return after === 0 ? 'fixed' : 'still_wrong';
}

const shownLimit = 4000;

const tokenShapes = /\b(?:gh[pousr]_\w+|github_pat_\w+|ATATT[\w=-]+|eyJ[\w-]+\.[\w.-]+)/g;

const shown = (text: string): string => {
  const redacted = text.trim().replace(tokenShapes, '[redacted]');
  return redacted.length <= shownLimit ? redacted : `${redacted.slice(0, shownLimit)}\n[cut after ${String(shownLimit)} characters]`;
};

const exited = (ran: RanScript): string => (ran.timedOut ? 'ran out of time' : ran.exitCode === null ? 'ended without a code' : `exited ${String(ran.exitCode)}`);

const block = (ran: RanScript): string => `\`\`\`\n${shown(ran.output)}\n\`\`\``;

const sideText = (where: string, given: Side): string => {
  if (given.checkout !== null) return `${where}: AutoWorker could not check out \`${given.commit}\`, so the script did not run.\n\n\`\`\`\n${shown(given.checkout)}\n\`\`\``;
  const place = `${where}: AutoWorker checked out \`${given.commit}\` fresh`;
  if (given.setup !== null && given.run === null) return `${place}, and its setup command ${exited(given.setup)}, so the script did not run.\n\n${block(given.setup)}`;
  if (given.run === null) return `${place}, and the script did not run.`;
  return `${place}, ran the script, and it ${exited(given.run)}.\n\n${block(given.run)}`;
};

export const evidenceText = (evidence: unknown): string | null => {
  const parsed = reproduction.safeParse(evidence);
  if (!parsed.success) return null;
  if (parsed.data.state === 'no_script') return `AutoWorker ran no reproduction, because ${parsed.data.reason}.`;
  return [`Reproduction script:\n\n\`\`\`sh\n${shown(parsed.data.script)}\n\`\`\``, sideText('On the base commit', parsed.data.base), sideText('On the change', parsed.data.change)].join('\n\n');
};
