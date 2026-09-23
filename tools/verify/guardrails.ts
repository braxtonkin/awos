import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, pass, type Check, type Scenario } from './check.ts';

type Tool = 'tsc' | 'node' | 'eslint' | 'check';

type Companion = { readonly file: string; readonly source: string };

type Violation = {
  readonly name: string;
  readonly file: string;
  readonly source: string;
  readonly tool: Tool;
  readonly expect: readonly string[];
  readonly companions?: readonly Companion[];
};

type Outcome = { readonly status: number | null; readonly stdout: string; readonly output: string };

type LintMessage = { readonly file: string; readonly ruleId: string | null; readonly severity: number; readonly message: string };

const floatingPromise = 'export function load(): Promise<number> {\n  return Promise.resolve(1);\n}\nload();\n';

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
  {
    name: 'npm run check runs the type checker',
    file: 'features/planted/chained-types.ts',
    source: "export const count: number = 'one';\n",
    tool: 'check',
    expect: ['TS2322'],
  },
  {
    name: 'npm run check runs the linter',
    file: 'features/planted/chained-lint.ts',
    source: floatingPromise,
    tool: 'check',
    expect: ['@typescript-eslint/no-floating-promises'],
  },
  {
    name: 'eslint rejects a floating promise',
    file: 'features/planted/promise.ts',
    source: floatingPromise,
    tool: 'eslint',
    expect: ['@typescript-eslint/no-floating-promises'],
  },
  {
    name: 'an eslint-disable comment does not silence a rule',
    file: 'features/planted/disabled.ts',
    source: 'export function load(): Promise<number> {\n  return Promise.resolve(1);\n}\n// eslint-disable-next-line @typescript-eslint/no-floating-promises\nload();\n',
    tool: 'eslint',
    expect: ['@typescript-eslint/no-floating-promises'],
  },
  {
    name: 'a nested eslint config does not replace the root config',
    file: 'features/planted/loose.ts',
    source: floatingPromise,
    tool: 'eslint',
    expect: ['@typescript-eslint/no-floating-promises'],
    companions: [{ file: 'features/planted/eslint.config.mjs', source: 'export default [];\n' }],
  },
  {
    name: 'a suppressions file does not silence a rule',
    file: 'features/planted/suppressed.ts',
    source: floatingPromise,
    tool: 'eslint',
    expect: ['AGENTS.md rule B2'],
    companions: [
      {
        file: 'eslint-suppressions.json',
        source: '{\n  "features/planted/suppressed.ts": {\n    "@typescript-eslint/no-floating-promises": {\n      "count": 1\n    }\n  }\n}\n',
      },
    ],
  },
  {
    name: 'eslint rejects @ts-ignore even with a reason',
    file: 'features/planted/ignore.ts',
    source: "// @ts-ignore the reason does not excuse it\nexport const count: number = 'one';\n",
    tool: 'eslint',
    expect: ['@typescript-eslint/ban-ts-comment'],
  },
  {
    name: 'eslint rejects @ts-expect-error even with a reason',
    file: 'features/planted/expect.ts',
    source: "// @ts-expect-error the reason does not excuse it\nexport const count: number = 'one';\n",
    tool: 'eslint',
    expect: ['@typescript-eslint/ban-ts-comment'],
  },
  {
    name: 'eslint rejects @ts-nocheck',
    file: 'features/planted/nocheck.ts',
    source: "// @ts-nocheck\nexport const count: number = 'one';\n",
    tool: 'eslint',
    expect: ['@typescript-eslint/ban-ts-comment'],
  },
  {
    name: 'eslint rejects @ts-nocheck in capitals, which tsc still obeys',
    file: 'features/planted/shouted.ts',
    source: "// @TS-NOCHECK\nexport const count: number = 'one';\n",
    tool: 'eslint',
    expect: ['no-warning-comments'],
  },
  {
    name: 'eslint rejects member access on an any',
    file: 'features/planted/unsafe.ts',
    source: 'export const size = (text: string): number => JSON.parse(text).id.length;\n',
    tool: 'eslint',
    expect: ['@typescript-eslint/no-unsafe-member-access'],
  },
  {
    name: 'eslint rejects a non-null assertion',
    file: 'features/planted/nonnull.ts',
    source: 'const names: string[] = [];\nexport const size = names[0]!.length;\n',
    tool: 'eslint',
    expect: ['@typescript-eslint/no-non-null-assertion'],
  },
  {
    name: 'eslint rejects a relative import by its .js name',
    file: 'features/planted/relative.ts',
    source: "import { pass } from '../../tools/verify/check.js';\nexport const planted = pass('planted', 'tsc resolves this import and node cannot');\n",
    tool: 'eslint',
    expect: ['no-restricted-syntax'],
  },
  {
    name: 'eslint rejects a dynamic import by its .js name',
    file: 'features/planted/dynamic.ts',
    source: "export const load = (): Promise<unknown> => import('../../tools/verify/check.js');\n",
    tool: 'eslint',
    expect: ['no-restricted-syntax'],
  },
  {
    name: 'eslint rejects an import path written as a template literal',
    file: 'features/planted/template.ts',
    source: 'export const load = (): Promise<unknown> => import(`../../tools/verify/check.ts`);\n',
    tool: 'eslint',
    expect: ['no-restricted-syntax'],
  },
  {
    name: 'eslint rejects an import from .claude, which lint skips',
    file: 'features/planted/agent.ts',
    source: "import { helper } from '../../.claude/helper.ts';\nexport const planted = helper;\n",
    tool: 'eslint',
    expect: ['no-restricted-syntax'],
    companions: [{ file: '.claude/helper.ts', source: 'export const helper = 1;\n' }],
  },
  {
    name: 'a stray eslint-disable comment fails the check',
    file: 'features/planted/stray.ts',
    source: '// eslint-disable-next-line no-console\nexport const count = 1;\n',
    tool: 'eslint',
    expect: ["has no effect because you have 'noInlineConfig'"],
  },
  {
    name: 'a nested tsconfig does not change how a file is linted',
    file: 'features/planted/weak.ts',
    source: floatingPromise,
    tool: 'eslint',
    expect: ['@typescript-eslint/no-floating-promises'],
    companions: [{ file: 'features/planted/tsconfig.json', source: '{ "extends": "../../tsconfig.json", "compilerOptions": { "noLib": true } }\n' }],
  },
  {
    name: 'eslint rejects a .ts file outside the root tsconfig',
    file: 'scripts/outside.ts',
    source: 'export const outside = 1;\n',
    tool: 'eslint',
    expect: ['was not found in any of the provided project(s)'],
  },
  {
    name: 'eslint rejects a folder that brings its own tsconfig',
    file: 'scripts/typed.ts',
    source: "export const count: number = 'one';\n",
    tool: 'eslint',
    expect: ['was not found in any of the provided project(s)'],
    companions: [{ file: 'scripts/tsconfig.json', source: '{ "extends": "../tsconfig.json", "include": ["*.ts"] }\n' }],
  },
  {
    name: 'eslint rejects a .mjs file, which no tsconfig checks',
    file: 'features/planted/script.mjs',
    source: 'export function load() {\n  return Promise.resolve(1);\n}\nload();\n',
    tool: 'eslint',
    expect: ['was not found in any of the provided project(s)'],
  },
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

