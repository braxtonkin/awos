import type { DB } from '../../shared/db/types.ts';
import { auditCatalog, type Audit } from '../../tools/verify/catalog.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { mutantName, mutants } from './simulate.ts';

const ownedTables = ['person_request'] as const satisfies readonly (keyof DB)[];

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'request writes the person, the target, and the kind its caller names, and every simulator move names rows that exist, so no move breaks these': [
    'request_asked_by_person',
    'request_on_task',
    'request_on_routine',
    'request_names_one_target',
    'request_kind_fits_target',
    'payload_is_an_object',
  ],
  'request_takes_next_place writes each place as the highest place of its target plus one, so no move writes a place below one while it stands, and its mutant puts a sequence value there instead': ['position_counts_from_one'],
  "every handler that answers recorded wrote the request's human_action in the same transaction, so no move answers recorded without it": ['answer_names_its_action'],
  'writeAnswer and refuseOpen write the answer, its time, and its reason together, so no move writes them apart': ['answer_says_when', 'refusal_says_why'],
  'it speeds the claim of the oldest open request and refuses nothing': ['open_requests'],
};

const dropped: readonly string[] = mutantName.options.flatMap(name => {
  const { drop } = mutants[name].change;
  return drop === undefined ? [] : [drop];
});

export const checkCatalog = (postgres: TestPostgres): Promise<Audit> => auditCatalog(postgres, { tables: ownedTables }, { mutated: dropped, reasoned: Object.values(noMutantYet).flat() });
