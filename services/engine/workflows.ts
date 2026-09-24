import { workflow as codeChange } from '../../features/code-change/workflow.ts';
import { workflowsByName } from '../../features/tasks/start.ts';

export const workflows = workflowsByName([codeChange]);
