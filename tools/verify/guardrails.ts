import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, pass, type Check, type Scenario } from './check.ts';

type Tool = 'tsc' | 'node' | 'eslint' | 'depcruise' | 'check' | 'shape' | 'sql-comments' | 'model-names' | 'step-names' | 'strict-schemas' | 'ci-plan' | 'db-types' | 'models';

type Edit = { readonly from: string; readonly to: string };

type Plant =
  | { readonly file: string; readonly source: string; readonly linkTo?: never; readonly edit?: never }
  | { readonly file: string; readonly linkTo: string; readonly source?: never; readonly edit?: never }
  | { readonly file: string; readonly edit: Edit; readonly source?: never; readonly linkTo?: never };

type Violation = Plant & {
  readonly name: string;
  readonly tool: Tool;
  readonly expect: readonly string[];
  readonly companions?: readonly Plant[];
  readonly rejects?: string;
};

type Allowance = Plant & {
  readonly name: string;
  readonly tool: Tool;
  readonly shows?: string;
  readonly companions?: readonly Plant[];
  readonly env?: Readonly<Record<string, string>>;
};

type Outcome = { readonly status: number | null; readonly stdout: string; readonly output: string };

type LintMessage = { readonly file: string; readonly ruleId: string | null; readonly severity: number; readonly message: string };

const floatingPromise = 'export function load(): Promise<number> {\n  return Promise.resolve(1);\n}\nload();\n';

const noComments = 'autoworker/no-comments';

const jsxTypes: Plant = {
  file: 'features/planted/jsx.d.ts',
  source: 'declare global {\n  namespace JSX {\n    type Element = string;\n    interface IntrinsicElements {\n      div: { readonly children?: unknown };\n    }\n  }\n}\n\nexport {};\n',
};

const plantedMigration = 'db/migrations/29990101000000_planted.sql';

const plantedQuery = 'features/planted/query.ts';

const commentedQuery = (imports: string, tag: string): string => `${imports}\n\nexport const query = ${tag}\`\n  select 1 -- one\n\`;\n`;

const oneComment = `${plantedQuery}:4 holds the SQL comment "-- one"`;

const migration = (up: string, down: string): string => `-- migrate:up\n${up}\n-- migrate:down\n${down}\n`;

const markedMigration = migration('create table planted (id int);', 'drop table planted;');

const explainedMigration = migration('-- explain\ncreate table planted (id int);', 'drop table planted;');

const explainedComment = `${plantedMigration}:2 holds the SQL comment "-- explain"`;

const hiddenComment = `${plantedMigration}:2 holds the SQL comment "-- hidden"`;

const plantedConfig = 'features/planted/Planted.cfg';

const plantedInvariants = 'features/planted/invariants.ts';

const holdsAndStepConfig = 'SPECIFICATION Spec\n\nINVARIANTS\n    PlantedHolds\n\nPROPERTIES\n    PlantedStep\n';

const holdsInvariants = 'export const properties = { PlantedHolds: 1 };\n';

const emptyInvariants = 'export const properties = {};\n';

const uncheckedStep = `${plantedInvariants} has no simulator check named PlantedStep, which ${plantedConfig} lists`;

const missingInvariants = `${plantedInvariants} does not exist, so it has no simulator check named PlantedHolds, which ${plantedConfig} lists`;

const generatedTypes = 'shared/db/types.ts';

const tableMigration = migration('create table planted (id int primary key);', 'drop table planted;');

const staleTypes = `${generatedTypes} differs from a fresh generation`;

const codeChange = 'code-change';

const optionalVerifyField: Edit = {
  from: "behavior: z.enum(['fixed', 'still_wrong']).nullable() })",
  to: "behavior: z.enum(['fixed', 'still_wrong']).nullable(), extra: z.string().optional() })",
};

const optionalExtra = `${codeChange} verify $.properties.extra is not in required`;

const textBlockStartsWithBody: Edit = {
  from: "z.strictObject({ kind: z.enum(['text']), title: z.string().nullable(), body: z.string() })",
  to: "z.strictObject({ body: z.string(), kind: z.enum(['text']), title: z.string().nullable() })",
};

const bodyFirst = `${codeChange} specify $.properties.blocks.items.anyOf[0] starts with body`;

const plantedStep = "name: 'planted', reads: [], runBy: 'agent', prompt: 'Planted.', startsEnvironment: false, needsRepository: true, canEnd: true, owes: [], output: review, requires: ['text'], failures: { fail: { kind: 'fail' } }";

const noBrandAssertions = 'autoworker/no-brand-assertions';

const ciWorkflow = '.github/workflows/ci.yml';

const afterDoctor = (added: string): Edit => ({
  from: '      - run: docker compose run --rm verify npm run verify -- doctor\n',
  to: `      - run: docker compose run --rm verify npm run verify -- doctor\n${added}`,
});

const setupNode = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';

const setupNodeStep = afterDoctor(`      - uses: ${setupNode}\n`);

const unknownStep = `${ciWorkflow} job check step 7 uses ${setupNode}, which ci-local cannot run`;

const accessOnlyLoginFrom = "import { accessOnly, type AccessOnlyLogin } from '../../shared/codex-login.ts';\n\nconst launch = (login: AccessOnlyLogin): string => login;\n";

const plantedCheck = "import type { Checks } from './checks.ts';\nimport type { Check } from './kinds.ts';\n\nconst check: Check = { rotates: () => false, run: () => Promise.reject(new Error('planted')) };\n";

