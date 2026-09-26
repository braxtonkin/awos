'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { keyAsStored } from '../../../../../features/task-page/read.ts';
import { database } from '../../../database.ts';

const typed = z.object({ key: z.string().trim().min(1).max(100) });

export async function openTask(form: FormData): Promise<void> {
  const { key } = typed.parse({ key: form.get('key') });
  redirect(`/tasks/${encodeURIComponent(await keyAsStored(database(), key))}`);
}
