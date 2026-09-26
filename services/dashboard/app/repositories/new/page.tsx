import { readProviders } from '../../../../../features/repository-settings/read.ts';
import { SettingsPage } from '../../../../../features/repository-settings/view.tsx';
import { database } from '../../../database.ts';
import { saveRepositorySettings } from '../actions.ts';

export default async function Page() {
  const providers = await readProviders(database());
  return <SettingsPage editing={{ settings: undefined, providers }} action={saveRepositorySettings} saved={undefined} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
}
