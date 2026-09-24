import type { MutantName, ProfileName } from './simulate.ts';

export type FailedSeed = { readonly profile: ProfileName; readonly seed: number; readonly steps: number; readonly mutant?: MutantName; readonly fingerprint: string };

export const failedSeeds: readonly FailedSeed[] = [{ profile: 'verdicts', seed: 7, steps: 300, fingerprint: '6297405cf4cebcdb' }];
