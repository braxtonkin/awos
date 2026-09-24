import type { Json, RunReason } from './db/types.ts';

export type WorkItem = { readonly key: string; readonly title: string; readonly assignee: string | null };

export type RoutineRun = {
  readonly run: string;
  readonly routine: string;
  readonly name: string;
  readonly reason: RunReason;
  readonly occurrence: Date;
  readonly runAs: string;
  readonly source: Json;
};

export type Source = { readonly kind: string; readonly find: (run: RoutineRun) => Promise<readonly WorkItem[]> };
