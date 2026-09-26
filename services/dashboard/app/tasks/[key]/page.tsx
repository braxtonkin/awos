import { notFound } from 'next/navigation';
import { readTask } from '../../../../../features/task-page/read.ts';
import { TaskPage } from '../../../../../features/task-page/view.tsx';
import { database } from '../../../database.ts';
import { retryTask, reviewTask, steerTask, stopTask } from './actions.ts';

export default async function Page({ params }: { readonly params: Promise<{ readonly key: string }> }) {
  const { key } = await params;
  const page = await readTask(database(), key);
  if (page === undefined) notFound();
  return <TaskPage page={page} actions={{ stop: stopTask, steer: steerTask, retry: retryTask, review: reviewTask }} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
}
