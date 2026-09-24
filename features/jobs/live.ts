import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApiException, KubeConfig, RbacAuthorizationV1Api, type V1Job } from '@kubernetes/client-node';
import { z } from 'zod';
import { accessOnly, type AccessOnlyLogin } from '../../shared/codex-login.ts';
import { connect, refusal, type Database } from '../../shared/db/client.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { docker } from '../../tools/verify/docker.ts';
import { kind } from '../../tools/verify/kind.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { connectCluster, labels, type Cluster } from '../../shared/cluster.ts';
import { containerName, imageFor, jobName, jobState, launch, manifests, type JobState } from './launch.ts';
import { imageReference, type ImageReference, type JobSettings } from './settings.ts';
import { sweepOnce } from './sweep.ts';
import { attemptBranch } from './workspace.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const serviceAccount = 'autoworker-job';
const registry = { name: 'autoworker-registry', image: 'registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e', host: '127.0.0.1:5001' } as const;
const node = 'autoworker-control-plane';
const attemptImageTag = `${registry.host}/autoworker-job:verify`;
const pinnedCommit = '0d9dece83482cfa8bc8ff498bb56188f1eb69167';
const thisRepository = 'https://github.com/braxtonkdev/autoworker-oss.git';
const codexPin = 'codex-cli 0.156.0';
const readyBudgetMs = 30_000;
const sweepBudgetMs = 5_000;
const doneWaitMs = 180_000;
const bridge = 'node-bridge /app/services/job/main.ts';
const manifestTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

const reason = (error: unknown): string => (error instanceof ApiException ? `${String(error.code)} ${JSON.stringify(error.body).slice(0, 300)}` : error instanceof Error ? error.message : String(error));

async function sh(command: string): Promise<string> {
  try {
    const { stdout } = await run('sh', ['-c', command], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(`${command.slice(0, 80)} failed: ${stderr.trim().split('\n').slice(-4).join(' | ') || reason(error)}`, { cause: error });
  }
}

async function digestOf(repository: string, tag: string): Promise<string> {
  const answer = await fetch(`http://${registry.name}:5000/v2/${repository}/manifests/${tag}`, { method: 'HEAD', headers: { accept: manifestTypes } });
  const digest = answer.headers.get('docker-content-digest');
  if (!answer.ok || digest === null) throw new Error(`the registry answered ${String(answer.status)} for ${repository}:${tag}`);
  return digest;
}

async function pushed(tag: string): Promise<ImageReference> {
  await sh(`docker push -q ${tag}`);
  const [host, rest] = [registry.host, tag.slice(registry.host.length + 1)];
  const [repository = '', name = ''] = rest.split(':');
  return imageReference.parse(`${host}/${repository}@${await digestOf(repository, name)}`);
}

async function ensureRegistry(): Promise<string> {
  const found = await docker('GET', `/containers/${registry.name}/json`);
  if (found.status === 404) await sh(`docker run -d --restart=always --name ${registry.name} --network kind -p ${registry.host}:5000 ${registry.image}`);
  await sh(`docker exec ${node} sh -c 'mkdir -p /etc/containerd/certs.d/${registry.host} && printf "[host.\\"http://${registry.name}:5000\\"]\\n" > /etc/containerd/certs.d/${registry.host}/hosts.toml'`);
  return found.status === 404 ? `started ${registry.image}` : `reused ${registry.name}`;
}

const buildContext = 'tar -c --exclude=node_modules package.json package-lock.json shared features services/job';

async function buildAttemptImage(): Promise<{ readonly image: ImageReference; readonly ms: number }> {
  const started = performance.now();
  await sh(`${buildContext} | docker build -q -f services/job/Dockerfile -t ${attemptImageTag} -`);
  return { image: await pushed(attemptImageTag), ms: performance.now() - started };
}

const Container = z.object({ NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }) });

async function ownAddress(): Promise<string> {
  const found = Container.safeParse((await docker('GET', `/containers/${hostname()}/json`)).body).data?.NetworkSettings.Networks['kind']?.IPAddress;
  if (found === undefined || found === '') throw new Error('this container has no address on the kind network');
  return found;
}

async function ownNamespace(cluster: Cluster): Promise<string> {
  const { namespace } = cluster;
  await cluster.core.createNamespace({ body: { metadata: { name: namespace } } });
  await cluster.core.createNamespacedServiceAccount({ namespace, body: { metadata: { name: serviceAccount }, automountServiceAccountToken: false } });
  return `created namespace ${namespace} with service account ${serviceAccount}, so no sweep here touches another lane's Jobs`;
}

type Seeded = { readonly person: string; readonly routine: string; readonly repository: string };

