import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import type { MkcMemoryReadError, MkcMemoryReadResult } from '@/services/mkc-memory-client';

export type MemoryResourceState<T> = {
  result: MkcMemoryReadResult<T> | null;
  error: MkcMemoryReadError | null;
  loading: boolean;
  refreshing: boolean;
};

export function useMemoryResource<T>(
  loader: (signal: AbortSignal) => Promise<MkcMemoryReadResult<T>>,
): MemoryResourceState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = useState<MemoryResourceState<T>>({
    result: null,
    error: null,
    loading: true,
    refreshing: false,
  });
  const requestId = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const load = useCallback(async (refreshing: boolean) => {
    const id = ++requestId.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setState((current) => ({
      ...current,
      error: null,
      loading: refreshing ? current.loading : !current.result,
      refreshing,
    }));
    try {
      const result = await loader(controller.signal);
      if (requestId.current === id) setState({ result, error: null, loading: false, refreshing: false });
    } catch (cause) {
      if (requestId.current !== id || controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        error: cause as MkcMemoryReadError,
        loading: false,
        refreshing: false,
      }));
    }
  }, [loader]);

  useFocusEffect(useCallback(() => {
    void load(false);
    return () => {
      requestId.current += 1;
      activeController.current?.abort();
    };
  }, [load]));

  return {
    ...state,
    refresh: useCallback(() => load(true), [load]),
  };
}
