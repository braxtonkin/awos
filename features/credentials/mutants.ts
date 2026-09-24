import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { refusal, type Refusal } from '../../shared/db/client.ts';
import type { ConnectorKind, DB } from '../../shared/db/types.ts';
import {
  accessProblems,
  epoch,
  inScratch,
  messageOf,
  probe,
  storeToken,
  tokenReads,
  tokenWrites,
  writeAction,
  writeCiphertext,
  writeCredential,
  type Entry,
  type Outcome,
  type Probe,
  type World,
} from './world.ts';

type Targets = { readonly action: string; readonly routine: string };

type CredentialRow = {
  readonly connector: string | null;
  readonly scope: string | null;
  readonly person_id: string | null;
  readonly ciphertext: Buffer | null;
  readonly action_id: string | null;
};

type Attempt = { readonly accepted: true } | { readonly accepted: false; readonly refusal: Refusal | undefined; readonly message: string };

type Guard = {
  readonly table: 'credential' | 'human_action';
  readonly refuses: string;
  readonly expect: Refusal;
  readonly probe: (world: World, targets: Targets) => Promise<unknown>;
};

type Grant = { readonly name: string; readonly statement: RawBuilder<unknown>; readonly through: readonly Probe[] };

const guardName = z.enum([
  'credential_names_its_connector',
  'credential_states_its_scope',
  'credential_of_person',
  'credential_holds_a_seal',
  'ciphertext_holds_nonce_and_tag',
  'credential_cites_its_action',
  'credential_written_by_action',
  'credential_scope_matches_connector',
  'one_credential_per_connector_and_person',
  'personal_credential_has_person',
  'one_target',
  'target_fits_kind',
]);

type GuardName = z.infer<typeof guardName>;

const grantName = z.enum(['select_ciphertext', 'select_credential', 'update_ciphertext', 'insert_human_action', 'insert_credential']);

type GrantName = z.infer<typeof grantName>;

const leakName = z.enum(['ciphertext_view', 'ciphertext_function']);

type LeakName = z.infer<typeof leakName>;

type Leak = { readonly name: string; readonly planted: string; readonly plant: readonly RawBuilder<unknown>[] };

export const mutantOption = z.union([guardName, grantName, leakName, z.literal('all')]);

const credentialRow = (world: World, targets: Targets, changes: Partial<CredentialRow>): CredentialRow => ({
  connector: 'codex',
  scope: 'personal',
  person_id: world.ada,
  ciphertext: randomBytes(44),
  action_id: targets.action,
  ...changes,
});

const insertCredentials = (world: World, rows: readonly CredentialRow[]): Promise<unknown> =>
  sql`insert into credential (connector, scope, person_id, ciphertext, key_version, action_id) values ${sql.join(
    rows.map(row => sql`(${row.connector}, ${row.scope}, ${row.person_id}, ${row.ciphertext}, 1, ${row.action_id})`),
  )}`.execute(world.engine);

const insertCredential =
  (changes: Partial<CredentialRow>) =>
  (world: World, targets: Targets): Promise<unknown> =>
    insertCredentials(world, [credentialRow(world, targets, changes)]);

const insertAction =
  (connector: ConnectorKind | null) =>
  (world: World, targets: Targets): Promise<unknown> =>
    world.engine
      .insertInto('human_action')
      .values({ id: randomUUID(), at: new Date(epoch), person_id: world.ada, kind: 'replace_credential', connector, routine_id: targets.routine })
      .execute();

