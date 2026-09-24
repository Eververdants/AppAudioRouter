import { useLayoutEffect, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * Subscribe to a backend event for as long as the component is mounted.
 *
 * `listen` resolves asynchronously, so a single `disposed` flag is not enough
 * under StrictMode (the effect runs, tears down, and runs again before the first
 * promise resolves): the first subscription would be orphaned. Each run owns a
 * token, and a handle whose run has been superseded unsubscribes itself.
 *
 * The handler is read through a ref so the subscription is not recreated every
 * time the caller passes a new closure.
 */
export function useBackendEvent<P>(name: string, handler: (payload: P) => void): void {
  const handlerRef = useRef(handler);
  const activeRef = useRef<unknown>(null);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const token = {};
    activeRef.current = token;
    let unlisten: (() => void) | null = null;

    void listen<P>(name, (event) => handlerRef.current(event.payload)).then((off) => {
      // A newer effect run already replaced this one: drop the stale handle.
      if (activeRef.current !== token) off();
      else unlisten = off;
    });

    return () => {
      if (activeRef.current === token) activeRef.current = null;
      unlisten?.();
    };
  }, [name]);
}