type World = {
  readonly cluster: Cluster;
  readonly db: Database;
  readonly url: string;
  readonly image: ImageReference;
  readonly settings: JobSettings;
  readonly login: AccessOnlyLogin;
  readonly githubToken: string;
  readonly address: string;
  readonly seeded: Seeded;
  readonly run: string;
};

async function seed(db: Database): Promise<Seeded> {
  const at = new Date();
  const person = await db.insertInto('person').values({ email: 'probe@example.com', name: 'Probe Person' }).returning('id').executeTakeFirstOrThrow();
  const saving = randomUUID();
  const repository = await db
    .with('saved', query => query.insertInto('human_action').values({ id: saving, at, person_id: person.id, kind: 'add_repository', repository_id: 1 }).returning('id'))
    .insertInto('repository')
    .columns(['github', 'branch', 'saved_by'])
    .expression(eb => eb.selectFrom('saved').select([eb.val('braxtonkdev/autoworker-oss').as('github'), eb.val('main').as('branch'), 'saved.id']))
    .returning('id')
    .executeTakeFirstOrThrow();
  const routine = await db.insertInto('routine').values({ creator_id: person.id, run_as_id: person.id }).returning('id').executeTakeFirstOrThrow();
  const action = randomUUID();
  await db.insertInto('human_action').values({ id: action, at, person_id: person.id, kind: 'edit_routine', routine_id: routine.id }).execute();
  await db
    .insertInto('routine_version')
    .values({
      routine_id: routine.id,
      version: 1,
      name: 'Probe',
      goal: 'Probe the launcher.',
      repository_id: repository.id,
      action_id: action,
      workflow: 'code-change',
      source: JSON.stringify({ kind: 'jira-search' }),
      needs_repository: true,
    })
    .execute();
  return { person: person.id, routine: routine.id, repository: repository.id };
}