const mutants: Readonly<Record<GuardName, Guard>> = {
  credential_names_its_connector: {
    table: 'credential',
    refuses: 'a credential that names no connector',
    expect: { kind: 'not_null', table: 'credential', column: 'connector' },
    probe: insertCredential({ connector: null }),
  },
  credential_states_its_scope: {
    table: 'credential',
    refuses: 'a credential that states no scope',
    expect: { kind: 'not_null', table: 'credential', column: 'scope' },
    probe: insertCredential({ scope: null }),
  },
  credential_of_person: {
    table: 'credential',
    refuses: 'a credential of a person who does not exist',
    expect: { kind: 'foreign_key', name: 'credential_of_person' },
    probe: insertCredential({ person_id: '999999999' }),
  },
  credential_holds_a_seal: {
    table: 'credential',
    refuses: 'a credential with no ciphertext',
    expect: { kind: 'not_null', table: 'credential', column: 'ciphertext' },
    probe: insertCredential({ ciphertext: null }),
  },
  ciphertext_holds_nonce_and_tag: {
    table: 'credential',
    refuses: 'a 28-byte ciphertext, only a nonce and a tag',
    expect: { kind: 'check', name: 'ciphertext_holds_nonce_and_tag' },
    probe: insertCredential({ ciphertext: randomBytes(28) }),
  },
  credential_cites_its_action: {
    table: 'credential',
    refuses: 'a credential that cites no action',
    expect: { kind: 'not_null', table: 'credential', column: 'action_id' },
    probe: insertCredential({ action_id: null }),
  },
  credential_written_by_action: {
    table: 'credential',
    refuses: 'a credential that cites an action nobody recorded',
    expect: { kind: 'foreign_key', name: 'credential_written_by_action' },
    probe: insertCredential({ action_id: randomUUID() }),
  },
  credential_scope_matches_connector: {
    table: 'credential',
    refuses: 'a team credential for a connector that keeps one per person',
    expect: { kind: 'foreign_key', name: 'credential_scope_matches_connector' },
    probe: insertCredential({ scope: 'team', person_id: null }),
  },
  one_credential_per_connector_and_person: {
    table: 'credential',
    refuses: 'a second credential for a team connector',
    expect: { kind: 'unique', name: 'one_credential_per_connector_and_person' },
    probe: async (world, targets) => {
      await world.engine.updateTable('connector').set({ scope: 'team' }).where('kind', '=', 'github').execute();
      const teamRow = credentialRow(world, targets, { connector: 'github', scope: 'team', person_id: null });
      return insertCredentials(world, [teamRow, { ...teamRow, ciphertext: randomBytes(44) }]);
    },
  },
  personal_credential_has_person: {
    table: 'credential',
    refuses: 'a personal credential that names no person',
    expect: { kind: 'check', name: 'personal_credential_has_person' },
    probe: insertCredential({ person_id: null }),
  },
  one_target: {
    table: 'human_action',
    refuses: 'a replacement that names both a connector and a routine',
    expect: { kind: 'check', name: 'one_target' },
    probe: insertAction('codex'),
  },
  target_fits_kind: {
    table: 'human_action',
    refuses: 'a replacement that names a routine instead of a connector',
    expect: { kind: 'check', name: 'target_fits_kind' },
    probe: insertAction(null),
  },
};

const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'Postgres will not drop the key that credential_scope_matches_connector points at while that foreign key stands': ['credential_scope_target'],
};

const grants: Readonly<Record<GrantName, Grant>> = {
  select_ciphertext: {
    name: 'the write-only probe catches a grant of select on the ciphertext column',
    statement: sql`grant select (ciphertext) on credential to dashboard`,
    through: tokenReads,
  },
  select_credential: {
    name: 'the write-only probe catches a grant of select on the whole credential table',
    statement: sql`grant select on credential to dashboard`,
    through: tokenReads,
  },
  update_ciphertext: {
    name: 'the write probe catches a grant of update on the ciphertext column',
    statement: sql`grant update (ciphertext) on credential to dashboard`,
    through: [writeCiphertext],
  },
  insert_human_action: {
    name: 'the write probe catches a grant of insert on human_action',
    statement: sql`grant insert on human_action to dashboard`,
    through: [writeAction],
  },
  insert_credential: {
    name: 'the write probe catches a grant of insert on credential',
    statement: sql`grant insert on credential to dashboard`,
    through: [writeCredential],
  },
};

const leaks: Readonly<Record<LeakName, Leak>> = {
  ciphertext_view: {
    name: 'the access check catches a view over credential.ciphertext that the dashboard role can select',
    planted: 'credential_ciphertext',
    plant: [sql`create view credential_ciphertext as select id, ciphertext from credential`, sql`grant select on credential_ciphertext to dashboard`],
  },
  ciphertext_function: {
    name: 'the access check catches a second function that touches credential and the dashboard role can execute',
    planted: 'ciphertext_of',
    plant: [
      sql`create function ciphertext_of(of_id bigint) returns bytea language sql security definer as $$ select ciphertext from credential where id = of_id $$`,
      sql`grant execute on function ciphertext_of(bigint) to dashboard`,
    ],
  },
};

const ownedTables = ['connector', 'credential'] as const satisfies readonly (keyof DB)[];

const humanActionGuards = ['one_target', 'target_fits_kind'] as const satisfies readonly GuardName[];

async function seedTargets(world: World): Promise<Targets> {
  const routine = await world.engine.insertInto('routine').values({ creator_id: world.ada }).returning('id').executeTakeFirstOrThrow();
  const action = randomUUID();
  await world.engine.insertInto('human_action').values({ id: action, at: new Date(epoch), person_id: world.ada, kind: 'replace_credential', connector: 'codex' }).execute();
  return { action, routine: routine.id };
}

async function attempt(run: () => Promise<unknown>): Promise<Attempt> {
  try {
    await run();
    return { accepted: true };
  } catch (error) {
    return { accepted: false, refusal: refusal(error), message: messageOf(error) };
  }
}

const described = (found: Refusal): string => (found.kind === 'not_null' ? `the not-null on ${found.table}.${found.column}` : `${found.kind} ${found.name}`);

function refusedAs(tried: Attempt, expected: Refusal): readonly string[] {
  if (tried.accepted) return ['the probe was accepted while the guard stood'];
  if (isDeepStrictEqual(tried.refusal, expected)) return [];
  return [`expected a refusal by ${described(expected)}, got ${tried.refusal === undefined ? tried.message : described(tried.refusal)}`];
}

