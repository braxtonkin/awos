import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeedFile } from './github.ts';

const sandboxFolder = fileURLToPath(new URL('sandbox/', import.meta.url));
const packageTypesFolder = fileURLToPath(new URL('../../shared/types/', import.meta.url));
const sandboxPackageTypes = ['tinybench.d.ts'] as const;
const skipped = new Set(['node_modules']);

export async function sandboxSeed(): Promise<readonly SeedFile[]> {
  const files: SeedFile[] = [];
  for (const entry of await readdir(sandboxFolder, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    const inside = relative(sandboxFolder, path).split('\\').join('/');
    if (!entry.isFile() || inside.split('/').some(part => skipped.has(part))) continue;
    files.push({ path: inside, content: await readFile(path, 'utf8') });
  }
  for (const name of sandboxPackageTypes) files.push({ path: `types/${name}`, content: await readFile(join(packageTypesFolder, name), 'utf8') });
  return files;
}

export async function writeSandbox(to: string): Promise<void> {
  for (const file of await sandboxSeed()) {
    const target = join(to, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}
