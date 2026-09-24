import type { Database } from '../../shared/db/client.ts';
import { jiraLogin, type OpenedJiraLogin } from '../../shared/jira-login.ts';
import type { SealingKey } from './seal.ts';
import { open } from './store.ts';

export async function openJiraLogin(db: Database, key: SealingKey | undefined, person: string): Promise<OpenedJiraLogin> {
  const found = await db.selectFrom('person').select('name').where('id', '=', person).executeTakeFirst();
  const who = `person ${person}${found === undefined ? '' : ` (${found.name})`}`;
  if (key === undefined) return { refused: `The engine has no CREDENTIAL_KEY, so it cannot open the Jira login of ${who}.` };
  const opened = await open(db, key, { connector: 'jira', owner: person });
  if (!('secret' in opened)) return { refused: `The Jira login of ${who} could not be opened: ${opened.reason}` };
  const login = jiraLogin.safeParse(opened.secret);
  return login.success ? { login: login.data, who } : { refused: `The stored Jira login of ${who} is not email:token. Store it again.` };
}
