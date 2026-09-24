import { workflow as codeChange } from '../../features/code-change/workflow.ts';
import { workflowsByName } from '../../features/tasks/start.ts';
import type { OwedKinds } from '../../shared/actions.ts';

const given = [codeChange] as const;

export type ActionKind = OwedKinds<(typeof given)[number]>;

export const workflows = workflowsByName(given);