const violations: readonly Violation[] = [
  {
    name: 'tsc rejects a review step that owes an approval',
    file: 'features/planted/approves.ts',
    source: "import { z } from 'zod';\nimport type { ActionSpec } from '../../shared/actions.ts';\nimport { reviewOwes, type ReviewStep } from '../code-change/land.ts';\n\nconst approve: ActionSpec<'pr.approve', { readonly repository: string }, { readonly review: string }> = { kind: 'pr.approve', payload: z.object({ repository: z.string() }), result: z.object({ review: z.string() }) };\n\nexport const approving: ReviewStep = pull => ({ actions: [reviewOwes(approve, { repository: pull.repository })], note: 'The planted step approved.' });\n",
    tool: 'tsc',
    expect: ['TS2345'],
  },
  {
    name: 'tsc rejects a review step that owes an action it did not build with reviewOwes',
    file: 'features/planted/owes.ts',
    source: "import { z } from 'zod';\nimport { owe, type ActionSpec } from '../../shared/actions.ts';\nimport type { ReviewStep } from '../code-change/land.ts';\n\nconst approve: ActionSpec<'pr.approve', { readonly repository: string }, { readonly review: string }> = { kind: 'pr.approve', payload: z.object({ repository: z.string() }), result: z.object({ review: z.string() }) };\n\nexport const approving: ReviewStep = pull => ({ actions: [owe(approve, { repository: pull.repository })], note: 'The planted step approved.' });\n",
    tool: 'tsc',
    expect: ['TS2322'],
  },
  {
    name: 'tsc rejects a GitHub performer map without pr.merge',
    file: 'features/github/planted.ts',
    source:
      "import type { Performers } from '../../shared/actions.ts';\nimport { githubPerformers, type GithubKind } from './performers.ts';\n\nconst { 'pr.merge': merge, ...others } = githubPerformers({ clientFor: () => Promise.resolve({ failed: 'planted' }), owedAt: () => Promise.resolve(undefined) });\n\nexport const withoutMerge: Performers<GithubKind> = others;\n\nexport const planted = merge;\n",
    tool: 'tsc',
    expect: ['TS2741'],
  },
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
    companions: [{ file: 'features/planted/uses-chained-types.ts', source: "import { count } from './chained-types.ts';\nexport const doubled = count * 2;\n" }],
  },
  {
    name: 'npm run check runs the linter',
    file: 'features/planted/chained-lint.ts',
    source: floatingPromise,
    tool: 'check',
    expect: ['@typescript-eslint/no-floating-promises'],
    companions: [{ file: 'features/planted/uses-chained-lint.ts', source: "import { load } from './chained-lint.ts';\nexport const loader = load;\n" }],
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
  {
    name: 'eslint rejects a line comment',
    file: 'features/planted/line.ts',
    source: '// explain\nexport const count = 1;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects a block comment',
    file: 'features/planted/block.ts',
    source: '/* note */\nexport const count = 1;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects a doc comment',
    file: 'features/planted/doc.ts',
    source: '/** docs */\nexport function count(): number {\n  return 1;\n}\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects a JSX comment',
    file: 'features/planted/note.tsx',
    source: 'export const note = <div>{/* note */}</div>;\n',
    tool: 'eslint',
    expect: [noComments],
    companions: [jsxTypes],
  },
  {
    name: 'eslint rejects a comment below a shebang',
    file: 'features/planted/cli-note.ts',
    source: '#!/usr/bin/env node\n// explain\nexport const count = 1;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects prose after a reference directive',
    file: 'features/planted/prose.d.ts',
    source: '/// <reference types="node" /> kept because it is needed\nexport declare const count: number;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects a comment line below a reference directive',
    file: 'features/planted/explained.d.ts',
    source: '/// <reference types="node" />\n/// explain\nexport declare const count: number;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects a reference directive after code',
    file: 'features/planted/late.d.ts',
    source: 'export declare const count: number;\n/// <reference types="node" />\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects a block comment shaped like a reference directive',
    file: 'features/planted/block-reference.d.ts',
    source: '/*/ <reference types="node\nkeep this line, the dashboard needs Buffer\n" />*/\nexport declare const count: number;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'a lint warning alone fails the check',
    file: '.claude/warned.ts',
    source: 'export const count = 1;\n',
    tool: 'eslint',
    expect: ['File ignored because of a matching ignore pattern'],
  },
  {
    name: 'eslint rejects a reference directive outside a .d.ts file',
    file: 'features/planted/reference.ts',
    source: '/// <reference types="node" />\nexport const count = 1;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'eslint rejects an eslint-disable comment as a comment',
    file: 'features/planted/directive.ts',
    source: '// eslint-disable-next-line no-console\nexport const count = 1;\n',
    tool: 'eslint',
    expect: [noComments],
  },
  {
    name: 'dependency-cruiser rejects an import from another feature',
    file: 'features/alpha/uses.ts',
    source: "import { thing } from '../beta/thing.ts';\nexport const uses = thing;\n",
    tool: 'depcruise',
    expect: ['no-cross-feature-import'],
    companions: [{ file: 'features/beta/thing.ts', source: 'export const thing = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects a database driver in a Job',
    file: 'services/job/direct.ts',
    source: "import pg from 'pg';\nexport const job = pg;\n",
    tool: 'depcruise',
    expect: ['job-has-no-database'],
  },
  {
    name: 'dependency-cruiser rejects a Job reaching the database through a helper',
    file: 'services/job/through-helper.ts',
    source: "import { helper } from '../../shared/helper.ts';\nexport const job = helper;\n",
    tool: 'depcruise',
    expect: ['job-has-no-database'],
    companions: [
      { file: 'shared/helper.ts', source: "import { pool } from './db/pool.ts';\nexport const helper = pool;\n" },
      { file: 'shared/db/pool.ts', source: 'export const pool = 1;\n' },
    ],
  },
  {
    name: "dependency-cruiser rejects a database driver in the bridge's Job side, which the Job entry point imports",
    file: 'features/bridge/job.ts',
    edit: { from: "import { spawn } from 'node:child_process';\n", to: "import { spawn } from 'node:child_process';\nimport 'pg';\n" },
    tool: 'depcruise',
    expect: ['job-has-no-database'],
    rejects: 'services/job/main.ts',
  },
  {
    name: 'dependency-cruiser rejects a Kubernetes client in a Job',
    file: 'services/job/kube.ts',
    source: "import { KubeConfig } from '@kubernetes/client-node';\nexport const job = KubeConfig;\n",
    tool: 'depcruise',
    expect: ['job-has-no-kubernetes-api'],
  },
  {
    name: 'dependency-cruiser rejects the dashboard importing the engine',
    file: 'services/dashboard/page.ts',
    source: "import { engine } from '../engine/planted-engine.ts';\nexport const page = engine;\n",
    tool: 'depcruise',
    expect: ['services-stay-apart'],
    companions: [{ file: 'services/engine/planted-engine.ts', source: 'export const engine = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects a circular import',
    file: 'features/alpha/first.ts',
    source: "import { second } from './second.ts';\nexport const first = (): number => second();\n",
    tool: 'depcruise',
    expect: ['no-circular'],
    companions: [{ file: 'features/alpha/second.ts', source: "import { first } from './first.ts';\nexport const second = (): number => first();\n" }],
  },
  {
    name: 'dependency-cruiser rejects an orphan module',
    file: 'features/alpha/lonely.ts',
    source: 'export const lonely = 1;\n',
    tool: 'depcruise',
    expect: ['no-orphans'],
  },
  {
    name: 'npm run check runs dependency-cruiser',
    file: 'features/alpha/chained-orphan.ts',
    source: 'export const lonely = 1;\n',
    tool: 'check',
    expect: ['no-orphans'],
  },
  {
    name: 'dependency-cruiser rejects a type-only import from another feature',
    file: 'features/alpha/typed.ts',
    source: "import type { Thing } from '../beta/thing.ts';\nexport const typed: Thing | undefined = undefined;\n",
    tool: 'depcruise',
    expect: ['no-cross-feature-import'],
    companions: [{ file: 'features/beta/thing.ts', source: 'export type Thing = number;\n' }],
  },
  {
    name: 'dependency-cruiser rejects shared code re-exporting a feature',
    file: 'shared/reexport.ts',
    source: "export { thing } from '../features/beta/thing.ts';\n",
    tool: 'depcruise',
    expect: ['shared-imports-nothing-above'],
    companions: [{ file: 'features/beta/thing.ts', source: 'export const thing = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects a feature importing a service',
    file: 'features/alpha/uses-service.ts',
    source: "import { engine } from '../../services/engine/planted-engine.ts';\nexport const uses = engine;\n",
    tool: 'depcruise',
    expect: ['features-import-no-services'],
    companions: [{ file: 'services/engine/planted-engine.ts', source: 'export const engine = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects a relative of pg in a Job',
    file: 'services/job/pool.ts',
    source: "import Pool from 'pg-pool';\nexport const job = Pool;\n",
    tool: 'depcruise',
    expect: ['job-has-no-database'],
  },
  {
    name: 'dependency-cruiser rejects a Job reaching kysely through a feature',
    file: 'services/job/report.ts',
    source: "import { query } from '../../features/alpha/query.ts';\nexport const report = query;\n",
    tool: 'depcruise',
    expect: ['job-has-no-database'],
    companions: [{ file: 'features/alpha/query.ts', source: "import { sql } from 'kysely';\nexport const query = sql;\n" }],
  },
  {
    name: 'dependency-cruiser rejects a Job reaching the Kubernetes API through a helper',
    file: 'services/job/cluster.ts',
    source: "import { kube } from '../../shared/kube.ts';\nexport const cluster = kube;\n",
    tool: 'depcruise',
    expect: ['job-has-no-kubernetes-api'],
    companions: [{ file: 'shared/kube.ts', source: "import { KubeConfig } from '@kubernetes/client-node';\nexport const kube = KubeConfig;\n" }],
  },
  {
    name: 'dependency-cruiser rejects the engine importing the dashboard',
    file: 'services/engine/start.ts',
    source: "import { page } from '../dashboard/page.ts';\nexport const start = page;\n",
    tool: 'depcruise',
    expect: ['services-stay-apart'],
    companions: [{ file: 'services/dashboard/page.ts', source: 'export const page = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects the Job importing the engine',
    file: 'services/job/uses-engine.ts',
    source: "import { tick } from '../engine/loop.ts';\nexport const job = tick;\n",
    tool: 'depcruise',
    expect: ['services-stay-apart'],
    companions: [{ file: 'services/engine/loop.ts', source: 'export const tick = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects tools/ carrying a feature to another feature',
    file: 'tools/bridge.ts',
    source: "export { thing } from '../features/beta/thing.ts';\n",
    tool: 'depcruise',
    expect: ['tools-import-no-product-code'],
    companions: [
      { file: 'features/beta/thing.ts', source: 'export const thing = 1;\n' },
      { file: 'features/alpha/uses-bridge.ts', source: "import { thing } from '../../tools/bridge.ts';\nexport const uses = thing;\n" },
    ],
  },
  {
    name: 'dependency-cruiser rejects a Job reaching pg through a module whose name contains node_modules',
    file: 'services/job/sync.ts',
    source: "import { client } from '../../shared/node_modules_db.ts';\nexport const sync = client;\n",
    tool: 'depcruise',
    expect: ['job-has-no-database'],
    companions: [{ file: 'shared/node_modules_db.ts', source: "import pg from 'pg';\nexport const client = pg;\n" }],
  },
  {
    name: 'dependency-cruiser rejects a file directly under features/ carrying one feature to another',
    file: 'features/bridge.ts',
    source: "export { thing } from './beta/thing.ts';\n",
    tool: 'depcruise',
    expect: ['loose-files-import-no-product-code'],
    companions: [
      { file: 'features/beta/thing.ts', source: 'export const thing = 1;\n' },
      { file: 'features/alpha/uses-bridge.ts', source: "import { thing } from '../bridge.ts';\nexport const uses = thing;\n" },
    ],
  },
  {
    name: 'dependency-cruiser rejects a file outside the named folders carrying the engine to the dashboard',
    file: 'lib/bridge.ts',
    source: "export { tick } from '../services/engine/loop.ts';\n",
    tool: 'depcruise',
    expect: ['loose-files-import-no-product-code'],
    companions: [
      { file: 'services/engine/loop.ts', source: 'export const tick = 1;\n' },
      { file: 'services/dashboard/page.ts', source: "import { tick } from '../../lib/bridge.ts';\nexport const page = tick;\n" },
    ],
  },
  {
    name: 'dependency-cruiser rejects the engine importing the Job',
    file: 'services/engine/uses-job.ts',
    source: "import { run } from '../job/run.ts';\nexport const engine = run;\n",
    tool: 'depcruise',
    expect: ['services-stay-apart'],
    companions: [{ file: 'services/job/run.ts', source: 'export const run = 1;\n' }],
  },
  {
    name: 'dependency-cruiser rejects tools/ carrying the engine to the dashboard',
    file: 'tools/relay.ts',
    source: "export { tick } from '../services/engine/loop.ts';\n",
    tool: 'depcruise',
    expect: ['tools-import-no-product-code'],
    companions: [
      { file: 'services/engine/loop.ts', source: 'export const tick = 1;\n' },
      { file: 'services/dashboard/page.ts', source: "import { tick } from '../../tools/relay.ts';\nexport const page = tick;\n" },
    ],
  },
  {
    name: 'dependency-cruiser rejects shared code importing tools/',
    file: 'shared/planted.ts',
    source: "import { pass } from '../tools/verify/check.ts';\nexport const planted = pass;\n",
    tool: 'depcruise',
    expect: ['product-code-imports-no-tools'],
  },
  {
    name: 'dependency-cruiser rejects a service importing tools/',
    file: 'services/engine/uses-tools.ts',
    source: "import { pass } from '../../tools/verify/check.ts';\nexport const engine = pass;\n",
    tool: 'depcruise',
    expect: ['product-code-imports-no-tools'],
  },
  {
    name: 'the shape check rejects a symbolic link that carries one feature into another',
    file: 'lib',
    linkTo: 'features/beta',
    tool: 'shape',
    expect: ['lib is a symbolic link'],
  },
  {
    name: 'the shape check rejects a symbolic link that hides a @ts-ignore from lint',
    file: 'features/alpha/linked',
    linkTo: '../../.claude/hidden',
    tool: 'shape',
    expect: ['features/alpha/linked is a symbolic link'],
    companions: [{ file: '.claude/hidden/ignore.ts', source: "// @ts-ignore lint never reads this file\nexport const count: number = 'one';\n" }],
  },
  {
    name: 'the shape check rejects a feature folder whose name the import rules would read as a pattern',
    file: 'features/(.)+/thing.ts',
    source: 'export const thing = 1;\n',
    tool: 'shape',
    expect: ['features/(.)+ must match'],
  },
  {
    name: 'the shape check rejects a service folder whose name the import rules would read as a pattern',
    file: 'services/(.)+/main.ts',
    source: 'export const main = 1;\n',
    tool: 'shape',
    expect: ['services/(.)+ must match'],
  },
  {
    name: 'the shape check rejects a folder name that starts and ends with a letter but holds a pattern',
    file: 'features/a.*z/thing.ts',
    source: 'export const thing = 1;\n',
    tool: 'shape',
    expect: ['features/a.*z must match'],
  },
  {
    name: 'the shape check rejects a node_modules folder inside a feature',
    file: 'features/alpha/node_modules/bridge.ts',
    source: 'export const bridge = 1;\n',
    tool: 'shape',
    expect: ['features/alpha/node_modules is a node_modules folder below the root'],
  },
  {
    name: 'the shape check rejects a node_modules folder outside the product folders',
    file: 'lib/node_modules/bridge.ts',
    source: 'export const bridge = 1;\n',
    tool: 'shape',
    expect: ['lib/node_modules is a node_modules folder below the root'],
  },
  {
    name: 'the shape check rejects a symbolic link inside a dot folder',
    file: 'features/alpha/.cache/beta',
    linkTo: '../../beta',
    tool: 'shape',
    expect: ['features/alpha/.cache/beta is a symbolic link'],
  },
  {
    name: 'the shape check reports a link to its own folder without following it',
    file: 'features/alpha/self',
    linkTo: '.',
    tool: 'shape',
    expect: ['features/alpha/self is a symbolic link'],
  },
  {
    name: 'the shape check rejects a symbolic link under .claude/ outside an install',
    file: '.claude/skills/linked',
    linkTo: '../../features/beta',
    tool: 'shape',
    expect: ['.claude/skills/linked is a symbolic link'],
  },
  {
    name: 'npm run check runs the shape check',
    file: 'docs/guide.md',
    linkTo: '../README.md',
    tool: 'check',
    expect: ['docs/guide.md is a symbolic link'],
  },
  {
    name: 'sql-comments rejects a comment line in a migration',
    file: plantedMigration,
    source: explainedMigration,
    tool: 'sql-comments',
    expect: [explainedComment],
  },
  {
    name: 'sql-comments rejects a comment after code',
    file: plantedMigration,
    source: migration('create table planted (id int); -- why', 'drop table planted;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:2 holds the SQL comment "-- why"`],
  },
  {
    name: 'sql-comments rejects a nested block comment as one comment',
    file: plantedMigration,
    source: migration('/* outer /* inner */ still the comment */ create table planted (id int);', 'drop table planted;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:2 holds the SQL comment "/* outer /* inner */ still the comment */"`],
  },
  {
    name: 'sql-comments rejects a comment inside a function body between $$ delimiters',
    file: plantedMigration,
    source: migration('create function planted() returns int language plpgsql as $$\nbegin\n  perform 1;\n  -- explain\n  return 1;\nend;\n$$;', 'drop function planted();'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:5 holds the SQL comment "-- explain"`],
  },
  {
    name: 'sql-comments rejects prose after the migrate:up marker',
    file: plantedMigration,
    source: markedMigration.replace('-- migrate:up', '-- migrate:up because the schema needs it'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:1 holds the SQL comment "-- migrate:up because the schema needs it"`],
  },
  {
    name: 'sql-comments rejects prose after the transaction:false option',
    file: plantedMigration,
    source: markedMigration.replace('-- migrate:up', '-- migrate:up transaction:false because the index builds concurrently'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:1 holds the SQL comment "-- migrate:up transaction:false because the index builds concurrently"`],
  },
  {
    name: 'sql-comments rejects an indented migrate:up marker',
    file: plantedMigration,
    source: markedMigration.replace('-- migrate:up', '  -- migrate:up'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:1 holds the SQL comment "-- migrate:up"`],
  },
  {
    name: 'sql-comments rejects a COMMENT ON statement',
    file: plantedMigration,
    source: migration("create table planted (id int);\ncomment on table planted is 'the planted table';", 'drop table planted;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:3 holds a COMMENT ON statement`],
  },
  {
    name: 'sql-comments rejects a comment in a sql template',
    file: plantedQuery,
    source: commentedQuery("import { sql } from 'kysely';", 'sql'),
    tool: 'sql-comments',
    expect: [oneComment],
  },
  {
    name: 'sql-comments rejects a comment in a template tagged with an alias of sql',
    file: plantedQuery,
    source: commentedQuery("import { sql as q } from 'kysely';", 'q'),
    tool: 'sql-comments',
    expect: [oneComment],
  },
  {
    name: 'sql-comments rejects a comment in a template tagged with sql from a namespace import of kysely',
    file: plantedQuery,
    source: commentedQuery("import * as kysely from 'kysely';", 'kysely.sql'),
    tool: 'sql-comments',
    expect: [oneComment],
  },
  {
    name: 'sql-comments rejects a comment in a template tagged sql that another module re-exports',
    file: plantedQuery,
    source: commentedQuery("import { sql } from './kysely.ts';", 'sql'),
    tool: 'sql-comments',
    expect: [oneComment],
    companions: [{ file: 'features/planted/kysely.ts', source: "export { sql } from 'kysely';\n" }],
  },
  {
    name: 'sql-comments rejects the migrate:up marker in a sql template, which only a .sql file may hold',
    file: plantedQuery,
    source: "import { sql } from 'kysely';\n\nexport const query = sql`\n-- migrate:up\nselect 1\n`;\n",
    tool: 'sql-comments',
    expect: [`${plantedQuery}:4 holds the SQL comment "-- migrate:up"`],
  },
  {
    name: 'sql-comments rejects a comment after a standard string that ends in a backslash',
    file: plantedMigration,
    source: migration("select 'a\\'; -- why", 'select 1;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:2 holds the SQL comment "-- why"`],
  },
  {
    name: 'sql-comments rejects a comment after an escape string that holds an escaped quote',
    file: plantedMigration,
    source: migration("select E'it\\'s'; -- why", 'select 1;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:2 holds the SQL comment "-- why"`],
  },
  {
    name: 'sql-comments rejects a comment after a name literal, which is not an escape string',
    file: plantedMigration,
    source: migration("select name'x\\'; -- why", 'select 1;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:2 holds the SQL comment "-- why"`],
  },
  {
    name: 'sql-comments rejects a comment after a dollar-quoted string that holds an apostrophe',
    file: plantedMigration,
    source: migration("select $$it's$$; -- hidden", 'select 1;'),
    tool: 'sql-comments',
    expect: [hiddenComment],
  },
  {
    name: 'sql-comments rejects a comment after a tagged dollar-quoted string that holds an apostrophe',
    file: plantedMigration,
    source: migration("select $q$it's$q$; -- hidden", 'select 1;'),
    tool: 'sql-comments',
    expect: [hiddenComment],
  },
  {
    name: 'sql-comments rejects a comment inside a tagged dollar-quoted body, which ends only at its own tag',
    file: plantedMigration,
    source: migration("create function planted() returns text language plpgsql as $body$\nbegin\n  return $$it's$$; -- explain\nend;\n$body$;", 'drop function planted();'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:4 holds the SQL comment "-- explain"`],
  },
  {
    name: 'sql-comments rejects a dbmate marker inside a dollar-quoted body',
    file: plantedMigration,
    source: migration('create function planted() returns int language sql as $$\n-- migrate:down\nselect 1;\n$$;', 'drop function planted();'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:3 holds the SQL comment "-- migrate:down"`],
  },
  {
    name: 'sql-comments rejects a comment after a name that holds € and $$, which Postgres reads as one name',
    file: plantedMigration,
    source: migration("create table planted (price€$$ int, note text default 'it''s $$'); -- why", 'drop table planted;'),
    tool: 'sql-comments',
    expect: [`${plantedMigration}:2 holds the SQL comment "-- why"`],
  },
  {
    name: 'npm run check runs the SQL comment check',
    file: plantedMigration,
    source: explainedMigration,
    tool: 'check',
    expect: [explainedComment],
  },
  {
    name: 'model-names rejects a model property with no simulator check of the same name',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [uncheckedStep],
    companions: [{ file: plantedInvariants, source: holdsInvariants }],
  },
  {
    name: 'model-names rejects a model whose feature has code but no invariants.ts',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [missingInvariants],
    companions: [{ file: 'features/planted/store.ts', source: 'export const store = 1;\n' }],
  },
  {
    name: 'model-names rejects a model whose feature has code only in a subfolder and no invariants.ts',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [missingInvariants],
    companions: [{ file: 'features/planted/lib/store.ts', source: 'export const store = 1;\n' }],
  },
  {
    name: 'model-names rejects a model whose feature has only a verify.ts in a subfolder, which is code, and no invariants.ts',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [missingInvariants],
    companions: [{ file: 'features/planted/lib/verify.ts', source: 'export const scenarios = [];\n' }],
  },
  {
    name: 'model-names rejects a model whose feature has only a .mts file and no invariants.ts',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [missingInvariants],
    companions: [{ file: 'features/planted/store.mts', source: 'export const store = 1;\n' }],
  },
  {
    name: 'model-names rejects properties that a call builds instead of an object literal',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [`${plantedInvariants} exports no properties object literal, so it has no simulator check named PlantedHolds, which ${plantedConfig} lists`],
    companions: [{ file: plantedInvariants, source: "export const properties = Object.fromEntries([['PlantedHolds', 1]]);\n" }],
  },
  {
    name: 'model-names rejects a properties object literal that is not exported',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [`${plantedInvariants} exports no properties object literal, so it has no simulator check named PlantedHolds, which ${plantedConfig} lists`],
    companions: [{ file: plantedInvariants, source: 'const properties = { PlantedHolds: 1 };\n\nexport const checks = properties;\n' }],
  },
  {
    name: 'model-names rejects a name that is only a nested key',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    expect: [`${plantedInvariants} has no simulator check named PlantedHolds, which ${plantedConfig} lists`],
    companions: [{ file: plantedInvariants, source: 'export const properties = { Other: { PlantedHolds: 1 } };\n' }],
  },
  {
    name: 'model-names rejects a name listed on the same line as INVARIANT',
    file: plantedConfig,
    source: 'SPECIFICATION Spec\n\nINVARIANT PlantedHolds\n',
    tool: 'model-names',
    expect: [`${plantedInvariants} has no simulator check named PlantedHolds, which ${plantedConfig} lists`],
    companions: [{ file: plantedInvariants, source: emptyInvariants }],
  },
  {
    name: 'model-names rejects a model whose TypeOK has no simulator check',
    file: plantedConfig,
    source: 'SPECIFICATION Spec\n\nINVARIANTS\n    TypeOK\n',
    tool: 'model-names',
    expect: [`${plantedInvariants} has no simulator check named TypeOK, which ${plantedConfig} lists`],
    companions: [{ file: plantedInvariants, source: emptyInvariants }],
  },
  {
    name: 'npm run check runs the name check',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'check',
    expect: [uncheckedStep],
    companions: [{ file: plantedInvariants, source: holdsInvariants }],
  },
  {
    name: "step-names rejects a step's name in the runner",
    file: 'features/tasks/planted-step.ts',
    source: "export const next = 'implement';\n",
    tool: 'step-names',
    expect: [`features/tasks/planted-step.ts:1 names the step of ${codeChange} "implement"`],
  },
  {
    name: "step-names rejects a step's name quoted in a sql template in the engine",
    file: 'services/engine/planted.ts',
    source: "import { sql } from 'kysely';\n\nexport const query = sql`select id from task where step = 'verify'`;\n",
    tool: 'step-names',
    expect: [`services/engine/planted.ts:3 names the step of ${codeChange} "verify"`],
  },
  {
    name: "step-names rejects a workflow's name as a property key",
    file: 'features/tasks/planted-key.ts',
    source: `export const caps = { '${codeChange}': 3 };\n`,
    tool: 'step-names',
    expect: [`features/tasks/planted-key.ts:1 names the workflow "${codeChange}"`],
  },
  {
    name: 'npm run check runs the step-names check',
    file: 'features/tasks/planted-check.ts',
    source: "export const last = 'land';\n",
    tool: 'check',
    expect: [`names the step of ${codeChange} "land"`],
  },
  {
    name: "strict-schemas rejects an optional field in an agent step's output",
    file: `features/${codeChange}/workflow.ts`,
    edit: optionalVerifyField,
    tool: 'strict-schemas',
    expect: [optionalExtra],
  },
  {
    name: 'strict-schemas rejects a block kind whose first field is not kind',
    file: 'shared/review.ts',
    edit: textBlockStartsWithBody,
    tool: 'strict-schemas',
    expect: [bodyFirst],
  },
  {
    name: 'npm run check runs the strict-schemas check',
    file: `features/${codeChange}/workflow.ts`,
    edit: optionalVerifyField,
    tool: 'check',
    expect: [optionalExtra],
    rejects: optionalExtra,
  },
  {
    name: 'db-types rejects the committed types when a planted migration adds a table',
    file: plantedMigration,
    source: tableMigration,
    tool: 'db-types',
    expect: [staleTypes],
  },
  {
    name: 'npm run check runs the generated-types check',
    file: plantedMigration,
    source: tableMigration,
    tool: 'check',
    expect: [staleTypes],
    rejects: generatedTypes,
  },
  {
    name: 'tsc rejects a sealing key that sealingKey did not parse from the environment',
    file: 'features/credentials/planted-key.ts',
    source: "import { createSecretKey } from 'node:crypto';\nimport { seal } from './seal.ts';\n\nexport const sealed = seal({ version: 1, key: createSecretKey(Buffer.alloc(31)) }, 'token', 'context');\n",
    tool: 'tsc',
    expect: ['TS2345'],
  },
  {
    name: 'tsc rejects a Codex login stored without saying whether it was made for AutoWorker',
    file: 'features/credentials/planted-login.ts',
    source: "import type { Secret } from './kinds.ts';\n\nexport const login: Secret = { connector: 'codex', login: '{}' };\n",
    tool: 'tsc',
    expect: ['TS2322', 'TS2741'],
  },
  {
    name: 'tsc rejects a Checks record that has no check for a connector kind',
    file: 'features/credentials/planted-checks.ts',
    source: `${plantedCheck}\nexport const planted: Checks = { codex: check, github: check };\n`,
    tool: 'tsc',
    expect: ['TS2741'],
  },
  {
    name: 'tsc rejects a raw login where AccessOnlyLogin is required',
    file: 'features/credentials/planted-job.ts',
    source: `${accessOnlyLoginFrom}\nexport const planted = launch('{"tokens": {"refresh_token": "rt"}}');\nexport const made = accessOnly;\n`,
    tool: 'tsc',
    expect: ['TS2345'],
  },
  {
    name: 'eslint rejects a type assertion that makes an AccessOnlyLogin',
    file: 'features/credentials/planted-assertion.ts',
    source: "import type { AccessOnlyLogin } from '../../shared/codex-login.ts';\n\nexport const login = '{}' as AccessOnlyLogin;\n",
    tool: 'eslint',
    expect: [noBrandAssertions],
  },
  {
    name: 'eslint rejects a double assertion through unknown that makes a SealingKey',
    file: 'features/credentials/planted-key-assertion.ts',
    source: "import type { SealingKey } from './seal.ts';\n\nexport const key = {} as unknown as SealingKey;\n",
    tool: 'eslint',
    expect: [noBrandAssertions],
  },
  {
    name: 'eslint rejects an angle-bracket assertion to a brand keyed by a symbol the file declares',
    file: 'features/planted/marked.ts',
    source: "const mark = Symbol('mark');\n\ntype Marked = string & { readonly [mark]: true };\n\nexport const marked = <Marked>'text';\n",
    tool: 'eslint',
    expect: [noBrandAssertions],
  },
  {
    name: 'eslint rejects a type predicate that narrows a string to a zod brand',
    file: 'features/planted/predicate.ts',
    source: "import { z } from 'zod';\n\nconst name = z.string().brand<'Name'>();\n\ntype Name = z.infer<typeof name>;\n\nexport const isName = (text: string): text is Name => text !== '';\nexport const parsed = name.parse('ada');\n",
    tool: 'eslint',
    expect: [noBrandAssertions],
  },
  {
    name: 'tsc rejects a step kind built without step(), so every verdict comes from the declared output',
    file: `features/${codeChange}/planted-kind.ts`,
    source: `import { review } from '../../shared/review.ts';\nimport type { StepKind } from '../../shared/workflow.ts';\n\nexport const planted: StepKind = { ${plantedStep}, blocked: 'fail', judge: () => 'pass' };\n`,
    tool: 'tsc',
    expect: ['TS2322'],
  },
  {
    name: 'tsc rejects a step whose blocked verdict its failures do not declare',
    file: `features/${codeChange}/planted-blocked.ts`,
    source: `import { review } from '../../shared/review.ts';\nimport { step } from '../../shared/workflow.ts';\n\nexport const planted = step({ ${plantedStep}, blocked: 'environment_fail', done: () => 'pass' });\n`,
    tool: 'tsc',
    expect: ['TS2322'],
  },
  {
    name: 'tsc rejects a step whose output maps to a verdict its failures do not declare',
    file: `features/${codeChange}/planted-done.ts`,
    source: `import { review } from '../../shared/review.ts';\nimport { step } from '../../shared/workflow.ts';\n\nexport const planted = step({ ${plantedStep}, blocked: 'fail', done: () => 'behavior_fail' });\n`,
    tool: 'tsc',
    expect: ['TS2322'],
  },
  {
    name: 'ci-plan rejects a uses: step other than actions/checkout, and names it',
    file: ciWorkflow,
    edit: setupNodeStep,
    tool: 'ci-plan',
    expect: [unknownStep],
  },
  {
    name: 'ci-plan rejects a run: step outside the verify container',
    file: ciWorkflow,
    edit: afterDoctor('      - run: npm test\n'),
    tool: 'ci-plan',
    expect: [`${ciWorkflow} job check step 7 runs "npm test", which ci-local cannot run`],
  },
  {
    name: 'ci-plan rejects a verify step that needs a shell',
    file: ciWorkflow,
    edit: afterDoctor('      - run: docker compose run --rm verify npm test && echo done\n'),
    tool: 'ci-plan',
    expect: [`${ciWorkflow} job check step 7 runs "docker compose run --rm verify npm test && echo done", which ci-local cannot run`],
  },
  {
    name: 'ci-plan rejects a block scalar',
    file: ciWorkflow,
    edit: afterDoctor('      - run: |\n          npm test\n'),
    tool: 'ci-plan',
    expect: ['which starts with |, and the ci-local reader does not read that form'],
  },
  {
    name: 'ci-plan rejects a job key it does not run, such as env',
    file: ciWorkflow,
    edit: { from: '  models:\n    runs-on: ubuntu-24.04\n', to: '  models:\n    env:\n      PLANTED: one\n    runs-on: ubuntu-24.04\n' },
    tool: 'ci-plan',
    expect: [`${ciWorkflow} jobs.models: Unrecognized key: "env"`],
  },
  {
    name: 'npm run check runs the local CI plan',
    file: ciWorkflow,
    edit: setupNodeStep,
    tool: 'check',
    expect: [unknownStep],
  },
];

const plantedModel: Violation = {
  name: 'npm run verify -- models runs a failing model scenario from a new feature folder',
  file: 'features/planted/verify.ts',
  source: "import { fail, type Scenario } from '../../tools/verify/check.ts';\n\nexport const scenarios: readonly Scenario[] = [\n  {\n    name: 'planted-model',\n    summary: 'a model planted to fail',\n    run: () => Promise.resolve([fail('the planted model holds', 'planted to fail')]),\n  },\n];\n",
  tool: 'models',
  expect: ['FAIL  planted-model: the planted model holds'],
};

const allowances: readonly Allowance[] = [
  {
    name: 'ci-plan runs a new run: step in the verify container with no code change',
    file: ciWorkflow,
    edit: {
      from: '      - run: docker compose run --rm verify npm run verify -- jira\n',
      to: '      - run: docker compose run --rm verify npm run verify -- jira\n      - run: docker compose run --rm verify npm run verify -- planted --seeds 3\n',
    },
    tool: 'ci-plan',
    shows: 'simulation: docker compose run --rm -T verify npm run verify -- planted --seeds 3\n',
  },
  {
    name: 'tsc accepts a review step that owes a review request',
    file: 'features/planted/requests.ts',
    source: "import { z } from 'zod';\nimport type { ActionSpec } from '../../shared/actions.ts';\nimport { reviewOwes, type ReviewStep } from '../code-change/land.ts';\n\nconst request: ActionSpec<'pr.request-review', { readonly repository: string }, { readonly requested: boolean }> = { kind: 'pr.request-review', payload: z.object({ repository: z.string() }), result: z.object({ requested: z.boolean() }) };\n\nexport const requesting: ReviewStep = pull => ({ actions: [reviewOwes(request, { repository: pull.repository })], note: 'The planted step asked for a review.' });\n",
    tool: 'tsc',
  },
  {
    name: 'eslint accepts as const, and an assertion that widens a branded value to its base type',
    file: 'features/planted/assertions.ts',
    source: "import { z } from 'zod';\n\nconst name = z.string().brand<'Name'>();\n\nexport const names = ['ada'] as const;\nexport const plain = name.parse('ada') as string;\n",
    tool: 'eslint',
  },
  {
    name: 'tsc accepts a Checks record that has a check for every connector kind',
    file: 'features/credentials/planted-checks.ts',
    source: `${plantedCheck}\nexport const planted: Checks = { codex: check, github: check, jira: check };\n`,
    tool: 'tsc',
  },
  {
    name: 'tsc accepts a login that accessOnly made where AccessOnlyLogin is required',
    file: 'features/credentials/planted-job.ts',
    source: `${accessOnlyLoginFrom}\nconst copy = accessOnly('{}');\nexport const planted = 'login' in copy ? launch(copy.login) : copy.reason;\n`,
    tool: 'tsc',
  },
  {
    name: 'eslint accepts a shebang on line 1, as an editor parses it',
    file: 'features/planted/cli.ts',
    source: '#!/usr/bin/env node\nexport const count = 1;\n',
    tool: 'eslint',
    env: { TSESTREE_SINGLE_RUN: 'false' },
  },
  {
    name: 'eslint accepts a reference directive in a .d.ts file',
    file: 'features/planted/environment.d.ts',
    source: '/// <reference types="node" />\n',
    tool: 'eslint',
  },
  {
    name: 'eslint accepts comment markers inside a string',
    file: 'features/planted/text.ts',
    source: "export const text = '// not a comment, see https://example.com';\n",
    tool: 'eslint',
  },
  {
    name: 'tsc accepts JSX in a .tsx file, so the JSX comment case lints a file the check compiles',
    file: 'features/planted/view.tsx',
    source: "export const view = <div>{'text'}</div>;\n",
    tool: 'tsc',
    companions: [jsxTypes],
  },
  {
    name: 'dependency-cruiser accepts a feature importing shared code',
    file: 'features/alpha/uses-shared.ts',
    source: "import { util } from '../../shared/util.ts';\nexport const uses = util;\n",
    tool: 'depcruise',
    companions: [{ file: 'shared/util.ts', source: 'export const util = 1;\n' }],
  },
  {
    name: 'dependency-cruiser keeps edges to installed packages, so a module importing only one is not an orphan',
    file: 'features/alpha/uses-package.ts',
    source: "import { version } from 'typescript';\nexport const compilerVersion = version;\n",
    tool: 'depcruise',
  },
  {
    name: 'the shape check accepts a feature folder named with lowercase letters, digits, and dashes',
    file: 'features/s3-upload/client.ts',
    source: 'export const client = 1;\n',
    tool: 'shape',
  },
  {
    name: 'the shape check accepts the packages that agent tooling installs under .claude/',
    file: '.claude/skills/poteto-mode/scripts/node_modules/.bin/tsc',
    linkTo: '../typescript/bin/tsc',
    tool: 'shape',
  },
  {
    name: 'sql-comments accepts the dbmate markers alone on their lines',
    file: plantedMigration,
    source: markedMigration,
    tool: 'sql-comments',
  },
  {
    name: 'sql-comments accepts the dbmate markers with the transaction:false option',
    file: plantedMigration,
    source: '-- migrate:up transaction:false\ncreate table planted (id int);\n-- migrate:down transaction:false\ndrop table planted;\n',
    tool: 'sql-comments',
  },
  {
    name: 'sql-comments accepts comment markers inside a string that holds a doubled quote',
    file: plantedMigration,
    source: migration("create table planted (note text default 'it''s -- not /* a comment */');", 'drop table planted;'),
    tool: 'sql-comments',
  },
  {
    name: 'sql-comments accepts comment markers inside a quoted identifier',
    file: plantedMigration,
    source: migration('create table "planted -- /* table */" (id int);', 'drop table "planted -- /* table */";'),
    tool: 'sql-comments',
  },
  {
    name: 'sql-comments accepts comment markers inside an escape string that holds an escaped quote',
    file: plantedMigration,
    source: migration("create table planted (note text default E'it\\'s -- not /* a comment */');", 'drop table planted;'),
    tool: 'sql-comments',
  },
  {
    name: 'sql-comments accepts the dbmate markers with CRLF line endings',
    file: plantedMigration,
    source: markedMigration.replaceAll('\n', '\r\n'),
    tool: 'sql-comments',
  },
  {
    name: 'sql-comments accepts a join on a table named comment',
    file: plantedMigration,
    source: migration('create view planted as select task.id from task join comment on comment.task_id = task.id;', 'drop view planted;'),
    tool: 'sql-comments',
  },
  {
    name: 'model-names accepts string keys and a wrapped literal, and ignores a simulator check that no model lists',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    companions: [{ file: plantedInvariants, source: "export const properties = { PlantedHolds: 1, 'PlantedStep': 2, SimulatorOnly: 3 } as const satisfies Record<string, number>;\n" }],
  },
  {
    name: "step-names accepts a step's name in a test, which checks the runner rather than running it",
    file: 'features/tasks/planted.test.ts',
    source: "export const step = 'implement';\n",
    tool: 'step-names',
  },
  {
    name: "step-names accepts a step's name inside a sentence, which names no step",
    file: 'features/tasks/planted-prose.ts',
    source: "export const note = 'Implement the plan, then verify it on land and sea.';\n",
    tool: 'step-names',
  },
  {
    name: 'model-names accepts a model that lands before its code, in a feature that holds only verify.ts',
    file: plantedConfig,
    source: holdsAndStepConfig,
    tool: 'model-names',
    companions: [{ file: 'features/planted/verify.ts', source: 'export const scenarios = [];\n' }],
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

const startsALine = (outcome: Outcome, _file: string, code: string): boolean => outcome.output.split('\n').some(line => line.startsWith(code));

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
  depcruise: {
    command: () => ['npm', 'run', '--silent', 'boundaries'],
    caught: (outcome, file, code) => outcome.output.split('\n').some(line => line.includes(code) && line.includes(file)),
  },
  shape: {
    command: () => ['npm', 'run', '--silent', 'shape'],
    caught: startsALine,
  },
  'sql-comments': {
    command: () => ['npm', 'run', '--silent', 'sql-comments'],
    caught: startsALine,
  },
  'model-names': {
    command: () => ['npm', 'run', '--silent', 'model-names'],
    caught: startsALine,
  },
  'step-names': {
    command: () => ['npm', 'run', '--silent', 'step-names'],
    caught: startsALine,
  },
  'strict-schemas': {
    command: () => ['npm', 'run', '--silent', 'strict-schemas'],
    caught: startsALine,
  },
  'ci-plan': {
    command: () => ['npm', 'run', '--silent', 'ci-plan'],
    caught: (outcome, _file, code) => outcome.output.includes(code),
  },
  'db-types': {
    command: () => ['npm', 'run', '--silent', 'db-types'],
    caught: startsALine,
  },
  models: {
    command: () => ['npm', 'run', '--silent', 'verify', '--', 'models'],
    caught: (outcome, _file, code) => outcome.output.includes(code),
  },
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['node_modules', '.git', '.claude']);

function run(tool: Tool, copy: string, file: string, env: Readonly<Record<string, string>> = {}): Outcome {
  const [executable, ...args] = tools[tool].command(copy, file);
  const result = spawnSync(executable, args, { cwd: copy, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

async function withPlanted(copy: string, plants: readonly Plant[], judge: () => Check): Promise<Check> {
  const undo: (() => Promise<void>)[] = [];
  for (const plant of plants) {
    const path = join(copy, plant.file);
    if (plant.edit !== undefined) {
      const original = await readFile(path, 'utf8');
      if (original.split(plant.edit.from).length !== 2) throw new Error(`${plant.file} must hold "${plant.edit.from}" exactly once for the case to edit it. Update the case to match the file.`);
      await writeFile(path, original.replace(plant.edit.from, plant.edit.to));
      undo.push(() => writeFile(path, original));
      continue;
    }
    const occupied = await lstat(path).then(
      () => true,
      () => false,
    );
    if (occupied) throw new Error(`${plant.file} already exists in the repository, and planting there would delete it. Plant the case at a path the repository does not use.`);
    const firstNewFolder = await mkdir(dirname(path), { recursive: true });
    undo.push(() => rm(firstNewFolder ?? path, { recursive: true, force: true }));
    if (plant.linkTo === undefined) await writeFile(path, plant.source);
    else await symlink(plant.linkTo, path);
  }
  try {
    return judge();
  } finally {
    for (const restore of undo.toReversed()) await restore();
  }
}

const reject = (copy: string, violation: Violation): Promise<Check> =>
  withPlanted(copy, [violation, ...(violation.companions ?? [])], () => {
    const outcome = run(violation.tool, copy, violation.file);
    const code = violation.expect.find(candidate => tools[violation.tool].caught(outcome, violation.rejects ?? violation.file, candidate));
    return outcome.status !== 0 && code !== undefined
      ? pass(violation.name, code)
      : fail(violation.name, `expected ${violation.expect.join(' or ')}, exit ${String(outcome.status)}`);
  });

const accept = (copy: string, allowance: Allowance): Promise<Check> =>
  withPlanted(copy, [allowance, ...(allowance.companions ?? [])], () => {
    const outcome = run(allowance.tool, copy, allowance.file, allowance.env);
    if (outcome.status !== 0) return fail(allowance.name, (tools[allowance.tool].summary ?? firstLines)(outcome));
    return allowance.shows === undefined || outcome.output.includes(allowance.shows) ? pass(allowance.name, 'accepted') : fail(allowance.name, `accepted without printing "${allowance.shows}"`);
  });

async function withCopy(work: (copy: string) => Promise<readonly Check[]>, leftOut: readonly string[] = []): Promise<readonly Check[]> {
  const copy = await mkdtemp(join(tmpdir(), 'guardrails-'));
  try {
    await cp(root, copy, { recursive: true, filter: source => !skipped.has(basename(source)) && !leftOut.includes(relative(root, source)) });
    await symlink(join(root, 'node_modules'), join(copy, 'node_modules'), 'junction');
    return await work(copy);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

export const guardrails: Scenario = {
  name: 'guardrails',
  summary: 'plants each violation a check must reject and each line it must accept, and proves both',
  run: async () => [
    ...(await withCopy(async copy => {
      const checks: Check[] = (['tsc', 'eslint', 'depcruise', 'shape', 'sql-comments', 'model-names', 'step-names', 'strict-schemas', 'ci-plan', 'db-types'] as const).map(tool => {
        const clean = run(tool, copy, '.');
        const name = `the unplanted copy passes ${tool}`;
        const problem = clean.status === 0 ? tools[tool].unclean?.(clean) : (tools[tool].summary ?? firstLines)(clean);
        return problem === undefined ? pass(name, '') : fail(name, problem);
      });
      for (const violation of violations) checks.push(await reject(copy, violation));
      for (const allowance of allowances) checks.push(await accept(copy, allowance));
      return checks;
    })),
    ...(await withCopy(async copy => [await reject(copy, plantedModel)], ['features'])),
  ],
};
