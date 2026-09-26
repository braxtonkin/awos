import { useEffect, useRef } from 'react';
import type { z } from 'zod';

export type Stream = { readonly path: string; readonly after: string | undefined };

type Listener = (data: unknown) => void;

type Source = { readonly listeners: Set<Listener>; readonly close: () => void };

const reopenMs = 1000;

const sources = new Map<string, Source>();

const urlOf = (path: string, after: string | undefined): string => (after === undefined ? path : `${path}?after=${encodeURIComponent(after)}`);

function open(stream: Stream): Source {
  const listeners = new Set<Listener>();
  let lastId = stream.after;
  let events: EventSource | undefined;
  let closed = false;
  const connect = (): void => {
    const current = new EventSource(urlOf(stream.path, lastId));
    events = current;
    current.onmessage = (message: MessageEvent<string>) => {
      if (message.lastEventId !== '') lastId = message.lastEventId;
      const data: unknown = JSON.parse(message.data);
      for (const listener of listeners) listener(data);
    };
    current.onerror = () => {
      if (current.readyState === EventSource.CLOSED && !closed) window.setTimeout(connect, reopenMs);
    };
  };
  connect();
  return {
    listeners,
    close: () => {
      closed = true;
      events?.close();
    },
  };
}

export function useFrames<F>(stream: Stream, frame: z.ZodType<F>, onFrame: (frame: F) => void): void {
  const { path } = stream;
  const after = useRef(stream.after);
  const handler = useRef(onFrame);
  useEffect(() => {
    handler.current = onFrame;
  });
  useEffect(() => {
    const source = sources.get(path) ?? open({ path, after: after.current });
    sources.set(path, source);
    const listener: Listener = data => {
      handler.current(frame.parse(data));
    };
    source.listeners.add(listener);
    return () => {
      source.listeners.delete(listener);
      if (source.listeners.size > 0) return;
      source.close();
      sources.delete(path);
    };
  }, [path, frame]);
}
