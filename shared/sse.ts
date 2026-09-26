export type Event<T> = { readonly id?: string; readonly data: T };

const retryMs = 1000;

const encoder = new TextEncoder();

const render = <T>(event: Event<T>): string => `${event.id === undefined ? '' : `id: ${event.id}\n`}data: ${JSON.stringify(event.data)}\n\n`;

export function sse<T>(events: AsyncGenerator<Event<T>, void>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${String(retryMs)}\n\n`));
    },
    async pull(controller) {
      const next = await events.next();
      if (next.done === true) controller.close();
      else controller.enqueue(encoder.encode(render(next.value)));
    },
    async cancel() {
      await events.return();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}
