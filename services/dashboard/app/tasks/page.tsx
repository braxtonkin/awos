import { readTaskList } from '../../../../features/overview/read.ts';
import { TaskListPage } from '../../../../features/overview/task-list.tsx';
import { database } from '../../database.ts';

export default async function Page({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>> }) {
  const now = new Date();
  const list = await readTaskList(database(), await searchParams, now);
  return <TaskListPage list={list} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} now={now.toISOString()} />;
}
