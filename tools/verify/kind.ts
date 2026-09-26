import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CoreV1Api, KubeConfig, loadYaml } from '@kubernetes/client-node';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from './check.ts';
import { docker } from './docker.ts';

const specFile = fileURLToPath(new URL('kind.yaml', import.meta.url));
const dockerfile = fileURLToPath(new URL('Dockerfile', import.meta.url));
const kubeconfigFile = join(homedir(), '.kube', 'config');
const network = 'kind';
const namespace = 'default';
const readyWait = 120_000;
const raceWait = 15_000;
const podWait = 120_000;
const forwarded = ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
const fetchAndPrint = 'fetch(process.argv[1]).then(response => response.text()).then(text => console.log(text))';

const Spec = z
  .object({
    kind: z.literal('Cluster'),
    apiVersion: z.literal('kind.x-k8s.io/v1alpha4'),
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    nodes: z.tuple([
      z.object({
        role: z.literal('control-plane'),
        image: z.string().regex(/^kindest\/node:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, { error: 'must name kindest/node by its tag and sha256 digest' }),
      }),
    ]),
  })
  .transform(({ name, nodes: [node] }) => ({ name, digest: node.image.slice(node.image.indexOf('@') + 1) }));

type Spec = z.infer<typeof Spec>;

const Container = z.object({
  Image: z.string(),
  State: z.object({ Running: z.boolean() }),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }),
});

const Image = z.object({ RepoDigests: z.array(z.string()) });

type Node = { readonly name: string; readonly running: boolean; readonly digests: readonly string[] };

type Link = { readonly api: CoreV1Api; readonly address: string };

type Cluster = { readonly link: Link; readonly detail: string };

const seconds = (started: number): string => ((performance.now() - started) / 1000).toFixed(1);

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim().replace(/\s*\n\s*/g, ' | ');

const issues = (error: z.ZodError): string => error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ');

async function attempt(name: string, work: () => Promise<string>): Promise<Check> {
  try {
    return pass(name, await work());
  } catch (error) {
    return fail(name, reason(error));
  }
}

