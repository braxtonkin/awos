import type { DB } from '../../shared/db/types.ts';
import { auditCatalog, type Audit } from '../../tools/verify/catalog.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { mutantName, mutants } from './simulate.ts';

const ownedTables = ['routine_run', 'routine_overlap'] as const satisfies readonly (keyof DB)[];

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'the scheduler claims, presses, and records runs only for the routines, versions, presses, tasks, and runs it has just read, so no move names a missing row': [
    'run_of_routine',
    'run_follows_a_version',
    'run_cites_its_version',
    'run_now_names_its_press',
    'overlap_of_task',
    'overlap_found_by_routine',
    'overlap_seen_in_run',
  ],
  "the scheduler's claim, press, expire, and record statements write these columns together, and no simulator move writes them apart": [
    'run_is_keyed_by_its_reason',
    'claim_holds_a_lease',
    'outcome_when_finished',
    'note_when_failed',
    'counts_are_whole',
  ],
  'runNow keys each waiting run by the fresh action id of its press, so no move writes two runs for one press': ['one_run_per_press'],
  "it speeds reading a routine's runs and refuses nothing": ['runs_by_routine'],
  'a finish can reach a closed run only after its lease lapsed, and run_finishes_within_its_lease refuses that finish too, so dropping this trigger alone changes nothing a property can see while that check stands': ['finished_run_is_final'],
};

const dropped: readonly string[] = mutantName.options.flatMap(name => {
  const { change } = mutants[name];
  return 'drop' in change ? [change.drop] : [];
});

export const checkCatalog = (postgres: TestPostgres): Promise<Audit> =>
  auditCatalog(postgres, { tables: ownedTables, owner: 'routines' }, { mutated: dropped, reasoned: Object.values(noMutantYet).flat() });
