import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = 'db/migrations';
const migrations = fileURLToPath(new URL(`../../${folder}/`, import.meta.url));
const versioned = /^(\d+)_[\w-]+\.sql$/;

const files = readdirSync(migrations, { withFileTypes: true })
  .filter(dirent => dirent.isFile())
  .map(dirent => dirent.name)
  .toSorted();

const byVersion = Map.groupBy(
  files.flatMap(file => {
    const version = versioned.exec(file)?.[1];
    return version === undefined ? [] : [{ file, version }];
  }),
  ({ version }) => version,
);

const problems = [
  ...files.filter(file => !versioned.test(file)).map(file => `${folder}/${file} has no version prefix of digits and an underscore, and dbmate keys every migration by one`),
  ...[...byVersion].flatMap(([version, clashing]) =>
    clashing.length < 2
      ? []
      : clashing.map(
          ({ file }) =>
            `${folder}/${file} shares version ${version} with ${clashing
              .filter(other => other.file !== file)
              .map(other => `${folder}/${other.file}`)
              .join(', ')}, and dbmate keys every migration by its version, so give it a version no other migration uses`,
        ),
  ),
];

for (const problem of problems) process.stdout.write(`${problem}\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