function toMessages(file: string, value: unknown): readonly LintMessage[] {
  if (!isRecord(value)) return [];
  const { ruleId, severity, message } = value;
  if (typeof severity !== 'number' || typeof message !== 'string') return [];
  return [{ file, ruleId: typeof ruleId === 'string' ? ruleId : null, severity, message }];
}

function lintResults(outcome: Outcome): readonly Readonly<Record<string, unknown>>[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

function lintMessages(outcome: Outcome, file: string): readonly LintMessage[] {
  const results = lintResults(outcome);
  if (results === undefined) return [{ file, ruleId: null, severity: 2, message: outcome.output }];
  return results.flatMap(({ filePath, messages }) => {
    if (typeof filePath !== 'string' || !Array.isArray(messages)) return [];
    const path = filePath.replaceAll('\\', '/');
    return path.endsWith(file) ? messages.flatMap((message: unknown) => toMessages(path, message)) : [];
  });
}

const suppressedMessages = (outcome: Outcome): number =>
  (lintResults(outcome) ?? []).reduce((total, { suppressedMessages: suppressed }) => total + (Array.isArray(suppressed) ? suppressed.length : 0), 0);

const firstLines = (outcome: Outcome): string => outcome.output.trim().split('\n').slice(0, 3).join(' | ');

const isRuleId = (code: string): boolean => !code.includes(' ');

const tools: Record<
  Tool,
  {
    readonly command: (copy: string, file: string) => readonly [string, ...string[]];
    readonly caught: (outcome: Outcome, file: string, code: string) => boolean;
    readonly summary?: (outcome: Outcome) => string;
    readonly unclean?: (outcome: Outcome) => string | undefined;
  }
> = {
  tsc: {
    command: () => ['npm', 'run', '--silent', 'typecheck'],
    caught: (outcome, file, code) => outcome.output.split('\n').some(line => line.includes(file) && line.includes(code)),
  },
  node: {
    command: (copy, file) => [process.execPath, join(copy, file)],
    caught: (outcome, _file, code) => outcome.output.includes(code),
  },
  eslint: {
    command: (_copy, file) => ['npm', 'run', '--silent', 'lint', '--', '--format', 'json', file],
    caught: (outcome, file, code) => lintMessages(outcome, file).some(message => (isRuleId(code) ? message.ruleId === code : message.message.includes(code))),
    summary: outcome =>
      lintMessages(outcome, '')
        .filter(message => message.severity === 2)
        .slice(0, 3)
        .map(message => `${message.file} ${message.ruleId ?? message.message.split('\n')[0] ?? ''}`)
        .join(' | '),
    unclean: outcome => {
      const count = suppressedMessages(outcome);
      return count === 0 ? undefined : `${String(count)} lint messages are suppressed, which AGENTS.md rule B2 forbids`;
    },
  },
  check: {
    command: () => ['npm', 'run', '--silent', 'check'],
    caught: (outcome, file, code) => outcome.output.includes(file) && outcome.output.split('\n').some(line => line.includes(code)),
  },
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['node_modules', '.git', '.claude']);

function run(tool: Tool, copy: string, file: string): Outcome {
  const [executable, ...args] = tools[tool].command(copy, file);
  const result = spawnSync(executable, args, { cwd: copy, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

async function plant(copy: string, violation: Violation): Promise<Check> {
  const planted = [violation, ...(violation.companions ?? [])];
  for (const { file, source } of planted) {
    await mkdir(dirname(join(copy, file)), { recursive: true });
    await writeFile(join(copy, file), source);
  }
  try {
    const outcome = run(violation.tool, copy, violation.file);
    const code = violation.expect.find(candidate => tools[violation.tool].caught(outcome, violation.file, candidate));
    return outcome.status !== 0 && code !== undefined
      ? pass(violation.name, code)
      : fail(violation.name, `expected ${violation.expect.join(' or ')}, exit ${String(outcome.status)}`);
  } finally {
    for (const { file } of planted) await rm(join(copy, file), { force: true });
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
      const checks: Check[] = (['tsc', 'eslint'] as const).map(tool => {
        const clean = run(tool, copy, '.');
        const name = `the unplanted copy passes ${tool}`;
        const problem = clean.status === 0 ? tools[tool].unclean?.(clean) : (tools[tool].summary ?? firstLines)(clean);
        return problem === undefined ? pass(name, '') : fail(name, problem);
      });
      for (const violation of violations) checks.push(await plant(copy, violation));
      return checks;
    }),
};
