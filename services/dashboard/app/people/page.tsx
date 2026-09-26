import { openedLogin, readLogins } from '../../../../features/people/logins.ts';
import { readPeople } from '../../../../features/people/read.ts';
import { PeoplePage } from '../../../../features/people/view.tsx';
import { credentialKey } from '../../credential-key.ts';
import { database } from '../../database.ts';
import { acting } from '../../identity.ts';
import { replaceLogin } from './actions.ts';

export default async function Page({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>> }) {
  const db = database();
  const [people, logins, person, asked] = await Promise.all([readPeople(db), readLogins(db), acting(), searchParams]);
  const keyed = credentialKey();
  return (
    <PeoplePage
      people={people}
      logins={logins}
      acting={person}
      now={new Date().toISOString()}
      zone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      replacing={'off' in keyed ? { on: false, why: keyed.off } : { on: true, action: replaceLogin }}
      opened={openedLogin(asked, person)}
    />
  );
}
