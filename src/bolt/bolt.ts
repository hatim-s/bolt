/**
 * Bolt public runtime.
 *
 * This module exposes two entry points:
 * - createBoltStore: framework-independent external store.
 * - createBolt: React provider and hooks backed by that external store.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  BoltPath,
  BoltPathValue,
  BoltProviderProps,
  BoltReactApi,
  BoltRuntimePath,
  BoltStoreApi,
  BoltUseStore,
  InternalBoltStore,
  Listener,
} from "./types";
import {
  normalizePath,
  notifyAll,
  notifyPrefixes,
  readPath,
  resolveValue,
  splitPathKey,
  writeImmutablePath,
} from "./utils";

// Re-export public types from the runtime entry so consumers can import both
// values and types from the package root.
export type {
  BoltPath,
  BoltPathValue,
  BoltProviderProps,
  BoltReactApi,
  BoltRuntimePath,
  BoltStoreApi,
  BoltUseStore,
  BoltValueOrUpdater,
} from "./types";

/**
 * Creates a standalone Bolt store without React.
 *
 * This is useful for tests, non-React consumers, or integration code that wants
 * the same path-indexed subscription behavior without a provider.
 */
export function createBoltStore<TState extends object>(
  initialState: TState,
): BoltStoreApi<TState> {
  return createInternalBoltStore(initialState);
}

/**
 * Creates a React-scoped Bolt API for one state shape.
 *
 * Each call returns a Provider and hooks bound to a private React context. The
 * provider owns one hoisted external store instance, and the hooks notify React
 * through useSyncExternalStore.
 */
export function createBolt<TState extends object>(): BoltReactApi<TState> {
  // Each createBolt call owns one context. This keeps separate Bolt stores from
  // accidentally sharing state or subscriptions.
  const context = createContext<InternalBoltStore<TState> | null>(null);

  /**
   * React provider for one Bolt store instance.
   *
   * The initial state is read only once, matching Zustand's provider pattern.
   * Later prop changes do not replace the store unless the provider remounts.
   */
  function Provider({
    state,
    children,
  }: BoltProviderProps<TState>) {
    // The store is hoisted outside React state but scoped to this provider
    // instance. useRef gives a stable object for the provider lifetime.
    const storeRef = useRef<InternalBoltStore<TState>>(undefined);

    if (!storeRef.current) {
      // Lazy creation avoids rebuilding the store on every provider render.
      storeRef.current = createInternalBoltStore(state);
    }

    // createElement keeps this file as .ts-compatible code, while still
    // producing the same provider element JSX would create.
    return createElement(context.Provider, { value: storeRef.current }, children);
  }

  /**
   * Reads the internal store from React context.
   *
   * This function returns InternalBoltStore because useStore needs internal
   * path-key helpers that are intentionally hidden from public useApi callers.
   */
  function useInternalApi() {
    const store = useContext(context);

    if (!store) {
      throw new Error("Bolt hooks must be used inside their Bolt provider");
    }

    return store;
  }

  /**
   * Public store access hook.
   *
   * Consumers can imperatively get/set/subscribe, but they do not receive the
   * internal normalized-path helpers used by useSyncExternalStore.
   */
  function useApi(): BoltStoreApi<TState> {
    return useInternalApi();
  }

  /**
   * useStore overload for whole-store reads.
   */
  function useStore(): TState;

  /**
   * useStore overload for typed path reads.
   */
  function useStore<Path extends BoltPath<TState>>(
    path: Path,
  ): BoltPathValue<TState, Path>;

  /**
   * Subscribes React to one path and returns that path's current snapshot.
   */
  function useStore(path?: BoltRuntimePath) {
    const store = useInternalApi();
    const pathKey = normalizePath(path);

    // React subscriptions are keyed by normalized path strings so equivalent
    // inputs like "a.b.0" and ["a", "b", "0"] share one listener bucket.
    const subscribe = useCallback(
      (listener: Listener) => store.subscribePathKey(pathKey, listener),
      [pathKey, store],
    );
    const getSnapshot = useCallback(
      () => store.getByPathKey(pathKey),
      [pathKey, store],
    );

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  /**
   * Convenience hook for the store setter.
   */
  function useSet() {
    return useApi().set;
  }

  // The implementation overloads cannot be inferred from the object literal, so
  // cast useStore back to the public overload type at the boundary.
  return { Provider, useApi, useSet, useStore: useStore as BoltUseStore<TState> };
}

/**
 * Creates the actual external store used by both the React and non-React APIs.
 */
function createInternalBoltStore<TState extends object>(
  initialState: TState,
): InternalBoltStore<TState> {
  // State lives in this closure instead of React state. React is notified only
  // by useSyncExternalStore subscriptions.
  let state = initialState;

  // Map key is the canonical dot path. Value is every listener interested in
  // that exact path.
  const listenersByPath = new Map<string, Set<Listener>>();

  /**
   * Returns the current root state object.
   */
  function getState() {
    return state;
  }

  /**
   * Public getter that accepts any supported path input.
   */
  function get(path?: BoltRuntimePath) {
    return readPath(state, path ? splitPathKey(normalizePath(path)) : []);
  }

  /**
   * Internal getter for already-normalized path keys.
   */
  function getByPathKey(pathKey: string) {
    return readPath(state, splitPathKey(pathKey));
  }

  /**
   * Updates one path and notifies only affected subscribers.
   */
  function set(path: BoltRuntimePath, valueOrUpdater: unknown) {
    // Normalize once so the same key drives both state lookup and notification.
    const pathKey = normalizePath(path);
    const segments = splitPathKey(pathKey);
    const previousState = state;

    // Root updates replace the whole state. Nested updates clone only the root
    // and changed path ancestors so path snapshots stay React-safe.
    if (segments.length === 0) {
      state = resolveValue(valueOrUpdater, state) as TState;
    } else {
      state = writeImmutablePath(state, segments, valueOrUpdater);
    }

    // If the root reference did not change, React has nothing new to read.
    if (state === previousState) {
      return;
    }

    // Whole-store replacement can affect every selected path. Nested writes only
    // wake the root listener and listeners registered on updated path prefixes.
    if (segments.length === 0) {
      notifyAll(listenersByPath);
      return;
    }

    notifyPrefixes(listenersByPath, pathKey);
  }

  /**
   * Public subscribe method that accepts any supported path input.
   */
  function subscribe(path: BoltRuntimePath | undefined, listener: Listener) {
    return subscribePathKey(normalizePath(path), listener);
  }

  /**
   * Internal subscribe method for already-normalized path keys.
   */
  function subscribePathKey(pathKey: string, listener: Listener) {
    let listeners = listenersByPath.get(pathKey);

    if (!listeners) {
      // Listener buckets are created lazily so unused paths cost nothing.
      listeners = new Set();
      listenersByPath.set(pathKey, listeners);
    }

    listeners.add(listener);

    // React calls this cleanup when a component unsubscribes or changes paths.
    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) {
        // Delete empty buckets to keep long-lived stores from accumulating
        // abandoned path keys.
        listenersByPath.delete(pathKey);
      }
    };
  }

  // Cast public get/set overloads at the boundary; the runtime implementation is
  // path-agnostic and the exported API carries the type safety.
  return {
    get: get as BoltStoreApi<TState>["get"],
    getByPathKey,
    getState,
    set: set as BoltStoreApi<TState>["set"],
    subscribe,
    subscribePathKey,
  };
}
