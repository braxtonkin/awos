import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tlaTools = '/opt/tla/tla2tools.jar';

export type TraceState = { readonly action: string; readonly text: string };

export type TlcRun = {
  readonly clean: boolean;
  readonly distinctStates: number | undefined;
  readonly error: string | undefined;
  readonly trace: readonly TraceState[];
  readonly loop: readonly TraceState[];
  readonly loopActions: readonly string[];
  readonly stutters: boolean;
  readonly seconds: number;
  readonly output: string;
};

function parseTrace(output: string): Pick<TlcRun, 'trace' | 'loop' | 'loopActions' | 'stutters'> {
  const trace = output
    .split(/\n(?=State \d+: )/)
    .filter(block => /^State \d+: /.test(block))
    .map(block => {
      const [header = '', ...body] = block.split('\n');
      return { action: header.replace(/^State \d+: <?(\w+).*$/, '$1'), text: body.join('\n').split(/\n\s*\n/)[0] ?? '' };
    });
  const back = /Back to state (\d+): <?(\w+)/.exec(output);
  const loop = back?.[1] === undefined ? [] : trace.slice(Number(back[1]) - 1);
  const loopActions = back?.[2] === undefined ? [] : [...loop.slice(1).map(state => state.action), back[2]];
  return { trace, loop, loopActions, stutters: trace.at(-1)?.action === 'Stuttering' };
}

export type TlcOptions = { readonly workers?: 'auto' | '1'; readonly liveness?: 'final' };

export function checkModel(folder: string, module: string, config: string, { workers = 'auto', liveness }: TlcOptions = {}): TlcRun {
  const work = mkdtempSync(join(tmpdir(), 'tlc-'));
  const configFile = join(work, `${module}.cfg`);
  writeFileSync(configFile, config);
  const started = performance.now();
  try {
    const result = spawnSync(
      'java',
      ['-XX:+UseParallelGC', '-XX:MaxRAMPercentage=75', '-cp', tlaTools, 'tlc2.TLC', '-workers', workers, ...(liveness === undefined ? [] : ['-lncheck', liveness]), '-metadir', join(work, 'states'), '-config', configFile, `${module}.tla`],
      { cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    const output = result.error === undefined ? `${result.stdout}${result.stderr}` : `TLC did not run: ${result.error.message}`;
    const counted = [...output.matchAll(/(\d[\d,]*) distinct states found/g)].at(-1)?.[1];
    return {
      clean: result.status === 0 && output.includes('Model checking completed. No error has been found.'),
      distinctStates: counted === undefined ? undefined : Number(counted.replaceAll(',', '')),
      error: output.split('\n').find(line => line.startsWith('Error: ')),
      seconds: (performance.now() - started) / 1000,
      output,
      ...parseTrace(output),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const actionsOf = (run: TlcRun): readonly string[] => run.trace.map(state => state.action);

export const realStates = (run: TlcRun): readonly TraceState[] => run.trace.filter(state => state.action !== 'Stuttering');

export const lastRealState = (run: TlcRun): TraceState | undefined => realStates(run).at(-1);

export const variablesIn = (text: string): ReadonlyMap<string, string> =>
  new Map([...text.replace(/["\s]/g, '').matchAll(/\/\\(\w+)=([^/]*)/g)].map(([, name = '', value = '']): [string, string] => [name, value]));

export function traceLine(run: TlcRun): string {
  const ending = run.loop.length > 0 ? `, then loops back over the last ${String(run.loop.length)} states` : '';
  return `${actionsOf(run).join(' -> ')}${ending}`;
}
