import { randomUUID } from 'node:crypto';
import { RoutineEditor } from '../../../../../features/routine-editor/editor.tsx';
import { newRoutine, readChoices } from '../../../../../features/routine-editor/read.ts';
import { database } from '../../../database.ts';
import { pressRoutine, saveRoutine } from '../actions.ts';

export default async function Page() {
  const choices = await readChoices(database());
  return (
    <RoutineEditor
      form={newRoutine(choices)}
      choices={choices}
      save={saveRoutine}
      press={pressRoutine}
      request={randomUUID()}
      justSaved={undefined}
      zone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      now={new Date().toISOString()}
    />
  );
}
