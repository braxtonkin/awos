import { z } from 'zod';
import type { Source } from '../../shared/routine-source.ts';
import { jiraAs, signedInAs, type JiraAccess } from './client.ts';

const jiraSearchSettings = z.strictObject({
  kind: z.literal('jira-search'),
  jql: z.string().trim().min(1, { error: 'must hold the JQL query the routine searches with' }),
  pageSize: z.int().min(1).max(100).default(50),
});

export const jiraSearch = (access: JiraAccess): Source => ({
  kind: 'jira-search',
  find: async run => {
    const settings = jiraSearchSettings.safeParse(run.source);
    if (!settings.success) throw new Error(`The routine's jira-search source is not usable. ${z.prettifyError(settings.error)}`);
    const jira = await signedInAs(access, run.runAs, AbortSignal.timeout(access.timeoutMs));
    const found = await jira.search(settings.data.jql, settings.data.pageSize);
    return found.map(ticket => ({ key: ticket.key, title: ticket.summary, assignee: ticket.assignee }));
  },
});

export const currentAssignee =
  (access: JiraAccess) =>
  async (ticket: string, person: string): Promise<string | null> =>
    (await (await jiraAs(access, person, AbortSignal.timeout(access.timeoutMs))).ticket(ticket)).assignee;