async function newAttempt(world: World, key: string): Promise<string> {
  const now = new Date();
  const task = await world.db
    .insertInto('task')
    .values({ routine_id: world.seeded.routine, found_version: 1, repository_id: world.seeded.repository, key, title: 'A made-up task', found_at: now, workflow: 'code-change', needs_repository: true, step: 'specify' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const attempt = await world.db
    .insertInto('attempt')
    .values({ task_id: task.id, routine_id: world.seeded.routine, routine_version: 1, step: 'specify', started_at: now, lease_until: new Date(now.getTime() + 86_400_000), run_as_id: world.seeded.person, epoch: 0 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return attempt.id;
}

async function finish(world: World, attempt: string): Promise<void> {
  await world.db.updateTable('attempt').set({ finished_at: new Date(), verdict: 'lost' }).where('id', '=', attempt).where('finished_at', 'is', null).execute();
}

type Started = { readonly attempt: string; readonly key: string; readonly branch: string };

type Options = {
  readonly key?: string;
  readonly number?: number;
  readonly step?: string;
  readonly image?: ImageReference;
  readonly repositoryUrl?: string;
  readonly startCommit?: string;
  readonly script?: string;
  readonly deadlineSeconds?: number;
};

async function start(world: World, options: Options = {}): Promise<Started> {
  const key = options.key ?? `probe-${world.run}-${randomBytes(3).toString('hex')}`;
  const number = options.number ?? 1;
  const attempt = await newAttempt(world, `${key}#${String(number)}`);
  const input = {
    attempt,
    taskKey: key,
    number,
    step: options.step ?? 'specify',
    image: options.image ?? world.image,
    repositoryUrl: options.repositoryUrl ?? thisRepository,
    startCommit: options.startCommit ?? pinnedCommit,
    attemptToken: randomBytes(24).toString('hex'),
    engineUrl: `http://${world.address}:9`,
    runAs: { name: 'Probe Person', email: 'probe@example.com', githubToken: world.githubToken, codexLogin: world.login },
  };
  const made = manifests(input, { ...world.settings, deadlineSeconds: options.deadlineSeconds ?? world.settings.deadlineSeconds });
  const job: V1Job = structuredClone(made.job);
  const container = job.spec?.template.spec?.containers[0];
  if (options.script !== undefined && container !== undefined) container.command = ['tini', '--', 'sh', '-c', options.script];
  await launch(world.cluster, { secret: made.secret, job });
  return { attempt, key, branch: attemptBranch(key, number) };
}

async function settled(world: World, attempt: string, ms = doneWaitMs): Promise<JobState & { readonly ms: number }> {
  const began = performance.now();
  while (performance.now() - began < ms) {
    const state = await jobState(world.cluster, attempt);
    if (state.state !== 'running') return { ...state, ms: performance.now() - began };
    await wait(250);
  }
  return { state: 'failed', reason: `still running after ${String(ms / 1000)} s`, ms };
}

const secretShapes = /github_pat_\w+|ghp_\w+|eyJ[\w.-]*/g;

const redact = (text: string): string => text.replace(secretShapes, '[redacted]');

async function rawLogOf(world: World, attempt: string): Promise<string> {
  const { items } = await world.cluster.core.listNamespacedPod({ namespace: world.cluster.namespace, labelSelector: `${labels.attempt}=${attempt}` });
  const name = items[0]?.metadata?.name;
  if (name === undefined) return '(no pod)';
  return world.cluster.core.readNamespacedPodLog({ name, namespace: world.cluster.namespace, container: containerName }).then(
    log => log.trim(),
    () => '(no log yet)',
  );
}

const logOf = async (world: World, attempt: string): Promise<string> => redact(await rawLogOf(world, attempt));

async function gone(world: World, attempt: string): Promise<{ readonly job: boolean; readonly secret: boolean; readonly pods: boolean }> {
  const name = jobName(attempt);
  const { namespace } = world.cluster;
  const exists = async (read: () => Promise<unknown>): Promise<boolean> =>
    read().then(
      () => true,
      (error: unknown) => {
        if (error instanceof ApiException && error.code === 404) return false;
        throw error;
      },
    );
  const [job, secret, pods] = await Promise.all([
    exists(() => world.cluster.batch.readNamespacedJob({ name, namespace })),
    exists(() => world.cluster.core.readNamespacedSecret({ name, namespace })),
    world.cluster.core.listNamespacedPod({ namespace: world.cluster.namespace, labelSelector: `${labels.attempt}=${attempt}` }).then(list => list.items.length > 0),
  ]);
  return { job: !job, secret: !secret, pods: !pods };
}

async function until(test: () => Promise<boolean>, ms: number): Promise<number | undefined> {
  const began = performance.now();
  while (performance.now() - began < ms) {
    if (await test()) return performance.now() - began;
    await wait(200);
  }
  return undefined;
}


const readyLine = (log: string): string | undefined => log.split('\n').find(line => line.startsWith('workspace ready at '));

async function readyFlow(world: World): Promise<readonly Check[]> {
  const started = await start(world);
  const done = await settled(world, started.attempt);
  const log = await logOf(world, started.attempt);
  const expected = `workspace ready at ${pinnedCommit} on ${started.branch}`;
  await finish(world, started.attempt);
  const swept = await sweepOnce(world.db, world.cluster);
  const cleared = await until(async () => {
    const state = await gone(world, started.attempt);
    return state.job && state.secret;
  }, 10_000);
  return [
    done.state === 'succeeded' && readyLine(log) === expected ? pass(`the Job printed "${expected}"`, `in ${(done.ms / 1000).toFixed(1)} s`) : fail(`the Job printed "${expected}"`, `${done.state === 'failed' ? done.reason : done.state}: ${log.slice(-400)}`),
    cleared === undefined ? fail('one sweep removed the Job and its Secret', swept.join(' | ')) : pass('one sweep removed the Job and its Secret', `${swept.filter(line => line.includes(started.attempt)).join(' | ')}; gone after ${(cleared / 1000).toFixed(1)} s`),
  ];
}

async function regression(world: World): Promise<readonly Check[]> {
  const started = await start(world, { script: `${bridge} && codex --version` });
  const done = await settled(world, started.attempt);
  const log = await logOf(world, started.attempt);
  await finish(world, started.attempt);
  const version = log.split('\n').find(line => line.startsWith('codex-cli'));
  const expected = `workspace ready at ${pinnedCommit} on ${started.branch}`;
  return [
    pass('trunk has no launcher, so this lane gates head only', 'recorded'),
    done.state === 'succeeded' && readyLine(log) === expected && version === codexPin
      ? pass('the Job succeeded at the pinned commit on its branch, with the pinned Codex CLI', `${expected}; ${version}`)
      : fail('the Job succeeded at the pinned commit on its branch, with the pinned Codex CLI', `${done.state}: ${log.slice(-400)}`),
  ];
}

const codexProbe = [
  'echo "whoami $(id -un)"',
  'ls /var/run/secrets/kubernetes.io/serviceaccount 2>&1 | head -1',
  `node -e "require('https').get({host:'kubernetes.default.svc',path:'/api',rejectUnauthorized:false,timeout:5000},r=>{console.log('api answered',r.statusCode);process.exit(0)}).on('error',e=>{console.log('api error',e.message);process.exit(0)})"`,
  'cat /proc/1/environ > /dev/null 2>&1 && echo "pid 1 environ read" || echo "pid 1 environ refused"',
  'for p in /proc/[0-9]*; do if [ "$p" != "/proc/$$" ] && grep -q ATTEMPT_TOKEN "$p/environ" 2> /dev/null; then echo "token readable in $p"; fi; done',
  'grep -rl ATTEMPT_TOKEN /workspace /home/codex 2> /dev/null | head -3 | sed "s/^/token file /"',
  'touch /var/lib/autoworker/attempt.git/config 2> /dev/null && echo "bridge git writable" || echo "bridge git refused"',
  'echo "probe done"',
].join('; ');

const asCodex = (script: string): string =>
  `node-bridge -e "const r=require('child_process').spawnSync('sh',['-c',process.argv[1]],{uid:10002,gid:10002,env:{PATH:process.env.PATH,HOME:'/home/codex'},stdio:'inherit'});process.exit(r.status??1)" '${script.replaceAll("'", "'\\''")}'`;

async function noKube(world: World): Promise<readonly Check[]> {
  const rbac = (() => {
    const config = new KubeConfig();
    config.loadFromDefault();
    return config.makeApiClient(RbacAuthorizationV1Api);
  })();
  const [roleBindings, clusterRoleBindings] = await Promise.all([rbac.listNamespacedRoleBinding({ namespace: world.cluster.namespace }), rbac.listClusterRoleBinding()]);
  const bound = [...roleBindings.items, ...clusterRoleBindings.items].filter(binding => binding.subjects?.some(subject => subject.kind === 'ServiceAccount' && subject.name === serviceAccount));
  const checks: Check[] = [bound.length === 0 ? pass(`no role binding names ${serviceAccount}`, `${String(roleBindings.items.length + clusterRoleBindings.items.length)} bindings read`) : fail(`no role binding names ${serviceAccount}`, bound.map(b => b.metadata?.name).join(', '))];
  for (const step of ['specify', 'implement', 'verify']) {
    const started = await start(world, { step, script: `${bridge} && ${asCodex(codexProbe)}` });
    const done = await settled(world, started.attempt);
    const log = await logOf(world, started.attempt);
    const { items } = await world.cluster.core.listNamespacedPod({ namespace: world.cluster.namespace, labelSelector: `${labels.attempt}=${started.attempt}` });
    const volumes = items[0]?.spec?.volumes ?? [];
    const containerMounts = items[0]?.spec?.containers[0]?.volumeMounts ?? [];
    await finish(world, started.attempt);
    const status = /api answered (\d+)/.exec(log)?.[1];
    const good =
      done.state === 'succeeded' &&
      log.includes('whoami codex') &&
      /No such file or directory/.test(log) &&
      (status === '401' || status === '403') &&
      log.includes('pid 1 environ refused') &&
      log.includes('bridge git refused') &&
      !log.includes('token readable') &&
      !log.includes('token file') &&
      log.includes('probe done') &&
      volumes.length === 0 &&
      containerMounts.length === 0;
    const name = `the ${step} Job has no token mounted, the API refuses its Codex user, and that user can neither read the bridge's token nor write its git directory`;
    checks.push(good ? pass(name, `${String(volumes.length)} volumes; ${log.split('\n').slice(1).join(' | ')}`) : fail(name, `${done.state}; volumes ${String(volumes.length)}: ${log.slice(-600)}`));
  }
  return checks;
}

async function envNames(world: World): Promise<readonly Check[]> {
  const started = await start(world, { script: `${bridge} && node-bridge -e "console.log(Object.keys(process.env).sort().join(' '))"` });
  const done = await settled(world, started.attempt);
  const log = await rawLogOf(world, started.attempt);
  await finish(world, started.attempt);
  const names = redact(log.split('\n').at(-1) ?? '');
  const forbidden = ['DATABASE_URL', 'KUBECONFIG', 'CREDENTIAL_KEY', 'REFRESH', 'SERVICEACCOUNT'].filter(word => names.includes(word));
  return [
    done.state === 'succeeded' && forbidden.length === 0 && names.includes('ATTEMPT_TOKEN')
      ? pass('the Job holds its Secret keys and no database, Kubernetes, or sealing setting', names)
      : fail('the Job holds its Secret keys and no database, Kubernetes, or sealing setting', `${done.state}; found ${forbidden.join(', ') || 'none'}: ${names}`),
    redact(log) !== log ? fail('the Job log holds no token or login', 'a token shape appeared') : pass('the Job log holds no token or login', `searched ${String(log.length)} characters for the GitHub token and JWT prefixes`),
  ];
}

async function deadline(world: World): Promise<readonly Check[]> {
  const started = await start(world, { deadlineSeconds: 30, script: 'sleep 600' });
  const done = await settled(world, started.attempt, 60_000);
  const read = (): Promise<V1Job> => world.cluster.batch.readNamespacedJob({ name: jobName(started.attempt), namespace: world.cluster.namespace });
  await until(async () => (await read()).status?.conditions?.some(entry => entry.type === 'Failed') === true, 60_000);
  const job = await read();
  const condition = job.status?.conditions?.find(entry => entry.type === 'Failed');
  const created = job.metadata?.creationTimestamp?.getTime() ?? 0;
  const at = condition?.lastTransitionTime?.getTime() ?? Number.POSITIVE_INFINITY;
  await finish(world, started.attempt);
  const seconds = (at - created) / 1000;
  return [
    condition?.reason === 'DeadlineExceeded' && seconds <= 40
      ? pass('Kubernetes ends a Job past its 30 s deadline within 40 s', `DeadlineExceeded ${seconds.toFixed(0)} s after creation`)
      : fail('Kubernetes ends a Job past its 30 s deadline within 40 s', `${condition?.reason ?? done.state} after ${seconds.toFixed(1)} s`),
  ];
}

const engineMain = fileURLToPath(new URL('../../services/engine/main.ts', import.meta.url));

function engine(world: World, everyMs: number): { readonly child: ChildProcess; readonly said: () => string } {
  let said = '';
  const child = spawn(process.execPath, [engineMain], {
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/root', DATABASE_URL: world.url, JOB_IMAGE: world.image, SWEEP_EVERY_MS: String(everyMs), JOB_NAMESPACE: world.cluster.namespace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
  return { child, said: () => said };
}

async function sweepLane(world: World): Promise<readonly Check[]> {
  const everyMs = 5_000;
  const first = await start(world, { script: 'sleep 600' });
  const second = await start(world, { script: 'sleep 600' });
  await until(async () => (await logOf(world, second.attempt)) !== '(no pod)', 60_000);
  const running = engine(world, everyMs);
  try {
    await until(() => Promise.resolve(running.said().includes('sweep: ')), 30_000);
    const markedAt = performance.now();
    await finish(world, first.attempt);
    const jobAndSecret = await until(async () => {
      const state = await gone(world, first.attempt);
      return state.job && state.secret;
    }, 60_000);
    const pods = await until(async () => (await gone(world, first.attempt)).pods, 60_000);
    const sinceMark = (performance.now() - markedAt) / 1000;
    await world.cluster.batch.deleteNamespacedJob({ name: jobName(second.attempt), namespace: world.cluster.namespace, propagationPolicy: 'Background' });
    const orphan = await until(async () => (await gone(world, second.attempt)).secret, 60_000);
    await finish(world, second.attempt);
    const line = running.said().split('\n').find(entry => entry.includes(`Job ${jobName(first.attempt)}`)) ?? '(no sweep line)';
    return [
      jobAndSecret !== undefined && jobAndSecret <= everyMs
        ? pass(`the engine's sweep removed a lost attempt's Job and Secret within one ${String(everyMs / 1000)} s interval`, `${(jobAndSecret / 1000).toFixed(1)} s; ${line}`)
        : fail(`the engine's sweep removed a lost attempt's Job and Secret within one ${String(everyMs / 1000)} s interval`, `${jobAndSecret === undefined ? 'never' : `${(jobAndSecret / 1000).toFixed(1)} s`}; ${running.said().slice(-600)}`),
      pods === undefined ? fail("the lost attempt's pod is gone", 'still present after 60 s') : pass("the lost attempt's pod is gone", `${sinceMark.toFixed(1)} s after the attempt was marked lost, including the pod's termination`),
      orphan === undefined ? fail('Kubernetes deletes a directly deleted Job\'s Secret with it', 'the Secret stayed') : pass("Kubernetes deletes a directly deleted Job's Secret with it", `${(orphan / 1000).toFixed(1)} s, by the Secret's owner reference`),
    ];
  } finally {
    running.child.kill('SIGTERM');
    await new Promise(resolve => running.child.once('exit', resolve));
  }
}

type GitServer = { readonly url: (repository: string) => string; readonly folder: string; readonly stop: () => Promise<void> };

async function gitServer(address: string): Promise<GitServer> {
  const folder = await mkdtemp(join(tmpdir(), 'jobs-git-'));
  const port = 9418;
  const child = spawn('git', ['daemon', '--reuseaddr', '--export-all', '--enable=receive-pack', `--base-path=${folder}`, `--listen=${address}`, `--port=${String(port)}`, folder], { stdio: 'ignore' });
  await wait(500);
  return {
    url: repository => `git://${address}:${String(port)}/${repository}`,
    folder,
    stop: async () => {
      child.kill('SIGTERM');
      await rm(folder, { recursive: true, force: true });
    },
  };
}

async function probeRepository(server: GitServer, name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'jobs-work-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), content);
  }
  const bare = join(server.folder, name);
  await sh(
    [
      `git -C ${work} init -q -b main`,
      `git -C ${work} add -A`,
      `git -C ${work} -c user.name=Probe -c user.email=probe@example.com commit -q -m probe`,
      `git clone -q --bare ${work} ${bare}`,
      `git -C ${bare} config uploadpack.allowAnySHA1InWant true`,
      `git -C ${bare} config daemon.receivepack true`,
    ].join(' && '),
  );
  const head = await sh(`git -C ${bare} rev-parse main`);
  await rm(work, { recursive: true, force: true });
  return head;
}

async function bridgeFromImage(world: World): Promise<readonly Check[]> {
  const server = await gitServer(world.address);
  try {
    const head = await probeRepository(server, 'probe.git', { 'services/job/main.ts': "throw new Error('planted: the entry point in the clone ran');\n", 'README.md': 'probe\n' });
    const started = await start(world, { repositoryUrl: server.url('probe.git'), startCommit: head, script: `${bridge} && head -1 /workspace/services/job/main.ts` });
    const done = await settled(world, started.attempt);
    const log = await logOf(world, started.attempt);
    await finish(world, started.attempt);
    const name = "the Job prints workspace ready from the image's entry point while the clone's entry point is broken";
    return [
      done.state === 'succeeded' && readyLine(log) === `workspace ready at ${head} on ${started.branch}` && log.includes("throw new Error('planted") && !log.includes('Error: planted')
        ? pass(name, log.replaceAll('\n', ' | '))
        : fail(name, `${done.state}: ${log}`),
    ];
  } finally {
    await server.stop();
  }
}

const pushScript = (step: string, then: string): string =>
  [
    bridge,
    asCodex(`echo ${step} > /workspace/${step}.txt`),
    `node-bridge --input-type=module -e "const cp=await import('node:child_process');const w=await import('/app/features/jobs/workspace.ts');const env=w.readJobEnvironment(process.env);const first=await w.pushStep(env,'step ${step}',undefined);console.log('pushed',JSON.stringify(first));${then}"`,
  ].join(' && ');

async function lostPush(world: World): Promise<readonly Check[]> {
  const server = await gitServer(world.address);
  try {
    const head = await probeRepository(server, 'lost.git', { 'README.md': 'lost push probe\n' });
    const key = `lost-${world.run}`;
    const bare = join(server.folder, 'lost.git');
    await sh(`git -C ${bare} branch autoworker/${key} main`);
    const ref = (branch: string): Promise<string> => sh(`git -C ${bare} rev-parse --verify -q refs/heads/${branch} || true`);
    const late = `await new Promise(r=>{const t=setInterval(()=>{const o=cp.spawnSync('git',['ls-remote','${server.url('lost.git')}','refs/heads/autoworker/${key}-attempt-2'],{encoding:'utf8'});if(o.stdout.trim()!==''){clearInterval(t);r();}},1000);});cp.spawnSync('sh',['-c','echo late > /workspace/late.txt'],{uid:10002,gid:10002});const again=await w.pushStep(env,'late',first.pushed);console.log('late',JSON.stringify(again));`;
    const one = await start(world, { key, number: 1, repositoryUrl: server.url('lost.git'), startCommit: head, script: pushScript('one', late) });
    const firstPush = await until(async () => (await ref(one.branch)) !== '', 120_000);
    const oneFirst = await ref(one.branch);
    await finish(world, one.attempt);
    const two = await start(world, { key, number: 2, repositoryUrl: server.url('lost.git'), startCommit: oneFirst, script: pushScript('two', '') });
    await settled(world, two.attempt);
    const twoHead = await ref(two.branch);
    const taskHead = await ref(`autoworker/${key}`);
    const oneDone = await settled(world, one.attempt);
    const oneLog = await logOf(world, one.attempt);
    const oneLate = await ref(one.branch);
    await finish(world, two.attempt);
    const twoAfter = await ref(two.branch);
    const taskAfter = await ref(`autoworker/${key}`);
    const name = "a lost attempt's late push lands only on its own branch, and the next attempt's branch and the task's branch stay put (E)";
    const good = firstPush !== undefined && oneDone.state === 'succeeded' && oneLate !== oneFirst && oneLog.includes('late {"pushed"') && twoAfter === twoHead && twoHead !== '' && taskAfter === taskHead && taskAfter === head;
    return [good ? pass(name, `attempt 1 ${oneFirst.slice(0, 8)} then ${oneLate.slice(0, 8)}, attempt 2 ${twoHead.slice(0, 8)} unchanged, task ${taskAfter.slice(0, 8)} unchanged`) : fail(name, `${oneDone.state}; one ${oneFirst}/${oneLate}, two ${twoHead}/${twoAfter}, task ${taskHead}/${taskAfter}: ${oneLog.slice(-500)}`)];
  } finally {
    await server.stop();
  }
}

async function init(world: World): Promise<readonly Check[]> {
  const started = await start(world, { script: `${bridge} && sh -c "sleep 0.3 &" && sleep 2 && for p in /proc/[0-9]*/stat; do cut -d" " -f1-3 "$p"; done` });
  const done = await settled(world, started.attempt);
  const log = await logOf(world, started.attempt);
  await finish(world, started.attempt);
  const processes = log.split('\n').filter(line => /^\d+ \(/.test(line));
  const zombies = processes.filter(line => / Z$/.test(line));
  const name = 'tini is PID 1 and reaps an orphaned child, so no process is a zombie';
  return [done.state === 'succeeded' && processes.includes('1 (tini) S') && zombies.length === 0 ? pass(name, processes.join(' | ')) : fail(name, `${done.state}: ${log.slice(-400)}`)];
}

async function badImage(world: World): Promise<readonly Check[]> {
  const tag = 'node:24-bookworm-slim';
  const parsed = imageReference.safeParse(tag);
  let refused = 'accepted';
  try {
    await world.db.updateTable('repository').set({ job_image: tag }).where('id', '=', world.seeded.repository).execute();
  } catch (error) {
    const found = refusal(error);
    refused = found !== undefined && 'name' in found ? found.name : reason(error);
  }
  const foreign = imageReference.parse('docker.io/library/node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6');
  const started = await start(world, { image: foreign });
  const state = await until(async () => (await jobState(world.cluster, started.attempt)).state === 'failed', 120_000);
  const reported = await jobState(world.cluster, started.attempt);
  await finish(world, started.attempt);
  const swept = await sweepOnce(world.db, world.cluster);
  const cleared = await until(async () => (await gone(world, started.attempt)).job, 10_000);
  return [
    !parsed.success && refused === 'job_image_named_by_digest'
      ? pass('a mutable tag fails setup, in the settings parse and in the repository column', `zod: ${parsed.error.issues[0]?.message ?? ''}; Postgres: ${refused}`)
      : fail('a mutable tag fails setup, in the settings parse and in the repository column', `zod ${parsed.success ? 'accepted' : 'refused'}; Postgres ${refused}`),
    state !== undefined && reported.state === 'failed' && reported.reason.includes(foreign)
      ? pass('a Job from an image that does not extend the attempt image fails at start, and the launcher names the image', reported.reason)
      : fail('a Job from an image that does not extend the attempt image fails at start, and the launcher names the image', JSON.stringify(reported)),
    cleared === undefined ? fail('the sweep removes the failed Job', swept.join(' | ')) : pass('the sweep removes the failed Job', swept.filter(line => line.includes(started.attempt)).join(' | ')),
  ];
}

async function repoImage(world: World): Promise<readonly Check[]> {
  const folder = await mkdtemp(join(tmpdir(), 'jobs-image-'));
  try {
    await writeFile(join(folder, 'Dockerfile'), `FROM ${world.image}\nUSER root\nRUN echo "extra file from the repository image" > /extra.txt\nUSER 10001:10001\n`);
    const tag = `${registry.host}/autoworker-probe-repo:verify`;
    await sh(`docker build -q -t ${tag} ${folder}`);
    const probe = await pushed(tag);
    await world.db.updateTable('repository').set({ job_image: probe }).where('id', '=', world.seeded.repository).execute();
    const row = await world.db.selectFrom('repository').select('job_image').where('id', '=', world.seeded.repository).executeTakeFirstOrThrow();
    const image = imageFor(world.settings, row.job_image === null ? null : imageReference.parse(row.job_image));
    const started = await start(world, { image, script: `${bridge} && cat /extra.txt` });
    const done = await settled(world, started.attempt);
    const log = await logOf(world, started.attempt);
    await finish(world, started.attempt);
    await world.db.updateTable('repository').set({ job_image: null }).where('id', '=', world.seeded.repository).execute();
    const name = "a repository's image that extends the attempt image runs the Job, and its extra file is there";
    return [done.state === 'succeeded' && readyLine(log) !== undefined && log.includes('extra file from the repository image') && image === probe ? pass(name, `${probe}: ${log.replaceAll('\n', ' | ')}`) : fail(name, `${done.state}: ${log}`)];
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

async function perf(world: World): Promise<readonly Check[]> {
  const launches: number[] = [];
  const sweeps: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const started = await start(world);
    const done = await settled(world, started.attempt);
    if (done.state !== 'succeeded') return [fail('perf launch succeeded', done.state === 'failed' ? done.reason : done.state)];
    launches.push(done.ms);
    const batch = [started];
    for (let index = 0; index < 19; index += 1) batch.push(await start(world, { script: 'true' }));
    for (const entry of batch) await settled(world, entry.attempt);
    for (const entry of batch) await finish(world, entry.attempt);
    const began = performance.now();
    const lines = await sweepOnce(world.db, world.cluster);
    sweeps.push(performance.now() - began);
    if (lines.filter(line => line.startsWith('deleted Job')).length < 20) return [fail('each sweep pass deletes 20 finished Jobs', lines.join(' | '))];
  }
  const seconds = (values: readonly number[]): string => values.map(value => (value / 1000).toFixed(2)).join(', ');
  return [
    pass('trunk has no launcher to time, so this unit sets absolute budgets', 'recorded'),
    median(launches) <= readyBudgetMs ? pass(`median launch to workspace ready is at most ${String(readyBudgetMs / 1000)} s`, `median ${(median(launches) / 1000).toFixed(2)} s of ${seconds(launches)}`) : fail(`median launch to workspace ready is at most ${String(readyBudgetMs / 1000)} s`, seconds(launches)),
    Math.max(...sweeps) <= sweepBudgetMs ? pass(`a sweep pass over 20 finished Jobs takes at most ${String(sweepBudgetMs / 1000)} s`, `passes took ${seconds(sweeps)} s`) : fail(`a sweep pass over 20 finished Jobs takes at most ${String(sweepBudgetMs / 1000)} s`, seconds(sweeps)),
  ];
}

async function changedDigest(): Promise<readonly Check[]> {
  const changed = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b7';
  const name = 'a changed base digest fails the attempt image build';
  try {
    await sh(`${buildContext} | docker build -q --build-arg NODE_IMAGE=${changed} -f services/job/Dockerfile -t autoworker-job:changed-digest -`);
    return [fail(name, 'the build succeeded')];
  } catch (error) {
    return [pass(name, reason(error).slice(-240))];
  }
}

const lanes = {
  ready: readyFlow,
  regression,
  'no-kube': noKube,
  'env-names': envNames,
  deadline,
  sweep: sweepLane,
  'bridge-from-image': bridgeFromImage,
  'lost-push': lostPush,
  init,
  'bad-image': badImage,
  'repo-image': repoImage,
  perf,
} as const satisfies Record<string, (world: World) => Promise<readonly Check[]>>;

type Lane = keyof typeof lanes;

const isLane = (name: string): name is Lane => name in lanes;

async function readLogin(): Promise<AccessOnlyLogin> {
  const copy = accessOnly(await readFile('/codex/auth.json', 'utf8'));
  if ('refused' in copy) throw new Error(copy.reason);
  return copy.login;
}

async function live(args: readonly string[]): Promise<readonly Check[]> {
  const names = args.length === 0 ? ['ready'] : args.includes('all') ? Object.keys(lanes) : args;
  const unknown = names.filter(name => !isLane(name) && name !== 'changed-digest');
  if (unknown.length > 0) return [fail('jobs-live runs known lanes', `unknown ${unknown.join(', ')}; name any of ${Object.keys(lanes).join(', ')}, changed-digest, or all`)];
  const githubToken = process.env['GITHUB_TOKEN'];
  if (githubToken === undefined || githubToken === '') return [fail('GITHUB_TOKEN is set', 'run jobs-live in the live service')];
  const checks: Check[] = [...(await kind.run(['up']))];
  if (!checks.every(check => check.passed)) return checks;
  checks.push(pass('registry ready', await ensureRegistry()));
  const built = await buildAttemptImage();
  checks.push(pass('attempt image built and pushed by digest', `${built.image} in ${(built.ms / 1000).toFixed(1)} s`));
  if (names.includes('changed-digest') || args.includes('all')) checks.push(...(await changedDigest()));
  const run = randomBytes(3).toString('hex');
  const cluster = connectCluster(`jobs-${run}`);
  checks.push(pass('namespace ready', await ownNamespace(cluster)));
  const login = await readLogin();
  const address = await ownAddress();
  return withPostgres(async postgres => {
    const scratch = await postgres.scratch();
    const db = connect(scratch.stableUrl, 4);
    try {
      const world: World = {
        cluster,
        db,
        url: scratch.stableUrl,
        image: built.image,
        settings: { image: built.image, namespace: cluster.namespace, serviceAccount, deadlineSeconds: 600 },
        login,
        githubToken,
        address,
        seeded: await seed(db),
        run,
      };
      for (const name of names.filter(isLane)) {
        const began = performance.now();
        try {
          for (const check of await lanes[name](world)) checks.push({ ...check, name: `${name}: ${check.name}` });
        } catch (error) {
          checks.push(fail(`${name}: runs to completion`, reason(error)));
        }
        checks.push(pass(`${name}: took`, `${((performance.now() - began) / 1000).toFixed(1)} s`));
      }
      return checks;
    } finally {
      await db.destroy();
      await scratch.drop();
      await cluster.core.deleteNamespace({ name: cluster.namespace });
    }
  });
}

export const liveScenario: Scenario = {
  name: 'jobs-live',
  summary: 'launches Jobs on the kind cluster from the attempt image by digest; name lanes to run, or all',
  run: live,
};
