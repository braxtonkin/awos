import type { MutantName, ProfileName } from './simulate.ts';

export type FailedSeed = { readonly profile: ProfileName; readonly seed: number; readonly steps: number; readonly mutant?: MutantName; readonly fingerprint: string };

export const failedSeeds: readonly FailedSeed[] = [];
