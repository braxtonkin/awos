import { sql } from 'kysely';
import { adminClient, type TestPostgres } from './postgres.ts';

export const catalogOwners = ['bridge', 'github', 'routines'] as const;

export type CatalogOwner = (typeof catalogOwners)[number];

export type Scope = { readonly tables: readonly string[]; readonly owner?: CatalogOwner; readonly domains?: boolean };

export type Listed = { readonly mutated: readonly string[]; readonly reasoned: readonly string[] };

export type Audit = { readonly guards: readonly string[]; readonly unlisted: readonly string[]; readonly absent: readonly string[]; readonly listedTwice: readonly string[] };

const prefixOf = (owner: CatalogOwner): string => `${owner}_`;

export async function auditCatalog(postgres: TestPostgres, scope: Scope, listed: Listed): Promise<Audit> {
  const scratch = await postgres.scratch();
  const db = adminClient(scratch.url);
  try {
    const own = scope.owner === undefined ? null : prefixOf(scope.owner);
    const handedOff = catalogOwners.filter(owner => owner !== scope.owner).map(prefixOf);
    const { rows: owned } = await sql<{ name: string }>`
      with tables as (select unnest(${scope.tables}::regclass[]) as relation),
      handed as (select unnest(${handedOff}::text[]) as prefix),
      named as (
        select c.conname as name
        from pg_constraint c
        join tables o on o.relation = c.conrelid
        join pg_class t on t.oid = c.conrelid
        left join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where not (c.contype = 'p' and c.conname = t.relname || '_pkey')
          and not (c.contype = 'n' and c.conname = t.relname || '_' || a.attname || '_not_null')
        union all
        select i.relname
        from pg_index x
        join tables o on o.relation = x.indrelid
        join pg_class i on i.oid = x.indexrelid
        where not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
        union all
        select g.tgname from pg_trigger g join tables o on o.relation = g.tgrelid where not g.tgisinternal
        union all
        select c.conname from pg_constraint c join pg_type d on d.oid = c.contypid
        where ${scope.domains === true} and c.contypid <> 0 and d.typnamespace = 'public'::regnamespace
      )
      select name from named where not exists (select 1 from handed where starts_with(named.name, handed.prefix))
      union
      select conname from pg_constraint where starts_with(conname, ${own})
      union
      select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
      where starts_with(i.relname, ${own}) and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
      union
      select tgname from pg_trigger where not tgisinternal and starts_with(tgname, ${own})`.execute(db);
    const { rows: everywhere } = await sql<{ name: string }>`
      select conname as name from pg_constraint union select tgname from pg_trigger where not tgisinternal union select relname from pg_class where relkind = 'i'`.execute(db);
    const guards = owned.map(row => row.name).sort();
    const known = new Set(everywhere.map(row => row.name));
    const mutated = [...new Set(listed.mutated)];
    const all = [...mutated, ...listed.reasoned];
    return {
      guards,
      unlisted: guards.filter(name => !all.includes(name)),
      absent: [...mutated.filter(name => !known.has(name)), ...listed.reasoned.filter(name => !guards.includes(name))].sort(),
      listedTwice: [...new Set(all.filter((name, index) => all.indexOf(name) !== index))].sort(),
    };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export const catalogProblems = (audit: Audit): readonly string[] => [
  ...audit.unlisted.map(name => `${name} is in neither list`),
  ...audit.absent.map(name => `${name} is listed, but the schema has no such guard of this feature`),
  ...audit.listedTwice.map(name => `${name} is listed twice`),
];
