import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { z } from 'zod';
import { docker } from './docker.ts';

const run = promisify(execFile);

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export const registry = { name: 'autoworker-registry', image: 'registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e', host: '127.0.0.1:5001' } as const;

const node = 'autoworker-control-plane';

const manifestTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const digestReference = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

export async function sh(command: string): Promise<string> {
  try {
    const { stdout } = await run('sh', ['-c', command], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(`${command.slice(0, 80)} failed: ${stderr.trim().split('\n').slice(-4).join(' | ') || (error instanceof Error ? error.message : String(error))}`, { cause: error });
  }
}

async function digestOf(repository: string, tag: string): Promise<string> {
  const answer = await fetch(`http://${registry.name}:5000/v2/${repository}/manifests/${tag}`, { method: 'HEAD', headers: { accept: manifestTypes } });
  const digest = answer.headers.get('docker-content-digest');
  if (!answer.ok || digest === null) throw new Error(`the registry answered ${String(answer.status)} for ${repository}:${tag}`);
  return digest;
}

export async function pushByDigest(tag: string): Promise<string> {
  await sh(`docker push -q ${tag}`);
  const [repository = '', name = ''] = tag.slice(registry.host.length + 1).split(':');
  const reference = `${registry.host}/${repository}@${await digestOf(repository, name)}`;
  if (!digestReference.test(reference)) throw new Error(`${reference} is not an image named by digest`);
  return reference;
}

export async function ensureRegistry(): Promise<string> {
  const found = await docker('GET', `/containers/${registry.name}/json`);
  if (found.status === 404) await sh(`docker run -d --restart=always --name ${registry.name} --network kind -p ${registry.host}:5000 ${registry.image}`);
  await sh(`docker exec ${node} sh -c 'mkdir -p /etc/containerd/certs.d/${registry.host} && printf "[host.\\"http://${registry.name}:5000\\"]\\n" > /etc/containerd/certs.d/${registry.host}/hosts.toml'`);
  return found.status === 404 ? `started ${registry.image}` : `reused ${registry.name}`;
}

export async function buildAttemptImage(tag: string): Promise<string> {
  await sh(`tar -c --exclude=node_modules package.json package-lock.json shared features services/job | docker build -q -f services/job/Dockerfile -t ${tag} -`);
  return pushByDigest(tag);
}

const container = z.object({ NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }) });

export async function kindAddress(): Promise<string> {
  const found = container.safeParse((await docker('GET', `/containers/${hostname()}/json`)).body).data?.NetworkSettings.Networks['kind']?.IPAddress;
  if (found === undefined || found === '') throw new Error('this container has no address on the kind network');
  return found;
}

export const kubernetes = (): CoreV1Api => {
  const config = new KubeConfig();
  config.loadFromDefault();
  return config.makeApiClient(CoreV1Api);
};

export async function jobNamespace(core: CoreV1Api, namespace: string, serviceAccount: string): Promise<void> {
  await core.createNamespace({ body: { metadata: { name: namespace } } });
  await core.createNamespacedServiceAccount({ namespace, body: { metadata: { name: serviceAccount }, automountServiceAccountToken: false } });
}

export type GitServer = { readonly base: string; readonly folder: string; readonly stop: () => Promise<void> };

export async function gitServer(address: string): Promise<GitServer> {
  const folder = await mkdtemp(join(tmpdir(), 'git-server-'));
  const port = 9418;
  const child = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${folder}`, `--listen=${address}`, `--port=${String(port)}`, folder], { stdio: 'ignore' });
  await wait(500);
  return {
    base: `git://${address}:${String(port)}/`,
    folder,
    stop: async () => {
      child.kill('SIGTERM');
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export async function seedRepository(server: GitServer, name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'git-work-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), content);
  }
  const bare = join(server.folder, `${name}.git`);
  await mkdir(join(bare, '..'), { recursive: true });
  await sh(
    [
      `git -C ${work} init -q -b main`,
      `git -C ${work} add -A`,
      `git -C ${work} -c user.name=Seed -c user.email=seed@example.com commit -q -m seed`,
      `git clone -q --bare ${work} ${bare}`,
      `git -C ${bare} config uploadpack.allowAnySHA1InWant true`,
      `git -C ${bare} config daemon.receivepack true`,
    ].join(' && '),
  );
  const head = await sh(`git -C ${bare} rev-parse main`);
  await rm(work, { recursive: true, force: true });
  return head;
}
