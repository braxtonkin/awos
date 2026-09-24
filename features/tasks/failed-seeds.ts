import type { MutantName, ProfileName } from './simulate.ts';

export type FailedSeed = { readonly profile: ProfileName; readonly seed: number; readonly steps: number; readonly mutant?: MutantName; readonly fingerprint: string };

export const failedSeeds: readonly FailedSeed[] = [
  { profile: 'verdicts', seed: 3, steps: 300, fingerprint: '14ddca7b05ba53d6' },
  { profile: 'verdicts', seed: 10, steps: 300, fingerprint: '14ddca7b05ba53d6' },
];
