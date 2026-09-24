import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { codexLogin } from '../../shared/codex-login.ts';
import { refreshable, type Check, type Checked, type RefreshUse } from './kinds.ts';

export type CodexCheckSettings = { readonly timeoutMs: number };

export type CodexProbe = {
  readonly checked: Checked;
  readonly wallMs: number;
  readonly inputTokens: number | null;
  readonly models: readonly string[];
};

type Finished = { readonly exit: number | null; readonly timedOut: boolean; readonly spawnError: string | null; readonly stdout: string; readonly stderr: string };

type Events = { readonly models: readonly string[]; readonly inputTokens: number | null; readonly errors: readonly string[] };

export const checkModel = 'gpt-6-luna';

export const codexHomePrefix = 'autoworker-codex-home-';

const prompt = 'Reply with ack and nothing else.';

const fileAuthConfig = `cli_auth_credentials_store = "file"\nmodel = "${checkModel}"\n`;

const json = z.string().transform((text, context): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    context.issues.push({ code: 'custom', message: 'must be JSON', input: undefined });
    return z.NEVER;
  }
});

const event = json.pipe(z.looseObject({ type: z.string() }));

const usage = z.looseObject({ usage: z.looseObject({ input_tokens: z.int().nonnegative() }) });

const failure = z.union([
  z.looseObject({ type: z.literal('error'), message: z.string() }),
  z.looseObject({ type: z.literal('turn.failed'), error: z.looseObject({ message: z.string() }) }),
]);

const loginTokens = json.pipe(z.looseObject({ tokens: z.record(z.string(), z.unknown()) }));

const unauthorized = /\b401\b|unauthori[sz]ed/i;

function modelsIn(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(modelsIn);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => (key === 'model' && typeof inner === 'string' ? [inner] : modelsIn(inner)));
}

function readEvents(stdout: string): Events {
  const parsed = stdout.split('\n').flatMap(line => {
    const result = event.safeParse(line);
    return result.success ? [result.data] : [];
  });
  const tokens = parsed.flatMap(each => {
    const result = usage.safeParse(each);
    return result.success ? [result.data.usage.input_tokens] : [];
  });
  const errors = parsed.flatMap(each => {
    const result = failure.safeParse(each);
    if (!result.success) return [];
    return [result.data.type === 'error' ? result.data.message : result.data.error.message];
  });
  return { models: [...new Set(parsed.flatMap(modelsIn))], inputTokens: tokens.length === 0 ? null : tokens.reduce((sum, each) => sum + each, 0), errors };
}

function secretsOf(login: string): readonly string[] {
  const parsed = loginTokens.safeParse(login);
  if (!parsed.success) return [];
  return Object.values(parsed.data.tokens).filter((value): value is string => typeof value === 'string' && value.length >= 16);
}

const scrub = (text: string, secrets: readonly string[]): string =>
  secrets
    .reduce((scrubbed, secret) => scrubbed.replaceAll(secret, '<token>'), text)
    .replace(/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt>')
    .replace(/\brt_[\w-]+/g, '<refresh-token>')
    .replace(/[\w-]{40,}/g, '<redacted>');

function quote(finished: Finished, events: Events, secrets: readonly string[]): string {
  const stderr = finished.stderr.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('WARNING: proceeding') && !line.startsWith('Reading additional input'));
  const text = events.errors.length > 0 ? [...new Set(events.errors)].slice(-2).join(' | ') : stderr.slice(-3).join(' | ');
  const scrubbed = scrub(text, secrets);
  return scrubbed.length > 400 ? `${scrubbed.slice(0, 400)}...` : scrubbed;
}

