import { z } from 'zod';

type Yaml = null | string | readonly Yaml[] | { readonly [key: string]: Yaml };

type Line = { readonly number: number; readonly indent: number; readonly text: string };

export type Step = { readonly job: string; readonly name: string; readonly args: readonly string[] };

export type Plan = { readonly steps: readonly Step[]; readonly problems: readonly string[] };

export const workflowFile = '.github/workflows/ci.yml';
export const setupJob = 'setup';
const setupRuns: ReadonlySet<string> = new Set(['docker compose build verify', 'docker compose run --rm verify npm ci']);
const verifyRun = 'docker compose run --rm verify ';
const plainWord = /^[A-Za-z0-9_./=:@+-]+$/;
const mappingEntry = /^([A-Za-z0-9_-]+):(?: (.*))?$/;
const unreadableStart = /^[-?:,\]{}#&*!|>%@`]/;

class Unreadable extends Error {}

const unreadable = (line: Line, problem: string): Unreadable => new Unreadable(`${workflowFile}:${String(line.number)} ${problem}`);

function linesOf(text: string): Line[] {
  return text.split('\n').flatMap((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const at = { number: index + 1, indent: 0, text: line };
    if (line.includes('\t')) throw unreadable(at, 'holds a tab. Indent with spaces.');
    const text = line.trimStart();
    if (text === '') return [];
    const found = { number: index + 1, indent: line.length - text.length, text: text.trimEnd() };
    if (text.startsWith('#')) throw unreadable(found, 'holds a comment, which the ci-local reader does not read.');
    return [found];
  });
}

function scalar(line: Line, value: string): Yaml {
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw unreadable(line, `holds the single-quoted value ${value}, which does not end on its line.`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    if (!/^"[^"\\]*"$/.test(value)) throw unreadable(line, `holds the double-quoted value ${value}, which ends off its line or holds an escape.`);
    return value.slice(1, -1);
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw unreadable(line, `holds the flow sequence ${value}, which does not end on its line.`);
    return value
      .slice(1, -1)
      .split(',')
      .map(item => item.trim())
      .map(item => {
        if (!plainWord.test(item)) throw unreadable(line, `holds the flow item "${item}", which is not a plain word.`);
        return item;
      });
  }
  if (unreadableStart.test(value)) throw unreadable(line, `holds the value "${value}", which starts with ${value.charAt(0)}, and the ci-local reader does not read that form.`);
  if (value.includes(' #') || value.includes(': ')) throw unreadable(line, `holds the value "${value}", which holds " #" or ": ", and the ci-local reader does not read that form.`);
  return value;
}

function readYaml(text: string): Yaml {
  const lines = linesOf(text);
  let at = 0;
  const peek = (): Line | undefined => lines[at];

  const block = (indent: number): Yaml => {
    const first = peek();
    if (first === undefined || first.indent !== indent) throw new Unreadable(`${workflowFile} ends where a nested value belongs.`);
    return first.text === '-' || first.text.startsWith('- ') ? sequence(indent) : mapping(indent);
  };

  const nested = (parent: Line): Yaml => {
    const next = peek();
    return next === undefined || next.indent <= parent.indent ? null : block(next.indent);
  };

  const sequence = (indent: number): Yaml => {
    const items: Yaml[] = [];
    for (let line = peek(); line?.indent === indent && (line.text === '-' || line.text.startsWith('- ')); line = peek()) {
      const content = line.text.slice(1).trimStart();
      if (content === '') {
        at += 1;
        items.push(nested(line));
      } else if (mappingEntry.test(content)) {
        lines[at] = { number: line.number, indent: indent + line.text.length - content.length, text: content };
        items.push(mapping(indent + line.text.length - content.length));
      } else {
        at += 1;
        items.push(scalar(line, content));
      }
    }
    return items;
  };

  const mapping = (indent: number): Yaml => {
    const entries: Record<string, Yaml> = {};
    for (let line = peek(); line?.indent === indent; line = peek()) {
      const [, key, value] = mappingEntry.exec(line.text) ?? [];
      if (key === undefined) throw unreadable(line, `holds "${line.text}", which is not a key and a value.`);
      if (Object.hasOwn(entries, key)) throw unreadable(line, `repeats the key ${key}.`);
      at += 1;
      entries[key] = value === undefined ? nested(line) : scalar(line, value);
    }
    return entries;
  };

  const value = block(0);
  const left = peek();
  if (left !== undefined) throw unreadable(left, 'is indented where no value can hold it.');
  return value;
}

