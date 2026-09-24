import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

type Schema = Readonly<Record<string, unknown>>;

type Found = { readonly at: string; readonly problem: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowList = 'services/engine/workflows.ts';
const schemaSource = 'shared/workflow.ts';

const nullable = 'Make the field required and nullable. Write .nullable() in place of .optional(), and have the agent return null for none.';

const unsupported: Readonly<Record<string, string>> = {
  oneOf: 'Strict mode rejects oneOf. Write the choice as z.union in place of z.discriminatedUnion, so it becomes anyOf.',
  allOf: 'Strict mode rejects allOf. Merge the objects with .extend in place of .and or z.intersection.',
  not: 'Strict mode rejects not. Declare the values the field allows instead.',
  if: 'Strict mode rejects conditional schemas. Declare the values the field allows instead.',
  then: 'Strict mode rejects conditional schemas. Declare the values the field allows instead.',
  else: 'Strict mode rejects conditional schemas. Declare the values the field allows instead.',
  patternProperties: 'Strict mode rejects patternProperties. Declare the object with z.object and fixed keys.',
};

const engineModule = z.object({
  workflows: z.map(z.string(), z.object({ steps: z.array(z.looseObject({ name: z.string(), runBy: z.enum(['agent', 'engine']) })) })),
});

const schemaModule = z.object({ outputSchema: z.custom<(kind: unknown) => unknown>(value => typeof value === 'function') });

const jsonSchema = z.record(z.string(), z.unknown());

const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);

const describesObject = (schema: Schema): boolean => {
  const type = schema['type'];
  return type === 'object' || (Array.isArray(type) && type.includes('object')) || 'properties' in schema;
};

const unescaped = (token: string): string => decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~');

const resolves = (top: Schema, ref: string): boolean => {
  if (ref === '#') return true;
  if (!ref.startsWith('#/')) return false;
  const target = ref
    .slice(2)
    .split('/')
    .reduce<unknown>((at, token) => (isSchema(at) ? at[unescaped(token)] : Array.isArray(at) ? at[Number(unescaped(token))] : undefined), top);
  return target !== undefined;
};

const members = (value: unknown, at: string): readonly (readonly [string, unknown])[] =>
  isSchema(value) ? Object.entries(value).map(([key, child]) => [`${at}.${key}`, child] as const) : [];

const listed = (value: unknown, at: string): readonly (readonly [string, unknown])[] =>
  Array.isArray(value) ? value.map((child: unknown, index) => [`${at}[${String(index)}]`, child] as const) : [];

function problemsIn(schema: unknown, at: string, top: Schema): readonly Found[] {
  if (!isSchema(schema)) return [];
  const found: Found[] = Object.entries(unsupported)
    .filter(([keyword]) => keyword in schema)
    .map(([keyword, fix]) => ({ at, problem: `uses ${keyword}. ${fix}` }));
  const ref = schema['$ref'];
  if (ref !== undefined && (typeof ref !== 'string' || !resolves(top, ref))) {
    found.push({ at, problem: `refers to ${JSON.stringify(ref)}, which the schema does not define. Declare the referenced schema in the step's output.` });
  }
  if (describesObject(schema)) {
    if (schema['additionalProperties'] !== false) {
      found.push({ at, problem: 'does not set additionalProperties to false. Declare the object with z.object or z.strictObject and fixed keys.' });
    }
    const required = schema['required'];
    const keys = isSchema(schema['properties']) ? Object.keys(schema['properties']) : [];
    for (const key of keys.filter(key => !(Array.isArray(required) && required.includes(key)))) {
      found.push({ at: `${at}.properties.${key}`, problem: `is not in required, and strict mode rejects the whole schema. ${nullable}` });
    }
  }
  const items = schema['items'];
  const children = [
    ...members(schema['properties'], `${at}.properties`),
    ...members(schema['definitions'], `${at}.definitions`),
    ...members(schema['$defs'], `${at}.$defs`),
    ...(isSchema(items) ? [[`${at}.items`, items] as const] : listed(items, `${at}.items`)),
    ...listed(schema['anyOf'], `${at}.anyOf`),
  ];
  return [...found, ...children.flatMap(([path, child]) => problemsIn(child, path, top))];
}

function problemsOfRoot(schema: Schema): readonly Found[] {
  const rootProblem: readonly Found[] = schema['type'] === 'object' ? [] : [{ at: '$', problem: 'is not type "object". Declare the step\'s output as a z.object.' }];
  return [...rootProblem, ...problemsIn(schema, '$', schema)];
}

const counted = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const load = async (path: string): Promise<unknown> => import(pathToFileURL(join(root, path)).href);

const loaded = <T>(parser: z.ZodType<T>, path: string, value: unknown): T => {
  const parsed = parser.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`${path} no longer exports what strict-schemas reads: ${z.prettifyError(parsed.error)}`);
};

const { workflows } = loaded(engineModule, workflowList, await load(workflowList));
const { outputSchema } = loaded(schemaModule, schemaSource, await load(schemaSource));

const agentSteps = [...workflows].flatMap(([name, workflow]) => workflow.steps.filter(kind => kind.runBy === 'agent').map(kind => ({ workflow: name, kind })));

const violations = agentSteps.flatMap(({ workflow, kind }) =>
  problemsOfRoot(loaded(jsonSchema, schemaSource, outputSchema(kind))).map(({ at, problem }) => `${workflow} ${kind.name} ${at} ${problem}`),
);

for (const violation of violations) process.stdout.write(`${violation}\n`);
if (violations.length === 0) {
  process.stdout.write(`strict-schemas: strict mode accepts ${counted(agentSteps.length, 'agent step schema')} in ${counted(workflows.size, 'workflow')}.\n`);
}
process.exitCode = violations.length === 0 ? 0 : 1;