function runCodex(home: string, work: string, timeoutMs: number): Promise<Finished> {
  return new Promise(resolve => {
    const child = spawn(
      'codex',
      ['exec', '--model', checkModel, '--ephemeral', '--skip-git-repo-check', '--json', '--output-last-message', join(home, 'last-message.txt'), prompt],
      { cwd: work, env: { PATH: process.env['PATH'] ?? '', HOME: home, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const finish = (exit: number | null, spawnError: string | null): void => {
      clearTimeout(timer);
      resolve({ exit, timedOut, spawnError, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', error => {
      finish(null, error.message);
    });
    child.on('close', exit => {
      finish(exit, null);
    });
  });
}

const readOrNull = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null);

function expiryOf(login: string | null): Date | null {
  if (login === null) return null;
  const parsed = codexLogin.safeParse(login);
  return parsed.success ? new Date(parsed.data.tokens.access_token.exp * 1000) : null;
}

function verdictOf(finished: Finished, events: Events, reply: string | null, secrets: readonly string[]): Pick<Checked, 'verdict' | 'cause'> {
  if (finished.spawnError !== null) return { verdict: 'unknown', cause: `Codex could not start: ${finished.spawnError}` };
  if (finished.timedOut) return { verdict: 'unknown', cause: `Codex did not finish before the check timed out, so the login was not judged. Last output: ${quote(finished, events, secrets) || 'none'}` };
  const others = events.models.filter(model => model !== checkModel);
  if (others.length > 0) return { verdict: 'unknown', cause: `Codex ran on ${others.join(', ')}, not ${checkModel}, so the check does not count.` };
  if (finished.exit === 0 && reply?.trim().toLowerCase() === 'ack') return { verdict: 'valid', cause: `Codex answered ack on ${checkModel}.` };
  const said = quote(finished, events, secrets);
  if (unauthorized.test([...events.errors, finished.stderr].join('\n'))) return { verdict: 'invalid', cause: `The Codex API refused the login with 401 unauthorized: ${said}` };
  if (finished.exit === 0) return { verdict: 'unknown', cause: `Codex exited 0 but replied ${JSON.stringify(scrub(reply ?? '', secrets).slice(0, 80))} instead of ack.` };
  return { verdict: 'unknown', cause: `Codex exited with code ${String(finished.exit)}: ${said}` };
}

export type CodexExit = { readonly ranToItsEnd: boolean; readonly before: string; readonly after: string | null };

export function refreshUse({ ranToItsEnd, before, after }: CodexExit): RefreshUse {
  if (after !== null && after !== before) return { kind: 'rotated', login: after };
  return ranToItsEnd && after === before ? { kind: 'unused' } : { kind: 'maybe-used' };
}

const ranToItsEnd = (finished: Finished): boolean => finished.spawnError !== null || (!finished.timedOut && finished.exit !== null);

export async function probeCodex(settings: CodexCheckSettings, login: string): Promise<CodexProbe> {
  const home = await mkdtemp(join(tmpdir(), codexHomePrefix));
  const started = performance.now();
  try {
    const work = join(home, 'work');
    const auth = join(home, 'auth.json');
    await mkdir(work, { mode: 0o700 });
    await writeFile(auth, login, { mode: 0o600 });
    await writeFile(join(home, 'config.toml'), fileAuthConfig, { mode: 0o600 });
    const finished = await runCodex(home, work, settings.timeoutMs);
    const wallMs = performance.now() - started;
    const events = readEvents(finished.stdout);
    const reply = await readOrNull(join(home, 'last-message.txt'));
    const after = await readOrNull(auth);
    const secrets = [...secretsOf(login), ...(after === null ? [] : secretsOf(after))];
    const checked: Checked = { ...verdictOf(finished, events, reply, secrets), expiresAt: expiryOf(after) ?? expiryOf(login), refresh: refreshUse({ ranToItsEnd: ranToItsEnd(finished), before: login, after }) };
    return { checked, wallMs, inputTokens: events.inputTokens, models: events.models };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export const codexCheck = (settings: CodexCheckSettings): Check => ({
  rotates: refreshable,
  run: async login => (await probeCodex(settings, login)).checked,
});