async function guardOutcome(world: World, guard: GuardName): Promise<Outcome> {
  const { table, expect, probe: run } = mutants[guard];
  const targets = await seedTargets(world);
  const standing = await attempt(() => run(world, targets));
  await world.engine.schema.alterTable(table).dropConstraint(guard).execute();
  const dropped = await attempt(() => run(world, targets));
  return {
    problems: [...refusedAs(standing, expect), ...(dropped.accepted ? [] : [`once ${guard} was dropped, the probe was still refused: ${dropped.message}`])],
    detail: `refused by ${described(expect)}, then accepted once ${guard} was dropped from ${table}`,
  };
}

async function grantOutcome(world: World, grant: GrantName): Promise<Outcome> {
  const { statement, through } = grants[grant];
  const stored = await storeToken(world, world.ada);
  const before = await probe(world, stored, [...tokenReads, ...tokenWrites]);
  await statement.execute(world.engine);
  const after = await probe(world, stored, through);
  return {
    problems: [
      ...before.filter(reading => reading.outcome !== 'refused').map(reading => `before the grant, ${reading.name} was not refused`),
      ...after
        .filter(reading => reading.outcome !== 'through')
        .map(reading => `after the grant, ${reading.name} ${reading.outcome === 'refused' ? 'was still refused' : 'did not get the token or write a row'}`),
    ],
    detail: `before the grant all ${String(before.length)} reads and writes were refused, and after it ${after.map(reading => reading.name).join(', ')} got through`,
  };
}

async function leakOutcome(world: World, leak: LeakName): Promise<Outcome> {
  const { planted, plant } = leaks[leak];
  const before = await accessProblems(world);
  for (const statement of plant) await statement.execute(world.engine);
  const after = await accessProblems(world);
  return {
    problems: [
      ...before.map(problem => `before the plant, ${problem}`),
      ...(after.some(problem => problem.includes(planted)) ? [] : [`after planting ${planted}, the access check reported ${after.length === 0 ? 'nothing' : after.join('; ')}`]),
    ],
    detail: `the access check was clean, and after the plant it reported: ${after.join('; ')}`,
  };
}

async function catalogOutcome(world: World): Promise<Outcome> {
  const { rows } = await sql<{ name: string }>`
    with owned as (select unnest(${ownedTables}::regclass[]) as relation)
    select c.conname as name
    from pg_constraint c
    join owned o on o.relation = c.conrelid
    join pg_class t on t.oid = c.conrelid
    left join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where not (c.contype = 'p' and c.conname = t.relname || '_pkey')
      and not (c.contype = 'n' and c.conname = t.relname || '_' || a.attname || '_not_null')
    union all
    select i.relname
    from pg_index x
    join owned o on o.relation = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    where not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
    union all
    select g.tgname
    from pg_trigger g
    join owned o on o.relation = g.tgrelid
    where not g.tgisinternal
    union all
    select c.conname
    from pg_constraint c
    where c.conrelid = 'human_action'::regclass and c.conname = any(${humanActionGuards}::name[])`.execute(world.engine);
  const guards = new Set(rows.map(row => row.name));
  const listed: readonly string[] = [...guardName.options, ...Object.values(noMutantYet).flat()];
  return {
    problems: [
      ...[...guards].filter(name => !listed.includes(name)).sort().map(name => `${name} is in neither list`),
      ...listed.filter(name => !guards.has(name)).map(name => `${name} is listed, but the schema has no such guard`),
      ...[...new Set(listed.filter((name, index) => listed.indexOf(name) !== index))].map(name => `${name} is listed twice`),
    ],
    detail: `${String(guards.size)} guards: ${String(guardName.options.length)} with a mutant, ${String(guards.size - guardName.options.length)} with a reason`,
  };
}

export function mutantEntries(mutant: z.infer<typeof mutantOption>): readonly Entry[] {
  const chosen = (name: string): boolean => mutant === 'all' || mutant === name;
  return [
    ...(mutant === 'all'
      ? [
          {
            name: 'every named constraint, index, and trigger on connector and credential, and one_target and target_fits_kind on human_action, has a mutant or a reason in noMutantYet',
            run: inScratch(catalogOutcome),
          },
        ]
      : []),
    ...guardName.options
      .filter(chosen)
      .map(guard => ({ name: `${guard} refuses ${mutants[guard].refuses}, and accepts it once dropped`, run: inScratch(world => guardOutcome(world, guard)) })),
    ...grantName.options.filter(chosen).map(grant => ({ name: grants[grant].name, run: inScratch(world => grantOutcome(world, grant)) })),
    ...leakName.options.filter(chosen).map(leak => ({ name: leaks[leak].name, run: inScratch(world => leakOutcome(world, leak)) })),
  ];
}