const checkoutStep = z.strictObject({
  uses: z.string().regex(/^actions\/checkout@[0-9a-f]{40}$/),
  with: z.strictObject({ 'persist-credentials': z.literal('false'), 'fetch-depth': z.literal('0').optional() }).optional(),
});

const runStep = z.strictObject({ name: z.string().optional(), run: z.string() });

const workflowSchema = z.strictObject({
  name: z.string().optional(),
  on: z.unknown(),
  concurrency: z.unknown().optional(),
  permissions: z.unknown().optional(),
  jobs: z.record(z.string(), z.strictObject({ 'runs-on': z.string(), 'timeout-minutes': z.string().optional(), steps: z.array(z.unknown()).min(1) })),
});

const described = (step: unknown): string => {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return `is ${JSON.stringify(step)}`;
  return 'uses' in step && typeof step.uses === 'string' ? `uses ${step.uses}` : `has the keys ${Object.keys(step).join(', ')}`;
};

function command(run: string): readonly string[] | undefined {
  if (run === 'docker compose build verify') return run.split(' ').slice(1);
  if (!run.startsWith(verifyRun)) return undefined;
  const words = run.slice(verifyRun.length).split(' ');
  return words.every(word => plainWord.test(word)) ? ['compose', 'run', '--rm', '-T', 'verify', ...words] : undefined;
}

export type Workflow = z.infer<typeof workflowSchema>;

export function parseWorkflow(text: string): { readonly workflow: Workflow } | { readonly problems: readonly string[] } {
  let tree: Yaml;
  try {
    tree = readYaml(text);
  } catch (error) {
    if (error instanceof Unreadable) return { problems: [error.message] };
    throw error;
  }
  const parsed = workflowSchema.safeParse(tree);
  return parsed.success ? { workflow: parsed.data } : { problems: parsed.error.issues.map(issue => `${workflowFile} ${issue.path.map(String).join('.')}: ${issue.message}`) };
}

export function planOf(text: string): Plan {
  const read = parseWorkflow(text);
  if ('problems' in read) return { steps: [], problems: read.problems };
  const setup: Step[] = [];
  const steps: Step[] = [];
  const problems: string[] = [];
  for (const [job, { steps: listed }] of Object.entries(read.workflow.jobs)) {
    listed.forEach((step, index) => {
      const where = `${workflowFile} job ${job} step ${String(index + 1)}`;
      if (checkoutStep.safeParse(step).success) return;
      const run = runStep.safeParse(step);
      if (!run.success) {
        problems.push(`${where} ${described(step)}, which ci-local cannot run. It runs only run: steps and actions/checkout.`);
        return;
      }
      const args = command(run.data.run);
      if (args === undefined) {
        problems.push(`${where} runs "${run.data.run}", which ci-local cannot run. It runs docker compose build verify, and docker compose run --rm verify followed by plain words.`);
        return;
      }
      const isSetup = setupRuns.has(run.data.run);
      if (isSetup && setup.some(known => known.args.join(' ') === args.join(' '))) return;
      const owner = isSetup ? setupJob : job;
      (isSetup ? setup : steps).push({ job: owner, name: `${owner}: docker ${args.join(' ')}`, args });
    });
  }
  return { steps: [...setup, ...steps], problems };
}

