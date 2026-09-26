import { BoardPage } from '../../../../features/overview/board.tsx';
import { readBoard } from '../../../../features/overview/read.ts';
import { database } from '../../database.ts';

export default async function Page() {
  const board = await readBoard(database(), new Date());
  return <BoardPage board={board} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
}
