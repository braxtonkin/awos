import { notFound } from 'next/navigation';
import { readRepository } from '../../../../../features/repository-settings/read.ts';
import { SettingsPage } from '../../../../../features/repository-settings/view.tsx';
import { database } from '../../../database.ts';
import { saveRepositorySettings } from '../actions.ts';

type PageProps = { readonly params: Promise<{ readonly id: string }>; readonly searchParams: Promise<{ readonly saved?: string | string[] }> };

export default async function Page({ params, searchParams }: PageProps) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const editing = await readRepository(database(), id);
  if (editing.settings === undefined) notFound();
  return <SettingsPage editing={editing} action={saveRepositorySettings} saved={typeof saved === 'string' ? saved : undefined} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
}
