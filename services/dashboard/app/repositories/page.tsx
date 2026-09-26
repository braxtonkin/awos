import { readRepositories } from '../../../../features/repository-settings/read.ts';
import { RepositoryList } from '../../../../features/repository-settings/view.tsx';
import { database } from '../../database.ts';

export default async function Page() {
  return <RepositoryList repositories={await readRepositories(database())} />;
}