function kindCli(...args: readonly string[]): string {
  const env = Object.fromEntries(
    forwarded.flatMap(key => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
  const result = spawnSync('kind', args, { encoding: 'utf8', env: { ...env, HOME: homedir() } });
  if (result.status === 0) return result.stdout;
  const output = result.error?.message ?? result.stderr.trim().split('\n').slice(-3).join(' | ');
  throw new Error(`kind ${args.join(' ')} failed: ${output}`);
}

async function inspect<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const reply = await docker('GET', path);
  if (reply.status === 404) return undefined;
  if (reply.status !== 200) throw new Error(`the Docker API answered ${String(reply.status)} to ${path}`);
  const parsed = schema.safeParse(reply.body);
  if (!parsed.success) throw new Error(`the Docker API answered ${path} with ${issues(parsed.error)}`);
  return parsed.data;
}

async function readSpec(): Promise<Spec> {
  const parsed = Spec.safeParse(loadYaml<unknown>(await readFile(specFile, 'utf8')));
  if (!parsed.success) throw new Error(`tools/verify/kind.yaml: ${issues(parsed.error)}`);
  return parsed.data;
}

async function baseImage(): Promise<string> {
  const image = /^ARG NODE_IMAGE=(node:[^\s@]+@sha256:[0-9a-f]{64})$/m.exec(await readFile(dockerfile, 'utf8'))?.[1];
  if (image === undefined) throw new Error('tools/verify/Dockerfile sets no NODE_IMAGE pinned by digest');
  return image;
}

async function findNode(spec: Spec): Promise<Node | undefined> {
  const [name] = kindCli('get', 'nodes', '--name', spec.name).split('\n').filter(line => line !== '');
  if (name === undefined) return undefined;
  const container = await inspect(`/containers/${name}/json`, Container);
  if (container === undefined) return undefined;
  const image = await inspect(`/images/${container.Image}/json`, Image);
  return { name, running: container.State.Running, digests: image?.RepoDigests ?? [] };
}

const pinned = (node: Node, spec: Spec): string | undefined => node.digests.find(digest => digest.endsWith(`@${spec.digest}`));

async function joinNetwork(): Promise<string> {
  const self = hostname();
  const before = await inspect(`/containers/${self}/json`, Container);
  if (before === undefined) throw new Error(`the Docker API knows no container ${self}, so this process runs outside one`);
  if (before.NetworkSettings.Networks[network] === undefined) {
    const joined = await docker('POST', `/networks/${network}/connect`, { Container: self });
    if (joined.status !== 200) throw new Error(`joining the ${network} network answered ${String(joined.status)}`);
  }
  const address = (await inspect(`/containers/${self}/json`, Container))?.NetworkSettings.Networks[network]?.IPAddress;
  if (address === undefined || address === '') throw new Error(`this container has no address on the ${network} network`);
  return address;
}

function client(kubeconfig: string): CoreV1Api {
  const config = new KubeConfig();
  try {
    config.loadFromString(kubeconfig);
  } catch {
    throw new Error('kind get kubeconfig printed a kubeconfig that does not parse');
  }
  return config.makeApiClient(CoreV1Api);
}

async function describeNode(api: CoreV1Api): Promise<string> {
  const { items } = await api.listNode();
  const [node, ...others] = items;
  const ready = node?.status?.conditions?.find(condition => condition.type === 'Ready')?.status;
  if (node === undefined || others.length > 0 || ready !== 'True') throw new Error(`listed ${String(items.length)} nodes, the first Ready ${ready ?? 'unknown'}`);
  return `${node.metadata?.name ?? 'unnamed'} Ready, kubelet ${node.status?.nodeInfo?.kubeletVersion ?? 'unknown'}`;
}

async function readyKubeconfig(spec: Spec): Promise<string> {
  const deadline = Date.now() + readyWait;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const kubeconfig = kindCli('get', 'kubeconfig', '--internal', '--name', spec.name);
      await describeNode(client(kubeconfig));
      return kubeconfig;
    } catch (error) {
      last = reason(error);
    }
    await sleep(1000);
  }
  throw new Error(`no Ready node after ${String(readyWait / 1000)} s (${last}). Run kind down, then kind up, once no other lane uses the cluster`);
}

async function link(spec: Spec): Promise<Link> {
  const address = await joinNetwork();
  const kubeconfig = await readyKubeconfig(spec);
  await mkdir(dirname(kubeconfigFile), { recursive: true });
  await writeFile(kubeconfigFile, kubeconfig, { mode: 0o600 });
  return { api: client(kubeconfig), address };
}

async function anotherCreated(spec: Spec): Promise<boolean> {
  const deadline = Date.now() + raceWait;
  while (Date.now() < deadline) {
    const node = await findNode(spec);
    if (node?.running === true && pinned(node, spec) !== undefined) return true;
    await sleep(500);
  }
  return false;
}

async function create(spec: Spec): Promise<boolean> {
  try {
    kindCli('create', 'cluster', '--config', specFile, '--retain', '--wait', '2m');
    return true;
  } catch (error) {
    if (await anotherCreated(spec)) return false;
    throw error;
  }
}

async function converge(spec: Spec): Promise<Cluster> {
  const started = performance.now();
  const node = await findNode(spec);
  if (node?.running === true) {
    if (pinned(node, spec) === undefined) {
      throw new Error(`its node runs ${node.digests.join(', ') || 'an unknown image'}, and kind.yaml pins ${spec.digest}. Run kind down, then kind up, once no other lane uses the cluster`);
    }
    return { link: await link(spec), detail: `reused in ${seconds(started)} s` };
  }
  if (node !== undefined) kindCli('delete', 'cluster', '--name', spec.name);
  const created = await create(spec);
  const why = node === undefined ? 'none existed' : 'its node was stopped';
  return { link: await link(spec), detail: created ? `created in ${seconds(started)} s because ${why}` : `joined the one another kind up created, in ${seconds(started)} s` };
}

