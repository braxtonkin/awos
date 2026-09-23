import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Entry = { readonly path: string; readonly dirent: Dirent };

type Rule = { readonly breaks: (entry: Entry) => boolean; readonly problem: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
const skippedAtRoot = new Set(['.git', 'node_modules']);
const packagesFolder = 'node_modules';
const agentToolingFolder = '.claude/';
const folderName = /^[a-z][a-z0-9-]*$/;

function* walk(prefix: string): Generator<Entry> {
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${dirent.name}`;
    if (skippedAtRoot.has(path)) continue;
    yield { path, dirent };
    if (dirent.isDirectory() && dirent.name !== packagesFolder) yield* walk(`${path}/`);
  }
}

const rules: readonly Rule[] = [
  {
    breaks: ({ dirent }) => dirent.isSymbolicLink(),
    problem: 'is a symbolic link. Replace it with the real file or folder, because a link can hide its target from the import rules and lint (AGENTS.md rules A5 and B2).',
  },
  {
    breaks: ({ path, dirent }) => dirent.name === packagesFolder && !path.startsWith(agentToolingFolder),
    problem: 'is a node_modules folder below the root. Install packages only at the root, because the import rules and lint skip the code inside it (AGENTS.md rules A5 and B2).',
  },
  {
    breaks: ({ path, dirent }) => dirent.isDirectory() && /^(features|services)\/[^/]+$/.test(path) && !folderName.test(dirent.name),
    problem: `must match ${folderName.source}, because the import rules put each folder name under features/ and services/ into a pattern (AGENTS.md rule A5)`,
  },
];

const violations = [...walk('')].flatMap(entry => rules.filter(rule => rule.breaks(entry)).map(rule => `${entry.path} ${rule.problem}`));
for (const violation of violations) process.stdout.write(`${violation}\n`);
process.exitCode = violations.length === 0 ? 0 : 1;
