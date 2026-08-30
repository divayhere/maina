/**
 * Owns one asynchronous execution per durable entity. Callers may either
 * ignore the returned promise (foreground UI) or await it (OS worker); both
 * observe the same completion and never start parallel work.
 */
export function createKeyedExecutionOwner<Key, Result>() {
  const inFlight = new Map<Key, Promise<Result>>();
  return {
    run(key: Key, execute: () => Promise<Result>): Promise<Result> {
      const existing = inFlight.get(key);
      if (existing) return existing;
      let work: Promise<Result>;
      work = Promise.resolve().then(execute).finally(() => {
        if (inFlight.get(key) === work) inFlight.delete(key);
      });
      inFlight.set(key, work);
      return work;
    },
    has(key: Key): boolean {
      return inFlight.has(key);
    },
  };
}
