import { TaskNotFound } from '../../../../../features/task-page/not-found.tsx';
import { openTask } from './open.ts';

export default function NotFound() {
  return <TaskNotFound open={openTask} />;
}
