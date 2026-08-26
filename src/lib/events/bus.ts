export type CareEventMap = {
  "entry:changed": {
    patientId: string;
    entryId: string;
    reason: "created" | "updated" | "reverted";
  };
};

type Handler<K extends keyof CareEventMap> = (payload: CareEventMap[K]) => void;

export function createEventBus() {
  const listeners = new Map<keyof CareEventMap, Set<(payload: never) => void>>();

  function on<K extends keyof CareEventMap>(event: K, handler: Handler<K>): () => void {
    const bucket = listeners.get(event) ?? new Set();
    bucket.add(handler as (payload: never) => void);
    listeners.set(event, bucket);
    return () => off(event, handler);
  }

  function off<K extends keyof CareEventMap>(event: K, handler: Handler<K>): void {
    listeners.get(event)?.delete(handler as (payload: never) => void);
  }

  function emit<K extends keyof CareEventMap>(event: K, payload: CareEventMap[K]): void {
    const bucket = listeners.get(event);
    if (!bucket) {
      return;
    }
    for (const handler of bucket) {
      (handler as Handler<K>)(payload);
    }
  }

  function clear(): void {
    listeners.clear();
  }

  function listenerCount(event: keyof CareEventMap): number {
    return listeners.get(event)?.size ?? 0;
  }

  return { on, off, emit, clear, listenerCount };
}

export const careEvents = createEventBus();
