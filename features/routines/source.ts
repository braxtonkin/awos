import type { RoutineRun, Source } from '../../shared/routine-source.ts';

export type Sources = ReadonlyMap<string, Source>;

export type Claimed = RoutineRun & {
  readonly claim: string;
  readonly version: number;
  readonly workflow: string;
  readonly needsRepository: boolean;
  readonly repository: string | null;
  readonly sourceKind: string;
};

export function sourcesByKind(list: readonly Source[]): Sources {
  const sources = new Map<string, Source>();
  for (const source of list) {
    if (sources.has(source.kind)) throw new Error(`two sources have the kind ${source.kind}, and a routine names its source by kind`);
    sources.set(source.kind, source);
  }
  return sources;
}
