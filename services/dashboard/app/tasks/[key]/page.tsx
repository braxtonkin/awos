import { notFound } from 'next/navigation';
import { readTask } from '../../../../../features/task-page/read.ts';
import { tabOf } from '../../../../../features/task-page/tab.ts';
import { TaskPage } from '../../../../../features/task-page/view.tsx';
import { database } from '../../../database.ts';
import { retryTask, reviewTask, steerTask, stopTask } from './actions.ts';

type PageProps = { readonly params: Promise<{ readonly key: string }>; readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>> };

export default async function Page({ params, searchParams }: PageProps) {
  const { key } = await params;
  const { tab } = await searchParams;
  const page = await readTask(database(), key);
  if (page === undefined) notFound();
  return <TaskPage page={page} actions={{ stop: stopTask, steer: steerTask, retry: retryTask, review: reviewTask }} tab={tabOf(tab)} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
}
