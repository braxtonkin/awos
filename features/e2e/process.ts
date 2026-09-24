import { spawn } from 'node:child_process';

export type Exit = { readonly code: number; readonly output: string };

export type Command = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

const keptOutput = 64_000;

export const baseEnvironment = (home: string): Readonly<Record<string, string>> => ({
  PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: home,
  LANG: 'C.UTF-8',
});

export function execute(file: string, args: readonly string[], command: Command): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: command.cwd,
      env: command.env,
      signal: AbortSignal.any([command.signal, AbortSignal.timeout(command.timeoutMs)]),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-keptOutput);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', error => {
      reject(new Error(`${file} ${args[0] ?? ''} did not finish: ${error.message}`));
    });
    child.on('close', code => {
      resolve({ code: code ?? 1, output });
    });
  });
}

export async function succeed(file: string, args: readonly string[], command: Command): Promise<string> {
  const exit = await execute(file, args, command);
  if (exit.code !== 0) throw new Error(`${file} ${args.join(' ')} exited ${String(exit.code)}: ${exit.output.slice(-2000).trim()}`);
  return exit.output;
}
