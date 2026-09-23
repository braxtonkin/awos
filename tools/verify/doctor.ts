import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fail, pass, type Check, type Scenario } from './check.ts';

type Reply = { readonly status: number; readonly body: unknown };

const socketPath = '/var/run/docker.sock';
const labelKey = 'autoworker.verify.doctor';
const siblingAnswer = 'sibling reached';

const docker = (method: string, path: string, body?: object): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = payload === '' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    const outgoing = request({ socketPath, path, method, headers }, incoming => {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk: string) => {
        text += chunk;
      });
      incoming.on('end', () => {
        try {
          resolve({ status: incoming.statusCode ?? 0, body: text === '' ? null : (JSON.parse(text) as unknown) });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });

const field = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (current, key) => (typeof current === 'object' && current !== null && key in current ? (current as Record<string, unknown>)[key] : undefined),
    value,
  );

async function answer(url: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      return await response.text();
    } catch {
      await sleep(250);
    }
  }
  return undefined;
}

async function reachSibling(runId: string): Promise<Check> {
  const name = 'a sibling container answers through host.docker.internal';
  const self = await docker('GET', `/containers/${hostname()}/json`);
  const image = field(self.body, 'Image');
  if (typeof image !== 'string') return fail(name, `this container's image is unreadable, status ${String(self.status)}`);
  const created = await docker('POST', '/containers/create', {
    Image: image,
    Cmd: ['node', '-e', `require('node:http').createServer((request, response) => response.end('${siblingAnswer}')).listen(8080)`],
    ExposedPorts: { '8080/tcp': {} },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '' }] } },
    Labels: { [labelKey]: runId },
  });
  const id = field(created.body, 'Id');
  if (typeof id !== 'string') return fail(name, `the sibling was not created, status ${String(created.status)}`);
  try {
    await docker('POST', `/containers/${id}/start`);
    const inspected = await docker('GET', `/containers/${id}/json`);
    const port = field(inspected.body, 'NetworkSettings', 'Ports', '8080/tcp', '0', 'HostPort');
    if (typeof port !== 'string') return fail(name, 'the sibling published no port');
    const text = await answer(`http://host.docker.internal:${port}/`);
    return text === siblingAnswer ? pass(name, `${siblingAnswer} on port ${port}`) : fail(name, `no answer on port ${port}`);
  } finally {
    await docker('DELETE', `/containers/${id}?force=true`);
  }
}

async function noSiblingLeft(runId: string): Promise<Check> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${labelKey}=${runId}`] }));
  const listed = await docker('GET', `/containers/json?all=true&filters=${filters}`);
  const count = Array.isArray(listed.body) ? listed.body.length : -1;
  return count === 0 ? pass('no doctor container is left behind', '') : fail('no doctor container is left behind', `${String(count)} remain`);
}

export const doctor: Scenario = {
  name: 'doctor',
  summary: 'checks Node 24, the Docker API, and sibling containers from inside the verify container',
  run: async () => {
    const runId = randomUUID();
    const checks: Check[] = [
      process.version.startsWith('v24.') ? pass('Node is version 24', process.version) : fail('Node is version 24', process.version),
      process.env['TESTCONTAINERS_HOST_OVERRIDE'] === 'host.docker.internal'
        ? pass('Testcontainers reaches siblings through host.docker.internal', '')
        : fail('Testcontainers reaches siblings through host.docker.internal', 'TESTCONTAINERS_HOST_OVERRIDE is not set'),
    ];
    const version = await docker('GET', '/version').catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (version instanceof Error) return [...checks, fail('the Docker API answers', version.message)];
    const engine = field(version.body, 'Version');
    const api = field(version.body, 'ApiVersion');
    checks.push(pass('the Docker API answers', `engine ${typeof engine === 'string' ? engine : 'unknown'}, API ${typeof api === 'string' ? api : 'unknown'}`));
    checks.push(await reachSibling(runId));
    checks.push(await noSiblingLeft(runId));
    return checks;
  },
};
