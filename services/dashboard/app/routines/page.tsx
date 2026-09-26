import { RoutineList } from '../../../../features/routine-editor/list.tsx';
import { listRoutines } from '../../../../features/routine-editor/read.ts';
import { database } from '../../database.ts';
import { pressRoutine } from './actions.ts';

export default async function Page() {
  const now = new Date();
  const routines = await listRoutines(database(), now);
  return <RoutineList routines={routines} press={pressRoutine} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} now={now.toISOString()} />;
}
