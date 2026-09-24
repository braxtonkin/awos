import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { fail, pass, type Check, type Scenario } from './check.ts';
import { adminClient, dbmate, migrationsFolder, startPostgres } from './postgres.ts';

type Fingerprint = readonly string[];

type Applied = { readonly file: string; readonly before: Fingerprint };

async function fingerprint(url: string): Promise<Fingerprint> {
  const db = adminClient(url);
  try {
    const { rows } = await sql<{ entry: string }>`
      select format('relation %s %s', c.relname, c.relkind) as entry
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname not in ('schema_migrations', 'schema_migrations_pkey')
      union all
      select format('column %s.%s %s%s%s%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
        case when a.attnotnull then ' not null' else '' end,
        case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end,
        coalesce(case when a.attgenerated <> '' then ' generated ' else ' default ' end || pg_get_expr(d.adbin, d.adrelid), ''))
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and c.relname <> 'schema_migrations'
        and a.attnum > 0 and not a.attisdropped
      union all
      select format('constraint %s.%s %s', coalesce(c.relname, format_type(k.contypid, null)), k.conname, pg_get_constraintdef(k.oid))
      from pg_constraint k
      left join pg_class c on c.oid = k.conrelid
      where k.connamespace = 'public'::regnamespace and c.relname is distinct from 'schema_migrations'
      union all
      select format('index %s', pg_get_indexdef(x.indexrelid))
      from pg_index x
      join pg_class c on c.oid = x.indrelid
      where c.relnamespace = 'public'::regnamespace and c.relname <> 'schema_migrations'
      union all
      select format('trigger %s', pg_get_triggerdef(g.oid))
      from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      where c.relnamespace = 'public'::regnamespace and not g.tgisinternal
      union all
      select format('type %s %s%s', t.typname, t.typtype,
        coalesce(' (' || (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) || ')', ''))
      from pg_type t
      where t.typnamespace = 'public'::regnamespace and t.typname not in ('schema_migrations', '_schema_migrations')
      union all
      select format('view %s %s', c.relname, pg_get_viewdef(c.oid))
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
      union all
      select case p.prokind when 'a' then format('aggregate %s', p.oid::regprocedure) else format('function %s', pg_get_functiondef(p.oid)) end
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace`.execute(db);
    return rows.map(row => row.entry.replace(/\s+/g, ' ').trim()).sort();
  } finally {
    await db.destroy();
  }
}

function difference(expected: Fingerprint, found: Fingerprint): string | undefined {
  const had = new Set(expected);
  const has = new Set(found);
  const changes = [
    ...found.filter(entry => !had.has(entry)).map(entry => ({ entry, says: `unexpected ${entry}` })),
    ...expected.filter(entry => !has.has(entry)).map(entry => ({ entry, says: `missing ${entry}` })),
  ].sort((a, b) => (a.entry < b.entry ? -1 : 1));
  const [first] = changes;
  if (first === undefined) return undefined;
  return changes.length === 1 ? first.says : `${first.says}, the first of ${String(changes.length)} differences`;
}

function restores({ file, before }: Applied, found: Fingerprint): Check {
  const name = `rolling back ${file} restores the schema from before it`;
  const changed = difference(before, found);
  if (changed !== undefined) return fail(name, changed);
  return pass(name, before.length === 0 ? 'the schema is empty again' : `${String(found.length)} catalog entries, as before it applied`);
}

export const migrations: Scenario = {
  name: 'migrations',
  summary: 'applies each migration in turn, rolls each back to the schema it found, and applies them all again',
  run: async () => {
    const postgres = await startPostgres();
    const staged = mkdtempSync(join(tmpdir(), 'migrations-'));
    try {
      const url = postgres.url('migrations');
      const applied: Applied[] = [];
      let schema: Fingerprint = [];
      for (const file of readdirSync(migrationsFolder).filter(name => name.endsWith('.sql')).sort()) {
        copyFileSync(join(migrationsFolder, file), join(staged, file));
        dbmate(url, 'up', staged);
        applied.push({ file, before: schema });
        schema = await fingerprint(url);
      }
      const checks: Check[] = [];
      for (const migration of applied.toReversed()) {
        dbmate(url, 'rollback', staged);
        const check = restores(migration, await fingerprint(url));
        checks.push(check);
        if (!check.passed) return checks;
      }
      dbmate(url, 'up', staged);
      const reapplied = difference(schema, await fingerprint(url));
      const again = 'every migration applies again after the rollback';
      checks.push(reapplied === undefined ? pass(again, `${String(applied.length)} migrations, ${String(schema.length)} catalog entries, as in the first run`) : fail(again, reapplied));
      return checks;
    } finally {
      rmSync(staged, { recursive: true, force: true });
      await postgres.stop();
    }
  },
};
