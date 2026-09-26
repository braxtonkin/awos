import type { Scenario } from '../../tools/verify/check.ts';
import type { Lane } from '../../tools/verify/dashboard.ts';
import type { Screen } from '../../tools/verify/screens/screens.ts';
import { loginLanes, loginNeverShown } from './live.ts';
import { lanes as peopleLanes, seededNames } from './lanes.ts';

export const scenarios: readonly Scenario[] = [loginNeverShown];

export const screens: readonly Screen[] = [{ name: 'people', group: 'settings', path: '/people', seed: 'running', steps: [], height: 900, names: seededNames }];

export const lanes: readonly Lane[] = [...peopleLanes, ...loginLanes];
