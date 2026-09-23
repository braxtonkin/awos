import { request } from 'node:http';

export type Reply = { readonly status: number; readonly body: unknown };

const socketPath = '/var/run/docker.sock';

export const docker = (method: string, path: string, body?: object): Promise<Reply> =>
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
        } catch {
          reject(new Error(`the Docker API answered ${method} ${path} with a body that is not JSON`));
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
