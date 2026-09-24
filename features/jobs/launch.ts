import { ApiException, type V1Job, type V1Pod, type V1Secret } from '@kubernetes/client-node';
import { labels, type Cluster } from '../../shared/cluster.ts';
import type { AccessOnlyLogin } from '../../shared/codex-login.ts';
import type { ImageReference, JobSettings } from './settings.ts';
import { attemptBranch, type SecretKey } from './workspace.ts';

export type RunAs = {
  readonly name: string;
  readonly email: string;
  readonly githubToken: string;
  readonly codexLogin: AccessOnlyLogin;
};

export type LaunchInput = {
  readonly attempt: string;
  readonly taskKey: string;
  readonly number: number;
  readonly step: string;
  readonly image: ImageReference;
  readonly repositoryUrl: string;
  readonly startCommit: string;
  readonly attemptToken: string;
  readonly engineUrl: string;
  readonly runAs: RunAs;
};

export type Manifests = { readonly secret: V1Secret; readonly job: V1Job };

export const containerName = 'attempt';

export const jobName = (attempt: string): string => `autoworker-attempt-${attempt}`;

const labelValue = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

export const imageFor = (settings: JobSettings, repositoryImage: ImageReference | null): ImageReference => repositoryImage ?? settings.image;

export function manifests(input: LaunchInput, settings: JobSettings): Manifests {
  const name = jobName(input.attempt);
  const metadata = {
    name,
    namespace: settings.namespace,
    labels: { [labels.attempt]: input.attempt, [labels.task]: labelValue(input.taskKey), [labels.step]: labelValue(input.step) },
    annotations: { 'autoworker.dev/task-key': input.taskKey },
  };
  const keys: Record<SecretKey, string> = {
    ATTEMPT_ID: input.attempt,
    ATTEMPT_TOKEN: input.attemptToken,
    ENGINE_URL: input.engineUrl,
    REPO_URL: input.repositoryUrl,
    START_COMMIT: input.startCommit,
    ATTEMPT_BRANCH: attemptBranch(input.taskKey, input.number),
    GITHUB_TOKEN: input.runAs.githubToken,
    CODEX_AUTH_JSON: input.runAs.codexLogin,
    GIT_AUTHOR_NAME: input.runAs.name,
    GIT_AUTHOR_EMAIL: input.runAs.email,
  };
  return {
    secret: { apiVersion: 'v1', kind: 'Secret', metadata, type: 'Opaque', stringData: keys },
    job: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata,
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: settings.deadlineSeconds,
        podReplacementPolicy: 'Failed',
        template: {
          metadata: { labels: metadata.labels },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: settings.serviceAccount,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true },
            containers: [
              {
                name: containerName,
                image: input.image,
                imagePullPolicy: 'IfNotPresent',
                envFrom: [{ secretRef: { name } }],
                securityContext: { capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID', 'KILL'] }, seccompProfile: { type: 'RuntimeDefault' } },
              },
            ],
          },
        },
      },
    },
  };
}

const conflict = (error: unknown): boolean => error instanceof ApiException && error.code === 409;

export const missing = (error: unknown): boolean => error instanceof ApiException && error.code === 404;

export async function launch(cluster: Cluster, { secret, job }: Manifests): Promise<V1Job> {
  const { namespace } = cluster;
  const name = job.metadata?.name ?? '';
  try {
    await cluster.core.createNamespacedSecret({ namespace, body: secret });
  } catch (error) {
    if (!conflict(error)) throw error;
    await cluster.core.replaceNamespacedSecret({ name, namespace, body: secret });
  }
  let created: V1Job;
  try {
    created = await cluster.batch.createNamespacedJob({ namespace, body: job });
  } catch (error) {
    if (!conflict(error)) throw error;
    created = await cluster.batch.readNamespacedJob({ name, namespace });
  }
  const owner = { apiVersion: 'batch/v1', kind: 'Job', name, uid: created.metadata?.uid ?? '', controller: true, blockOwnerDeletion: false };
  const owned = structuredClone(secret);
  owned.metadata = Object.assign(owned.metadata ?? {}, { ownerReferences: [owner] });
  await cluster.core.replaceNamespacedSecret({ name, namespace, body: owned });
  return created;
}

export type JobState =
  | { readonly state: 'missing' }
  | { readonly state: 'running' }
  | { readonly state: 'succeeded' }
  | { readonly state: 'failed'; readonly reason: string };

const startFailures = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError']);

function podFailure(pod: V1Pod, image: string): string | undefined {
  const status = pod.status?.containerStatuses?.find(container => container.name === containerName);
  const waiting = status?.state?.waiting;
  if (waiting?.reason !== undefined && startFailures.has(waiting.reason)) return `its container could not start from ${image}: ${waiting.reason}, ${waiting.message ?? 'no message'}`;
  const ended = status?.state?.terminated;
  if (ended !== undefined && ended.exitCode !== 0) return `its container from ${image} ended ${ended.reason ?? 'with an error'}, exit ${String(ended.exitCode)}: ${ended.message ?? 'no message'}`;
  return undefined;
}

export async function jobState(cluster: Cluster, attempt: string): Promise<JobState> {
  const { namespace } = cluster;
  let job: V1Job;
  try {
    job = await cluster.batch.readNamespacedJob({ name: jobName(attempt), namespace });
  } catch (error) {
    if (missing(error)) return { state: 'missing' };
    throw error;
  }
  const image = job.spec?.template.spec?.containers.find(container => container.name === containerName)?.image ?? 'an unnamed image';
  const { items: pods } = await cluster.core.listNamespacedPod({ namespace, labelSelector: `${labels.attempt}=${attempt}` });
  const podReason = pods.map(pod => podFailure(pod, image)).find(reason => reason !== undefined);
  const failed = job.status?.conditions?.find(condition => condition.type === 'Failed' && condition.status === 'True');
  if (failed !== undefined) return { state: 'failed', reason: `Job ${jobName(attempt)} failed, ${failed.reason ?? 'no reason'}: ${podReason ?? failed.message ?? `no pod ran from ${image}`}` };
  if (podReason !== undefined) return { state: 'failed', reason: `Job ${jobName(attempt)} failed to start, because ${podReason}` };
  if (job.status?.conditions?.some(condition => condition.type === 'Complete' && condition.status === 'True') === true) return { state: 'succeeded' };
  return { state: 'running' };
}
