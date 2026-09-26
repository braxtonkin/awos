import { checksOf } from '../../tools/verify/check.ts';
import { kindAddress } from '../../tools/verify/cluster.ts';
import type { Agent } from '../../tools/verify/dashboard.ts';
import { kind } from '../../tools/verify/kind.ts';
import { accessCopy, fakeCodexLogin, standInImage } from './autoworker.ts';
import { startLocalWorld } from './local-world.ts';
import { sandboxWorld, type World, type WorldName } from './world.ts';

export async function openWorld(name: WorldName, repository: string, agent: Agent): Promise<World> {
  const broken = checksOf(await kind.run(['up'])).find(check => !check.passed);
  if (broken !== undefined) throw new Error(`kind did not come up: ${broken.name}, ${broken.detail}`);
  switch (name) {
    case 'sandbox':
      return sandboxWorld(repository, accessCopy);
    case 'local':
      return localWorld(repository, agent);
  }
}

async function localWorld(repository: string, agent: Agent): Promise<World> {
  const local = await startLocalWorld(await kindAddress(), repository);
  return {
    name: 'local',
    jira: local.jira,
    github: local.github,
    engine: {
      settings: { ...local.engine.settings },
      secrets: { github: local.engine.secrets.GITHUB_TOKEN, jiraLogin: local.engine.secrets.AUTOWORKER_JIRA_LOGIN },
      codexLogin: agent === 'real' ? accessCopy : () => Promise.resolve(fakeCodexLogin()),
      image: agent === 'real' ? attemptImage => Promise.resolve(attemptImage) : standInImage,
      trustLogins: true,
      agent,
    },
    stop: local.stop,
  };
}
