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
  BoltDeriveCompute,
  BoltPath,
  BoltPathValue,
  BoltValueOrUpdater,
  BoltProviderProps,
  BoltReactApi,
  BoltRuntimePath,
  BoltStoreApi,
  BoltUseStore,
  InternalBoltStore,
  Listener,
} from "./types";
import {
  notifyChangedPaths,
  normalizePath,
  notifyAll,
  notifyPrefixes,
  pathsOverlap,
  readPath,
  resolveImmutableValue,
  splitPathKey,
  writeImmutablePath,
} from "./utils";

// Re-export public types from the runtime entry so consumers can import both
// values and types from "bolt".
export type {
  BoltBoundSet,
  BoltDerive,
  BoltDeriveCompute,
  BoltDerivedContext,
  BoltDeriveOptions,
  BoltPath,
  BoltPathValue,
  BoltProviderProps,
  BoltReactApi,
  BoltRuntimePath,
  BoltStoreApi,
  BoltUseStore,
  BoltValueOrUpdater,
} from "./types";

type DerivedNode<TState extends object> = {
  id: number;
  targetPathKey: string;
  targetSegments: readonly string[];
  sourcePathKeys: readonly string[];
  compute: BoltDeriveCompute<TState, unknown>;
  equality: (previous: unknown, next: unknown) => boolean;
  manualWrites: "reject" | "allow";
};

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
  ): [
    BoltPathValue<TState, Path>,
    (valueOrUpdater: BoltValueOrUpdater<BoltPathValue<TState, Path>>) => void,
  ];

  /**
   * Subscribes React to one path and returns that path's current snapshot.
   */
  function useStore(path?: BoltRuntimePath) {
    const store = useInternalApi();
    const pathKey = normalizePath(path);
    const hasBoundPath = path !== undefined;

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

    const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const setValue = useCallback(
      (valueOrUpdater: unknown) => {
        store.set(pathKey as BoltPath<TState>, valueOrUpdater as never);
      },
      [pathKey, store],
    );

    return hasBoundPath ? [value, setValue] : value;
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
  const derivedByTarget = new Map<string, DerivedNode<TState>>();
  const derivedNodes = new Map<number, DerivedNode<TState>>();
  let nextDerivedId = 1;
  let isComputingDerived = false;

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
    if (isComputingDerived) {
      throw new Error("Bolt derived compute functions cannot call set().");
    }

    // Normalize once so the same key drives both state lookup and notification.
    const pathKey = normalizePath(path);
    const derivedOwner = derivedByTarget.get(pathKey);

    if (derivedOwner?.manualWrites === "reject") {
      throw new Error(
        `Bolt derived target "${pathKey}" cannot be set directly. Write an input/override path or register with manualWrites: "allow".`,
      );
    }

    const didChange = writePathKey(pathKey, valueOrUpdater);

    if (!didChange) {
      return;
    }

    if (derivedNodes.size === 0) {
      if (pathKey === "") {
        notifyAll(listenersByPath);
        return;
      }

      notifyPrefixes(listenersByPath, pathKey);
      return;
    }

    const changedPathKeys = new Set([pathKey]);
    const derivedChangedPathKeys = settleDerived(changedPathKeys);

    for (const derivedPathKey of derivedChangedPathKeys) {
      changedPathKeys.add(derivedPathKey);
    }

    notifyChangedPaths(listenersByPath, changedPathKeys);
  }

  /**
   * Writes one normalized path without notifying subscribers.
   */
  function writePathKey(
    pathKey: string,
    valueOrUpdater: unknown,
    resolveUpdater = true,
  ) {
    const segments = splitPathKey(pathKey);
    const previousState = state;

    // Root updates replace the whole state. Nested updates clone only the root
    // and changed path ancestors so path snapshots stay React-safe.
    if (segments.length === 0) {
      state = (
        resolveImmutableValue(valueOrUpdater, state, resolveUpdater)
      ) as TState;
    } else {
      state = writeImmutablePath(state, segments, valueOrUpdater, resolveUpdater);
    }

    // If the root reference did not change, React has nothing new to read.
    return state !== previousState;
  }

  function derive<TargetPath extends BoltPath<TState>>(
    targetPath: TargetPath,
    sourcePaths: readonly BoltRuntimePath[],
    compute: BoltDeriveCompute<TState, BoltPathValue<TState, TargetPath>>,
    options?: {
      equality?: (
        previous: BoltPathValue<TState, TargetPath>,
        next: BoltPathValue<TState, TargetPath>,
      ) => boolean;
      initialize?: boolean;
      manualWrites?: "reject" | "allow";
    },
  ) {
    const targetPathKey = normalizePath(targetPath);
    const sourcePathKeys = [...new Set(sourcePaths.map((path) => normalizePath(path)))];

    if (derivedByTarget.has(targetPathKey)) {
      throw new Error(`Bolt derived target "${targetPathKey}" is already registered.`);
    }

    const overlappingSource = sourcePathKeys.find((sourcePathKey) =>
      pathsOverlap(targetPathKey, sourcePathKey),
    );

    if (overlappingSource !== undefined) {
      throw new Error(
        `Bolt derived target "${targetPathKey}" cannot depend on overlapping source "${overlappingSource}".`,
      );
    }

    const node: DerivedNode<TState> = {
      id: nextDerivedId++,
      targetPathKey,
      targetSegments: splitPathKey(targetPathKey),
      sourcePathKeys,
      compute: compute as BoltDeriveCompute<TState, unknown>,
      equality: (options?.equality ?? Object.is) as (
        previous: unknown,
        next: unknown,
      ) => boolean,
      manualWrites: options?.manualWrites ?? "reject",
    };

    derivedNodes.set(node.id, node);
    derivedByTarget.set(targetPathKey, node);

    try {
      validateDerivedGraph();

      if (options?.initialize !== false) {
        const changedPathKeys = new Set<string>();

        if (computeAndWriteDerivedNode(node, changedPathKeys)) {
          changedPathKeys.add(node.targetPathKey);

          for (const downstreamPathKey of settleDerived(changedPathKeys)) {
            changedPathKeys.add(downstreamPathKey);
          }

          notifyChangedPaths(listenersByPath, changedPathKeys);
        }
      }
    } catch (error) {
      derivedNodes.delete(node.id);
      derivedByTarget.delete(targetPathKey);
      throw error;
    }

    let disposed = false;

    return () => {
      if (disposed) {
        return;
      }

      disposed = true;
      derivedNodes.delete(node.id);
      derivedByTarget.delete(targetPathKey);
    };
  }

  function validateDerivedGraph() {
    topologicallySortDerivedNodes([...derivedNodes.values()]);
  }

  function settleDerived(initialChangedPathKeys: ReadonlySet<string>) {
    const affectedNodes = collectTransitiveAffectedNodes(initialChangedPathKeys);
    const changedPathKeys = new Set(initialChangedPathKeys);
    const derivedChangedPathKeys = new Set<string>();

    if (affectedNodes.length === 0) {
      return derivedChangedPathKeys;
    }

    for (const node of topologicallySortDerivedNodes(affectedNodes)) {
      if (computeAndWriteDerivedNode(node, changedPathKeys)) {
        changedPathKeys.add(node.targetPathKey);
        derivedChangedPathKeys.add(node.targetPathKey);
      }
    }

    return derivedChangedPathKeys;
  }

  function collectTransitiveAffectedNodes(
    initialChangedPathKeys: ReadonlySet<string>,
  ) {
    const queue = [...initialChangedPathKeys];
    const seenChangeKeys = new Set(queue);
    const affectedNodes = new Map<number, DerivedNode<TState>>();

    for (let index = 0; index < queue.length; index += 1) {
      const changedPathKey = queue[index];

      for (const node of derivedNodes.values()) {
        if (affectedNodes.has(node.id)) {
          continue;
        }

        const isAffected = node.sourcePathKeys.some((sourcePathKey) =>
          pathsOverlap(sourcePathKey, changedPathKey),
        );

        if (!isAffected) {
          continue;
        }

        affectedNodes.set(node.id, node);

        if (!seenChangeKeys.has(node.targetPathKey)) {
          seenChangeKeys.add(node.targetPathKey);
          queue.push(node.targetPathKey);
        }
      }
    }

    return [...affectedNodes.values()];
  }

  function topologicallySortDerivedNodes(nodes: readonly DerivedNode<TState>[]) {
    const visiting = new Set<number>();
    const visited = new Set<number>();
    const stack: DerivedNode<TState>[] = [];
    const ordered: DerivedNode<TState>[] = [];
    const sortedNodes = [...nodes].sort((a, b) => a.id - b.id);

    function visit(node: DerivedNode<TState>) {
      if (visited.has(node.id)) {
        return;
      }

      if (visiting.has(node.id)) {
        const cycleStart = stack.findIndex((stackNode) => stackNode.id === node.id);
        const cyclePath = [...stack.slice(cycleStart), node]
          .map((cycleNode) => formatPathKey(cycleNode.targetPathKey))
          .join(" -> ");

        throw new Error(`Bolt derived cycle: ${cyclePath}`);
      }

      visiting.add(node.id);
      stack.push(node);

      for (const dependency of sortedNodes) {
        if (dependency.id === node.id) {
          continue;
        }

        const dependsOnNode = node.sourcePathKeys.some((sourcePathKey) =>
          pathsOverlap(dependency.targetPathKey, sourcePathKey),
        );

        if (dependsOnNode) {
          visit(dependency);
        }
      }

      stack.pop();
      visiting.delete(node.id);
      visited.add(node.id);
      ordered.push(node);
    }

    for (const node of sortedNodes) {
      visit(node);
    }

    return ordered;
  }

  function computeAndWriteDerivedNode(
    node: DerivedNode<TState>,
    changedPathKeys: ReadonlySet<string>,
  ) {
    const previous = readPath(state, node.targetSegments);
    const next = computeDerivedValue(node, previous, changedPathKeys);

    if (node.equality(previous, next)) {
      return false;
    }

    return writePathKey(node.targetPathKey, next, false);
  }

  function computeDerivedValue(
    node: DerivedNode<TState>,
    previous: unknown,
    changedPathKeys: ReadonlySet<string>,
  ) {
    isComputingDerived = true;

    try {
      return node.compute({
        get: get as BoltStoreApi<TState>["get"],
        getState,
        previous,
        targetPath: node.targetPathKey,
        sourcePaths: node.sourcePathKeys,
        changedPaths: [...changedPathKeys],
      });
    } finally {
      isComputingDerived = false;
    }
  }

  function formatPathKey(pathKey: string) {
    return pathKey === "" ? "<root>" : pathKey;
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
    derive: derive as BoltStoreApi<TState>["derive"],
    set: set as BoltStoreApi<TState>["set"],
    subscribe,
    subscribePathKey,
  };
}
