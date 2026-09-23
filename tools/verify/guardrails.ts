import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, pass, type Check, type Scenario } from './check.ts';

type Tool = 'tsc' | 'node';

type Violation = {
  readonly name: string;
  readonly file: string;
  readonly source: string;
  readonly tool: Tool;
  readonly expect: readonly string[];
};

type Outcome = { readonly status: number | null; readonly output: string };

const violations: readonly Violation[] = [
  {
    name: 'tsc rejects an unchecked index access',
    file: 'features/planted/index.ts',
    source: 'const names: string[] = [];\nexport const size = names[0].length;\n',
    tool: 'tsc',
    expect: ['TS2532', 'TS18048'],
  },
  {
    name: 'tsc rejects undefined in an optional property',
    file: 'features/planted/optional.ts',
    source: 'export const draft: { note?: string } = { note: undefined };\n',
    tool: 'tsc',
    expect: ['TS2375'],
  },
  {
    name: 'tsc rejects a type imported without import type',
    file: 'features/planted/typed.ts',
    source: "import { Check } from '../../tools/verify/check.ts';\nexport const first: Check | undefined = undefined;\n",
    tool: 'tsc',
    expect: ['TS1484'],
  },
  {
    name: 'tsc rejects an enum',
    file: 'features/planted/stage.ts',
    source: 'export enum Stage {\n  Specify,\n}\n',
    tool: 'tsc',
    expect: ['TS1294'],
  },
  {
    name: 'node refuses to run an enum',
    file: 'features/planted/stage.ts',
    source: 'export enum Stage {\n  Specify,\n}\n',
    tool: 'node',
    expect: ['ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'],
  },
  {
    name: 'tsc rejects an implicit any',
    file: 'features/planted/total.ts',
    source: 'export function total(values) {\n  return values.length;\n}\n',
    tool: 'tsc',
    expect: ['TS7006'],
  },
];

const tools: Record<Tool, { readonly args: (copy: string, file: string) => readonly string[]; readonly caught: (outcome: Outcome, file: string, code: string) => boolean }> = {
  tsc: {
    args: copy => [join(copy, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', copy],
    caught: (outcome, file, code) => outcome.output.split('\n').some(line => line.includes(file) && line.includes(code)),
  },
  node: {
    args: (copy, file) => [join(copy, file)],
    caught: (outcome, _file, code) => outcome.output.includes(code),
  },
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['node_modules', '.git', '.claude']);

function run(tool: Tool, copy: string, file: string): Outcome {
  const result = spawnSync(process.execPath, tools[tool].args(copy, file), { cwd: copy, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function plant(copy: string, violation: Violation): Promise<Check> {
  const path = join(copy, violation.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, violation.source);
  try {
    const outcome = run(violation.tool, copy, violation.file);
    const code = violation.expect.find(candidate => tools[violation.tool].caught(outcome, violation.file, candidate));
    return outcome.status !== 0 && code !== undefined
      ? pass(violation.name, code)
      : fail(violation.name, `expected ${violation.expect.join(' or ')}, exit ${String(outcome.status)}`);
  } finally {
    await rm(path, { force: true });
  }
}

async function withCopy(work: (copy: string) => Promise<readonly Check[]>): Promise<readonly Check[]> {
  const copy = await mkdtemp(join(tmpdir(), 'guardrails-'));
  try {
    await cp(root, copy, { recursive: true, filter: source => !skipped.has(basename(source)) });
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'junction');
    return await work(copy);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

export const guardrails: Scenario = {
  name: 'guardrails',
  summary: 'plants each violation a check must reject, and proves the check rejects it',
  run: () =>
    withCopy(async copy => {
      const clean = run('tsc', copy, '');
      const checks: Check[] = [
        clean.status === 0
          ? pass('the unplanted copy passes tsc', '')
          : fail('the unplanted copy passes tsc', clean.output.trim().split('\n').slice(0, 3).join(' | ')),
      ];
      for (const violation of violations) checks.push(await plant(copy, violation));
      return checks;
    }),
};
