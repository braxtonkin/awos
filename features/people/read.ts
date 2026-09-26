import type { Database } from '../../shared/db/client.ts';
import type { PersonKind } from '../../shared/db/types.ts';

export type Account = { readonly id: string; readonly name: string; readonly email: string; readonly jiraAccount: string | null; readonly kind: PersonKind };

export const readPeople = (db: Database): Promise<readonly Account[]> =>
  db.selectFrom('person').select(['person.id', 'person.name', 'person.email', 'person.jira_account_id as jiraAccount', 'person.kind']).orderBy('person.kind').orderBy('person.name').execute();
