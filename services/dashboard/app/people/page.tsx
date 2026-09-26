import { readPeople } from '../../../../features/people/read.ts';
import { PeoplePage } from '../../../../features/people/view.tsx';
import { database } from '../../database.ts';
import { acting } from '../../identity.ts';

export default async function Page() {
  return <PeoplePage people={await readPeople(database())} acting={await acting()} />;
}
