import { logTail, type FailedCheck } from '../../shared/rework.ts';
import type { ActionsJob, ClientFor, GithubClient, NamedCheckRun } from './client.ts';

type Checks = readonly [FailedCheck, ...FailedCheck[]];

const escape = String.fromCharCode(27);

const bell = String.fromCharCode(7);

const escapes = new RegExp(`${escape}\\[[0-9;?]*[A-Za-z]|${escape}\\][^${bell}]*${bell}`, 'g');

const stamps = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/gm;

export function tailOf(log: string): string {
  const lines = log.replace(escapes, '').replace(stamps, '').replace(/\r\n?/g, '\n').trimEnd().split('\n').slice(-logTail.lines);
  while (lines.length > 1 && lines.join('\n').length > logTail.characters) lines.shift();
  return lines.join('\n').slice(-logTail.characters);
}

const failingStep = ({ steps }: ActionsJob): string | null => steps?.find(step => step.conclusion === 'failure' || step.conclusion === 'timed_out' || step.conclusion === 'cancelled')?.name ?? null;

const unread = (name: string, why: string): FailedCheck => ({ name, kind: 'unread', why });

const described = (name: string, run: NamedCheckRun): FailedCheck => {
  const text = [run.output.title, run.output.summary].filter(part => part !== null && part.trim() !== '').join(': ');
  return { name, kind: 'described', conclusion: run.conclusion ?? run.status, description: text === '' ? null : text, url: run.details_url };
};

async function readRun(client: GithubClient, repository: string, name: string, run: NamedCheckRun, signal: AbortSignal): Promise<FailedCheck> {
  if (run.app?.slug !== 'github-actions') return described(name, run);
  const [job, log] = await Promise.all([client.actionsJob(repository, run.id, signal), client.jobLog(repository, run.id, signal)]);
  if (!('ok' in log)) return described(name, run);
  return { name, kind: 'logged', conclusion: run.conclusion ?? run.status, step: 'ok' in job ? failingStep(job.ok) : null, log: tailOf(log.ok) };
}

async function readOne(client: GithubClient, repository: string, head: string, name: string, signal: AbortSignal): Promise<FailedCheck> {
  const runs = await client.checkRunsNamed(repository, head, name, signal);
  if (!('ok' in runs)) return unread(name, `GitHub answered ${String(runs.status)} to the check runs of ${head}: ${runs.message}`);
  const run = runs.ok.find(found => found.conclusion !== 'success' && found.conclusion !== 'neutral' && found.conclusion !== 'skipped') ?? runs.ok[0];
  if (run !== undefined) return readRun(client, repository, name, run, signal);
  const statuses = await client.commitStatuses(repository, head, signal);
  if (!('ok' in statuses)) return unread(name, `GitHub answered ${String(statuses.status)} to the statuses of ${head}: ${statuses.message}`);
  const status = statuses.ok.find(found => found.context === name);
  return status === undefined
    ? unread(name, `GitHub reports no check run or status named ${name} on ${head}`)
    : { name, kind: 'described', conclusion: status.state, description: status.description, url: status.target_url };
}

export const failedChecksReader =
  (clientFor: ClientFor, timeoutMs: number) =>
  async (actsAs: string, repository: string, head: string, [first, ...rest]: readonly [string, ...string[]]): Promise<Checks> => {
    const client = await clientFor(actsAs);
    if ('failed' in client) return [unread(first, client.failed), ...rest.map(name => unread(name, client.failed))];
    const signal = AbortSignal.timeout(timeoutMs);
    return [await readOne(client, repository, head, first, signal), ...(await Promise.all(rest.map(name => readOne(client, repository, head, name, signal))))];
  };
