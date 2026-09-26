import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { RoutineEditor } from '../../../../../features/routine-editor/editor.tsx';
import { readChoices, readRoutine } from '../../../../../features/routine-editor/read.ts';
import { database } from '../../../database.ts';
import { pressRoutine, saveRoutine } from '../actions.ts';

type PageProps = { readonly params: Promise<{ readonly id: string }>; readonly searchParams: Promise<{ readonly saved?: string | string[] }> };

export default async function Page({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { saved } = await searchParams;
  const db = database();
  const form = await readRoutine(db, id);
  if (form === undefined) notFound();
  const justSaved = typeof saved === 'string' && form.saved !== null && saved === String(form.saved.version) ? form.saved.version : undefined;
  return (
    <RoutineEditor
      form={form}
      choices={await readChoices(db)}
      save={saveRoutine}
      press={pressRoutine}
      request={randomUUID()}
      justSaved={justSaved}
      zone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      now={new Date().toISOString()}
    />
  );
}
