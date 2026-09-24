import { defineModel } from '../../tools/verify/models.ts';

const floors = { Checkers: 3, MaxLogins: 2, MaxRefreshes: 3, MaxChecks: 4, MaxCrashes: 1, MaxJobs: 1 };

export const checksModel = defineModel({
  name: 'checks',
  module: new URL('Checks.tla', import.meta.url),
  configs: { pr: { file: 'Checks.cfg', floors }, nightly: { file: 'Checks.cfg', floors } },
  guards: ['ClaimIsExclusive', 'RefreshIsClaimedOnce', 'WriteBackNeedsOpenedLogin', 'JobCopyIsAccessOnly'],
  properties: {
    OneLiveCheck: 'INVARIANTS',
    NoRefreshTokenReused: 'INVARIANTS',
    StoredLoginIsNewest: 'PROPERTIES',
    JobsNeverRefresh: 'INVARIANTS',
  },
  mutants: [
    { guard: 'ClaimIsExclusive', without: 'a checker can claim while another check is live', property: 'OneLiveCheck' },
    { guard: 'RefreshIsClaimedOnce', without: 'a checker can claim a login whose refresh an earlier check already claimed', property: 'NoRefreshTokenReused' },
    { guard: 'WriteBackNeedsOpenedLogin', without: 'a checker writes its fresh pair back over a login it did not open', property: 'StoredLoginIsNewest' },
    { guard: 'JobCopyIsAccessOnly', without: "a Job's copy keeps the refresh token", property: 'JobsNeverRefresh' },
  ],
});
