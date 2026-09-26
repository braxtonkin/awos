import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { z } from 'zod';

export type Kind = 'secrets' | 'jobs';

export type Verb = 'create' | 'replace' | 'read' | 'list' | 'delete';

export type Call = { readonly verb: Verb; readonly kind: Kind | 'pods'; readonly name: string | null; readonly status: number };

const sentObject = z.looseObject({ metadata: z.looseObject({ name: z.string().min(1), labels: z.record(z.string(), z.string()).optional() }) });

export type StoredObject = z.infer<typeof sentObject> & { readonly metadata: { readonly uid: string } };

export type Fault = { readonly verb: Verb; readonly kind: Kind; readonly name?: string; readonly status: number };

export type Hook = { readonly verb: Verb; readonly kind: Kind; readonly run: () => Promise<void> };

export type FakeCluster = {
  readonly namespace: string;
  readonly kubeconfig: string;
  readonly calls: () => readonly Call[];
  readonly objects: (kind: Kind) => readonly StoredObject[];
  readonly put: (kind: Kind, object: { readonly metadata: { readonly name: string; readonly labels?: Readonly<Record<string, string>> } }) => void;
  readonly failOnce: (fault: Fault) => void;
  readonly before: (hook: Hook) => void;
  readonly stop: () => Promise<void>;
};

type Route = { readonly verb: Verb; readonly kind: Kind | 'pods'; readonly name: string | null };

const paths: readonly { readonly pattern: RegExp; readonly kind: Kind | 'pods' }[] = [
  { pattern: /^\/api\/v1\/namespaces\/([^/]+)\/secrets(?:\/([^/]+))?$/, kind: 'secrets' },
  { pattern: /^\/apis\/batch\/v1\/namespaces\/([^/]+)\/jobs(?:\/([^/]+))?$/, kind: 'jobs' },
  { pattern: /^\/api\/v1\/namespaces\/([^/]+)\/pods$/, kind: 'pods' },
];

const verbs: Readonly<Record<string, readonly [Verb, Verb]>> = { GET: ['list', 'read'], POST: ['create', 'create'], PUT: ['replace', 'replace'], DELETE: ['delete', 'delete'] };

function routeOf(method: string, path: string, namespace: string): Route | undefined {
  for (const { pattern, kind } of paths) {
    const match = pattern.exec(path);
    if (match === null || match[1] !== namespace) continue;
    const name = match[2] ?? null;
    const verb = verbs[method]?.[name === null ? 0 : 1];
    return verb === undefined ? undefined : { verb, kind, name };
  }
  return undefined;
}

const status = (code: number, message: string): unknown => ({ apiVersion: 'v1', kind: 'Status', status: 'Failure', code, message, reason: code === 404 ? 'NotFound' : code === 409 ? 'AlreadyExists' : 'InternalError' });

const listKinds: Readonly<Record<Kind | 'pods', { readonly apiVersion: string; readonly kind: string }>> = {
  secrets: { apiVersion: 'v1', kind: 'SecretList' },
  jobs: { apiVersion: 'batch/v1', kind: 'JobList' },
  pods: { apiVersion: 'v1', kind: 'PodList' },
};

const selected = (object: StoredObject, selector: string | null): boolean =>
  selector === null ||
  selector
    .split(',')
    .filter(term => term !== '')
    .every(term => {
      const [key = '', value] = term.split('=');
      const labels = object.metadata.labels ?? {};
      return value === undefined ? key in labels : labels[key] === value;
    });

export async function startFakeCluster(namespace = 'fake'): Promise<FakeCluster> {
  const store: Record<Kind, Map<string, StoredObject>> = { secrets: new Map(), jobs: new Map() };
  const calls: Call[] = [];
  const faults: Fault[] = [];
  const hooks: Hook[] = [];
  const stored = (kind: Kind, body: unknown): StoredObject => {
    const given = sentObject.parse(body);
    return { ...given, metadata: { ...given.metadata, uid: store[kind].get(given.metadata.name)?.metadata.uid ?? randomUUID() } };
  };
  const answer = async (route: Route, body: unknown, selector: string | null): Promise<{ readonly code: number; readonly json: unknown }> => {
    if (route.kind === 'pods') return { code: 200, json: { ...listKinds.pods, metadata: {}, items: [] } };
    const kind = route.kind;
    for (const hook of hooks.filter(entry => entry.verb === route.verb && entry.kind === kind)) {
      hooks.splice(hooks.indexOf(hook), 1);
      await hook.run();
    }
    const fault = faults.find(entry => entry.verb === route.verb && entry.kind === kind && (entry.name === undefined || entry.name === route.name));
    if (fault !== undefined) {
      faults.splice(faults.indexOf(fault), 1);
      return { code: fault.status, json: status(fault.status, `the fake cluster failed ${route.verb} ${kind} as planted`) };
    }
    const objects = store[kind];
    switch (route.verb) {
      case 'list':
        return { code: 200, json: { ...listKinds[kind], metadata: {}, items: [...objects.values()].filter(object => selected(object, selector)) } };
      case 'read': {
        const found = objects.get(route.name ?? '');
        return found === undefined ? { code: 404, json: status(404, `${kind} ${route.name ?? ''} not found`) } : { code: 200, json: found };
      }
      case 'create': {
        const object = stored(kind, body);
        if (objects.has(object.metadata.name)) return { code: 409, json: status(409, `${kind} ${object.metadata.name} already exists`) };
        objects.set(object.metadata.name, object);
        return { code: 201, json: object };
      }
      case 'replace': {
        if (!objects.has(route.name ?? '')) return { code: 404, json: status(404, `${kind} ${route.name ?? ''} not found`) };
        const object = stored(kind, body);
        objects.set(object.metadata.name, object);
        return { code: 200, json: object };
      }
      case 'delete': {
        const found = objects.get(route.name ?? '');
        if (found === undefined) return { code: 404, json: status(404, `${kind} ${route.name ?? ''} not found`) };
        objects.delete(found.metadata.name);
        return { code: 200, json: found };
      }
    }
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://fake-cluster');
    const sent = await text(request);
    const route = routeOf(request.method ?? 'GET', url.pathname, namespace);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify(status(404, `the fake cluster has no route for ${request.method ?? ''} ${url.pathname}`)));
      return;
    }
    const answered = await answer(route, sent === '' ? undefined : JSON.parse(sent), url.searchParams.get('labelSelector'));
    calls.push({ ...route, status: answered.code });
    response.writeHead(answered.code, { 'content-type': 'application/json' }).end(JSON.stringify(answered.json));
  };
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify(status(500, error instanceof Error ? error.message : String(error))));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake cluster has no port');
  const folder = await mkdtemp(join(tmpdir(), 'fake-cluster-'));
  const kubeconfig = join(folder, 'kubeconfig.json');
  await writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'fake', cluster: { server: `http://127.0.0.1:${String(address.port)}`, 'insecure-skip-tls-verify': true } }],
      users: [{ name: 'fake', user: { token: 'fake-cluster-token' } }],
      contexts: [{ name: 'fake', context: { cluster: 'fake', user: 'fake', namespace } }],
      'current-context': 'fake',
    }),
  );
  return {
    namespace,
    kubeconfig,
    calls: () => [...calls],
    objects: kind => [...store[kind].values()],
    put: (kind, object) => {
      store[kind].set(object.metadata.name, { ...object, metadata: { ...object.metadata, uid: randomUUID() } });
    },
    failOnce: fault => {
      faults.push(fault);
    },
    before: hook => {
      hooks.push(hook);
    },
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
      await rm(folder, { recursive: true, force: true });
    },
  };
}
