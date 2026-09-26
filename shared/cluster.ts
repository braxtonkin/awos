import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';

export type Cluster = { readonly batch: BatchV1Api; readonly core: CoreV1Api; readonly namespace: string };

export function connectCluster(namespace: string): Cluster {
  const config = new KubeConfig();
  config.loadFromDefault();
  return { batch: config.makeApiClient(BatchV1Api), core: config.makeApiClient(CoreV1Api), namespace };
}

export const labels = { attempt: 'autoworker.dev/attempt', task: 'autoworker.dev/task', step: 'autoworker.dev/step' } as const;
