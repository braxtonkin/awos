import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { text } from 'node:stream/consumers';

export type Asked = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
};

export type Answer = { readonly status: number; readonly json: unknown } | { readonly status: number; readonly text: string } | { readonly status: number };

export type Route = {
  readonly method: string;
  readonly path: RegExp;
  readonly open?: boolean;
  readonly answer: (asked: Asked, match: readonly string[]) => Answer | Promise<Answer>;
};

export type Served = { readonly url: string; readonly stop: () => Promise<void> };

export type Fake = { readonly name: string; readonly routes: readonly Route[]; readonly admits: (headers: IncomingHttpHeaders) => boolean };

export const json = (json: unknown, status = 200): Answer => ({ status, json });

export const refusal = (status: number, message: string): Answer => json({ message, errorMessages: [message] }, status);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function bodyOf(sent: string): { readonly body: unknown } | { readonly unreadable: string } {
  if (sent === '') return { body: undefined };
  try {
    const body: unknown = JSON.parse(sent);
    return { body };
  } catch (error) {
    return { unreadable: messageOf(error) };
  }
}

async function answerFor(fake: Fake, method: string, url: URL, headers: IncomingHttpHeaders, sent: string): Promise<Answer> {
  const path = decodeURIComponent(url.pathname);
  for (const route of fake.routes) {
    const match = route.method === method ? route.path.exec(path) : null;
    if (match === null) continue;
    if (route.open !== true && !fake.admits(headers)) return refusal(401, 'Bad credentials');
    const read = bodyOf(sent);
    if ('unreadable' in read) return refusal(400, `The body of ${method} ${path} is not JSON: ${read.unreadable}`);
    return route.answer({ method, path, query: url.searchParams, headers, body: read.body }, match.slice(1));
  }
  return refusal(404, `The fake ${fake.name} has no route for ${method} ${path}`);
}

export async function serve(fake: Fake): Promise<Served> {
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://fake');
    text(request)
      .then(sent => answerFor(fake, method, url, request.headers, sent))
      .catch((error: unknown) => refusal(500, `The fake ${fake.name} failed on ${method} ${url.pathname}: ${messageOf(error)}`))
      .then(answer => {
        if ('json' in answer) response.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(answer.json));
        else if ('text' in answer) response.writeHead(answer.status, { 'content-type': 'text/plain; charset=utf-8' }).end(answer.text);
        else response.writeHead(answer.status).end();
      })
      .catch(() => {
        response.destroy();
      });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`the fake ${fake.name} has no port`);
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
