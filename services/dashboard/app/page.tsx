import { NeedsYouPage } from '../../../features/overview/needs-you.tsx';
import { readNeedsYou } from '../../../features/overview/read.ts';
import { database } from '../database.ts';
import { acting } from '../identity.ts';

export default async function Page() {
  const now = new Date();
  const person = await acting();
  const needs = await readNeedsYou(database(), person, now);
  return <NeedsYouPage key={person ?? 'nobody'} initial={needs} zone={Intl.DateTimeFormat().resolvedOptions().timeZone} now={now.toISOString()} />;
}