async function waitForPod(api: CoreV1Api, name: string): Promise<string> {
  const deadline = Date.now() + podWait;
  let last = 'unscheduled';
  while (Date.now() < deadline) {
    const { status } = await api.readNamespacedPod({ name, namespace });
    const phase = status?.phase ?? 'unknown';
    if (phase === 'Succeeded' || phase === 'Failed') return phase;
    last = status?.containerStatuses?.[0]?.state?.waiting?.reason ?? phase;
    await sleep(500);
  }
  throw new Error(`the pod did not finish within ${String(podWait / 1000)} s, last ${last}`);
}

async function ping(link: Link, image: string): Promise<string> {
  const server = createServer((request, response) => {
    const pinged = request.url === '/ping';
    response.writeHead(pinged ? 200 : 404).end(pinged ? 'pong' : '');
  });
  server.listen(0, link.address);
  await once(server, 'listening');
  try {
    const bound = server.address();
    if (bound === null || typeof bound === 'string') throw new Error('the listener has no port');
    const name = `autoworker-ping-${randomUUID().slice(0, 8)}`;
    const url = `http://${link.address}:${String(bound.port)}/ping`;
    await link.api.createNamespacedPod({
      namespace,
      body: {
        metadata: { name },
        spec: {
          restartPolicy: 'Never',
          activeDeadlineSeconds: podWait / 1000,
          terminationGracePeriodSeconds: 0,
          containers: [{ name: 'ping', image, command: ['node', '-e', fetchAndPrint, url] }],
        },
      },
    });
    try {
      const phase = await waitForPod(link.api, name);
      const printed = (await link.api.readNamespacedPodLog({ name, namespace })).trim();
      if (printed !== 'pong') throw new Error(`the pod ended ${phase} and printed ${JSON.stringify(printed.slice(0, 160))}`);
      return `pong on port ${String(bound.port)} from ${image}`;
    } finally {
      await link.api.deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 });
    }
  } finally {
    server.close();
  }
}

async function up(): Promise<readonly Check[]> {
  const spec = await readSpec();
  const image = await baseImage();
  const ready = `cluster ${spec.name} ready`;
  let cluster: Cluster;
  try {
    cluster = await converge(spec);
  } catch (error) {
    return [fail(ready, reason(error))];
  }
  const { link } = cluster;
  const checks = [pass(ready, cluster.detail), await attempt('api reached', () => describeNode(link.api))];
  if (checks.every(check => check.passed)) checks.push(await attempt(`pod reached the container at ${link.address}`, () => ping(link, image)));
  return checks;
}

async function status(): Promise<readonly Check[]> {
  const spec = await readSpec();
  const address = (await inspect(`/containers/${hostname()}/json`, Container))?.NetworkSettings.Networks[network]?.IPAddress;
  const membership = address === undefined ? `this container is not on the ${network} network` : `this container is on the ${network} network at ${address}`;
  const node = await findNode(spec);
  if (node === undefined) return [fail(`cluster ${spec.name} has a node`, `none exists, and ${membership}`)];
  const digest = pinned(node, spec);
  return [
    node.running ? pass(`node ${node.name} running`, membership) : fail(`node ${node.name} running`, `it is stopped, and ${membership}`),
    digest === undefined ? fail(`node image ${node.digests.join(', ') || 'unknown'}`, `kind.yaml pins ${spec.digest}`) : pass(`node image ${digest}`, 'as kind.yaml pins'),
  ];
}

async function down(): Promise<readonly Check[]> {
  const spec = await readSpec();
  return [
    await attempt(`cluster ${spec.name} deleted`, async () => {
      kindCli('delete', 'cluster', '--name', spec.name);
      if ((await findNode(spec)) !== undefined) throw new Error('its node still exists');
      return '';
    }),
  ];
}

const Command = z.enum(['up', 'status', 'down']);

const commands: Record<z.infer<typeof Command>, () => Promise<readonly Check[]>> = { up, status, down };

export const kind: Scenario = {
  name: 'kind',
  summary: 'up creates or reuses the cluster in tools/verify/kind.yaml and proves its network paths, status reports it, down deletes it',
  run: async ([command]) => {
    const parsed = Command.safeParse(command);
    return parsed.success ? await commands[parsed.data]() : [fail('kind runs a known command', `name one of ${Command.options.join(', ')}`)];
  },
};
