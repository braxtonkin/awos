import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import type { Verdict } from '../../shared/db/types.ts';
import { parsePayload } from './payload.ts';
import { attemptsInOrder, taskFor } from './record.ts';

export type Link = { readonly label: string; readonly url: string };

export type StepRun = {
  readonly attempt: string;
  readonly step: string;
  readonly verdict: Verdict | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly inputTokens: number | undefined;
};

export const namedLinks = ['pull request', 'merge commit', 'pull request CI run', 'run branch CI run'] as const;

export type RunLinks = {
  readonly ticket: string;
  readonly named: readonly { readonly label: (typeof namedLinks)[number]; readonly url: string | undefined }[];
  readonly more: readonly Link[];
};

export type RunReport = {
  readonly branch: string;
  readonly driver: string;
  readonly entry: string;
  readonly furthest: string;
  readonly stop: string;
  readonly timeline: readonly { readonly name: string; readonly at: Date }[];
  readonly steps: readonly StepRun[];
  readonly links: RunLinks;
  readonly overheadMs: number;
};

export const tokenUsageMethod = 'thread/tokenUsage/updated';

const tokenUsage = z.object({ params: z.object({ tokenUsage: z.object({ total: z.object({ inputTokens: z.int().nonnegative() }) }) }) });

export const seconds = (ms: number): string => `${String(Math.round(ms / 1000))} s`;

async function inputTokens(db: Database, attempt: string): Promise<number | undefined> {
  const last = await db.selectFrom('attempt_event').select(['seq', 'body']).where('attempt_id', '=', attempt).where('method', '=', tokenUsageMethod).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  return last === undefined ? undefined : parsePayload(`the ${tokenUsageMethod} event ${last.seq} of attempt ${attempt}`, tokenUsage, last.body).params.tokenUsage.total.inputTokens;
}

export async function stepRuns(db: Database, ticket: string): Promise<readonly StepRun[]> {
  const task = await taskFor(db, ticket);
  if (task === undefined) return [];
  const runs: StepRun[] = [];
  for (const attempt of await attemptsInOrder(db, task.id)) {
    runs.push({ attempt: attempt.id, step: attempt.step, verdict: attempt.verdict, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, inputTokens: await inputTokens(db, attempt.id) });
  }
  return runs;
}

export function linksFrom(ticket: string, reached: readonly { readonly links: readonly Link[] }[]): RunLinks {
  const all = reached.flatMap(step => step.links).filter(link => link.label !== 'ticket');
  const named = new Set<string>(namedLinks);
  return {
    ticket,
    named: namedLinks.map(label => ({ label, url: all.find(link => link.label === label)?.url })),
    more: all.filter(link => !named.has(link.label)),
  };
}

const count = (value: number): string => value.toLocaleString('en-US');

function stepRow(run: StepRun): string {
  const duration = run.finishedAt === null ? 'still running' : seconds(run.finishedAt.getTime() - run.startedAt.getTime());
  return `|${run.step}|${run.attempt}|${run.verdict ?? 'none yet'}|${duration}|${run.inputTokens === undefined ? 'none recorded' : count(run.inputTokens)}|`;
}

function linkLine(links: RunLinks): string {
  const present = [{ label: 'ticket', url: links.ticket }, ...links.named.flatMap(link => (link.url === undefined ? [] : [{ label: link.label, url: link.url }])), ...links.more];
  const absent = links.named.filter(link => link.url === undefined).map(link => link.label);
  return `Links: ${present.map(link => `[${link.label}|${link.url}]`).join(', ')}${absent.length === 0 ? '' : `. Missing: ${absent.join(', ')}`}`;
}

export function renderReport(report: RunReport): string {
  const filed = report.timeline[0]?.at.getTime();
  const timeline = report.timeline.map((step, index) => {
    const previous = report.timeline[index - 1]?.at.getTime() ?? step.at.getTime();
    return `|${step.name}|${step.at.toISOString()}|${seconds(step.at.getTime() - (filed ?? step.at.getTime()))}|${seconds(step.at.getTime() - previous)}|`;
  });
  const recorded = report.steps.flatMap(run => (run.inputTokens === undefined ? [] : [run.inputTokens]));
  return [
    'h3. End-to-end report',
    `Run ${report.branch} with the ${report.driver} driver and the catalog entry ${report.entry}. Furthest step: ${report.furthest}. ${report.stop}.`,
    '',
    '||Step||Reached at||Since filed||Duration||',
    ...timeline,
    '',
    ...(report.steps.length === 0
      ? ['AutoWorker recorded no attempts for this ticket.']
      : ['||Step||Attempt||Verdict||Duration||Input tokens||', ...report.steps.map(stepRow), `Input tokens in all: ${count(recorded.reduce((sum, value) => sum + value, 0))}, from ${String(recorded.length)} of ${String(report.steps.length)} attempts.`]),
    '',
    linkLine(report.links),
    `Harness overhead: ${seconds(report.overheadMs)}.`,
  ].join('\n');
}
