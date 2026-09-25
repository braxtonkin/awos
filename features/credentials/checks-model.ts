import { defineModel } from '../../tools/verify/models.ts';

const floors = { Checkers: 3, MaxLogins: 2, MaxRefreshes: 3, MaxChecks: 4, MaxCrashes: 1, MaxJobs: 1 };

export const checksModel = defineModel({
  name: 'checks',
  module: new URL('Checks.tla', import.meta.url),
  configs: { pr: { file: 'Checks.cfg', floors }, nightly: { file: 'Checks.cfg', floors } },
  guards: ['ClaimIsExclusive', 'RefreshIsClaimedOnce', 'WriteBackNeedsOpenedLogin', 'JobCopyIsAccessOnly', 'DeathKeepsRefreshClaim', 'ClaimNeedsDueLogin', 'FinishNeedsClaim'],
  properties: {
    OneLiveCheck: 'INVARIANTS',
    NoRefreshTokenReused: 'INVARIANTS',
    JobsNeverRefresh: 'INVARIANTS',
    OneCheckPerLogin: 'INVARIANTS',
    StoredLoginIsNewest: 'PROPERTIES',
    FinishedCheckIsFinal: 'PROPERTIES',
  },
  mutants: [
    { guard: 'ClaimIsExclusive', without: 'a checker can claim while another check is live', property: 'OneLiveCheck' },
    { guard: 'RefreshIsClaimedOnce', without: 'a checker can claim a login whose refresh an earlier check already claimed', property: 'NoRefreshTokenReused' },
    { guard: 'WriteBackNeedsOpenedLogin', without: 'a checker writes its fresh pair back over a login it did not open', property: 'StoredLoginIsNewest' },
    { guard: 'JobCopyIsAccessOnly', without: "a Job's copy keeps the refresh token", property: 'JobsNeverRefresh' },
    { guard: 'DeathKeepsRefreshClaim', without: 'a check that presented the refresh token and then died releases its refresh claim', property: 'NoRefreshTokenReused' },
    { guard: 'ClaimNeedsDueLogin', without: 'a checker claims a login it read before another check finished it or someone replaced it', property: 'OneCheckPerLogin' },
    { guard: 'FinishNeedsClaim', without: 'a checker finishes a check after its claim was reaped', property: 'FinishedCheckIsFinal' },
  ],
});
