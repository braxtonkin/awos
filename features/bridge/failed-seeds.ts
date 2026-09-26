export type FailedSeed = { readonly seed: number; readonly steps: number; readonly fingerprint: string };

export const failedSeeds: readonly FailedSeed[] = [196, 441, 469, 561, 589, 680, 739, 786, 861, 877, 890].map(seed => ({ seed, steps: 300, fingerprint: '6e42df805bc6573a' }));
