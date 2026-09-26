import { readFile } from 'node:fs/promises';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from './check.ts';
import { adminClient, withPostgres } from './postgres.ts';

const allowedFile = new URL('dashboard-grants.json', import.meta.url);

const allowed = z.strictObject({ why: z.string().min(1), held: z.array(z.string().min(1)), never: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)) });

const plant = sql`grant select (ciphertext) on credential to dashboard`;

type Grant = { readonly target: string; readonly privilege: string; readonly field: string | null };

async function held(db: Kysely<unknown>): Promise<readonly string[]> {
  const tables = await sql<Grant>`
    select table_name::text as target, privilege_type::text as privilege, null::text as field from information_schema.role_table_grants where grantee = 'dashboard'
    union all
    select c.table_name::text, c.privilege_type::text, c.column_name::text from information_schema.column_privileges c
    where c.grantee = 'dashboard'
      and not exists (select from information_schema.role_table_grants t where t.grantee = 'dashboard' and t.table_name = c.table_name and t.privilege_type = c.privilege_type)
    union all
    select routine_name::text, privilege_type::text, null::text from information_schema.routine_privileges where grantee = 'dashboard'
    union all
    select r.rolname::text, 'MEMBER OF', null::text from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = 'dashboard'::regrole
  `.execute(db);
  const grouped = Map.groupBy(tables.rows, row => `${row.privilege.toLowerCase()} on ${row.target}`);
  return [...grouped].map(([what, rows]) => {
    const columns = rows.flatMap(row => (row.field === null ? [] : [row.field])).toSorted();
    return columns.length === 0 ? what : `${what} (${columns.join(', ')})`;
  }).toSorted();
}

async function readable(db: Kysely<unknown>, column: string): Promise<boolean> {
  const [table = '', name = ''] = column.split('.');
  const found = await sql<{ readable: boolean }>`select has_column_privilege('dashboard', ${table}, ${name}, 'select') as readable`.execute(db);
  return found.rows[0]?.readable ?? true;
}

async function judge(db: Kysely<unknown>, file: z.infer<typeof allowed>): Promise<readonly string[]> {
  const holds = await held(db);
  const outside = holds.filter(grant => !file.held.includes(grant)).map(grant => `the dashboard role holds ${grant}, which tools/verify/dashboard-grants.json does not list`);
  const stale = file.held.filter(grant => !holds.includes(grant)).map(grant => `tools/verify/dashboard-grants.json lists ${grant}, which the dashboard role does not hold`);
  const forbidden = [];
  for (const column of file.never) if (await readable(db, column)) forbidden.push(`the dashboard role can read ${column}, which it must never read`);
  return [...outside, ...stale, ...forbidden];
}

async function onScratch<T>(url: string, work: (db: Kysely<unknown>) => Promise<T>): Promise<T> {
  const db = adminClient(url);
  try {
    return await work(db);
  } finally {
    await db.destroy();
  }
}

export const dashboardGrants: Scenario = {
  name: 'dashboard-grants',
  summary: 'lists every privilege the dashboard role holds after the migrations and fails on any that tools/verify/dashboard-grants.json does not list, on any it lists that the role lacks, and on a column it must never read; a planted grant on credential.ciphertext must fail',
  run: async () => {
    const file = allowed.parse(JSON.parse(await readFile(allowedFile, 'utf8')));
    return withPostgres(async postgres => {
      const checks: Check[] = [];
      const real = await postgres.scratch();
      const problems = await onScratch(real.url, db => judge(db, file));
      checks.push(problems.length === 0 ? pass('the dashboard role holds exactly the listed privileges', `${String(file.held.length)} grants, never ${file.never.join(', ')}`) : fail('the dashboard role holds exactly the listed privileges', problems.join('; ')));
      const planted = await postgres.scratch();
      const caught = await onScratch(planted.url, async db => {
        await plant.execute(db);
        return judge(db, file);
      });
      const named = caught.some(problem => problem.includes('credential.ciphertext'));
      checks.push(named ? pass('a planted grant on credential.ciphertext fails the check', caught.join('; ')) : fail('a planted grant on credential.ciphertext fails the check', caught.join('; ') || 'nothing was reported'));
      return checks;
    });
  },
};
