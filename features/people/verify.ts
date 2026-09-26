import type { Scenario } from '../../tools/verify/check.ts';
import type { Screen } from '../../tools/verify/screens/screens.ts';
import { lanes, seededNames } from './lanes.ts';

export const scenarios: readonly Scenario[] = [];

export const screens: readonly Screen[] = [{ name: 'people', group: 'settings', path: '/people', seed: 'running', steps: [], height: 900, names: seededNames }];

export { lanes };
