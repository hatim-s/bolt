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
  BoltDerivedStoreApi,
  BoltPath,
  BoltPathValue,
  BoltValueOrUpdater,
  BoltProviderProps,
  BoltReactApi,
  BoltRuntimePath,
  BoltUnsafeDeriveCompute,
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
  createImmutablePathWriteBatch,
  type ImmutablePathWriteBatch,
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
  BoltDerivedStoreApi,
  BoltDeriveOptions,
  BoltPath,
  BoltPathValue,
  BoltProviderProps,
  BoltReactApi,
  BoltRuntimePath,
  BoltStoreApi,
  BoltUnsafeDerive,
  BoltUnsafeDeriveCompute,
  BoltUnsafeDerivedContext,
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

type PathIndexNode = {
  derivedIds: Set<number>;
  children: Map<string, PathIndexNode>;
};

/**
 * Creates a standalone Bolt store without React.
 *
 * This is useful for tests, non-React consumers, or integration code that wants
 * the same path-indexed subscription behavior without a provider.
 */
export function createBoltStore<TState extends object>(
  initialState: TState,
): BoltDerivedStoreApi<TState> {
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
  function useApi(): BoltDerivedStoreApi<TState> {
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
  const sourceIndexRoot = createPathIndexNode();
  const targetIndexRoot = createPathIndexNode();
  const downstreamByNodeId = new Map<number, Set<number>>();
  const upstreamByNodeId = new Map<number, Set<number>>();
  let nextDerivedId = 1;
  let derivedExecutionDepth = 0;
  let isDispatchingNotifications = false;
  let isFlushingDeferredWrites = false;
  const pendingNotificationBatches: Set<string>[] = [];
  const deferredWrites: Array<() => void> = [];
  let activeDerivedWriteBatch: ImmutablePathWriteBatch<TState> | undefined;

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
    if (derivedExecutionDepth > 0) {
      throw new Error("Bolt derived callbacks cannot call set().");
    }

    // A listener observes one fully settled transaction. Writes it triggers are
    // serialized after the current notification batch instead of interleaving
    // snapshots seen by later listeners in that batch.
    if (isDispatchingNotifications) {
      deferredWrites.push(() => set(path, valueOrUpdater));
      return;
    }

    // Normalize once so the same key drives both state lookup and notification.
    const pathKey = normalizePath(path);
    const overlappingTargets = findOverlappingDerivedTargets(pathKey);
    const rejectingOwner = overlappingTargets.find(
      (node) => node.manualWrites === "reject",
    );

    if (rejectingOwner) {
      throw new Error(
        `Bolt derived target "${rejectingOwner.targetPathKey}" cannot be set directly. Write an input/override path or register with manualWrites: "allow".`,
      );
    }

    const previousState = state;
    const didChange = writePathKey(pathKey, valueOrUpdater);

    if (!didChange) {
      return;
    }

    if (derivedNodes.size === 0) {
      notifyLegacyPath(pathKey);
      return;
    }

    const changedPathKeys = new Set<string>([pathKey]);

    for (const node of overlappingTargets) {
      changedPathKeys.add(node.targetPathKey);
    }

    try {
      const derivedChangedPathKeys = settleDerived(changedPathKeys);

      for (const derivedPathKey of derivedChangedPathKeys) {
        changedPathKeys.add(derivedPathKey);
      }
    } catch (error) {
      state = previousState;
      throw error;
    }

    notifySettledPaths(changedPathKeys);
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

    if (!resolveUpdater && activeDerivedWriteBatch) {
      state = activeDerivedWriteBatch.write(segments, valueOrUpdater);
      // The batch deliberately keeps one working root reference across all
      // derived writes, while equality has already established this path value
      // changed.
      return true;
    }

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
    sourcePaths: readonly BoltPath<TState>[],
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
    return deriveInternal(
      targetPath,
      sourcePaths,
      compute as BoltDeriveCompute<TState, unknown>,
      options as
        | {
            equality?: (previous: unknown, next: unknown) => boolean;
            initialize?: boolean;
            manualWrites?: "reject" | "allow";
          }
        | undefined,
    );
  }

  function deriveUnsafe(
    targetPath: BoltRuntimePath,
    sourcePaths: readonly BoltRuntimePath[],
    compute: BoltUnsafeDeriveCompute<TState>,
    options?: {
      equality?: (previous: unknown, next: unknown) => boolean;
      initialize?: boolean;
      manualWrites?: "reject" | "allow";
    },
  ) {
    return deriveInternal(
      targetPath,
      sourcePaths,
      compute as BoltDeriveCompute<TState, unknown>,
      options,
    );
  }

  function deriveInternal(
    targetPath: BoltRuntimePath,
    sourcePaths: readonly BoltRuntimePath[],
    compute: BoltDeriveCompute<TState, unknown>,
    options?: {
      equality?: (previous: unknown, next: unknown) => boolean;
      initialize?: boolean;
      manualWrites?: "reject" | "allow";
    },
  ) {
    if (derivedExecutionDepth > 0) {
      throw new Error("Bolt derive() cannot be called inside a derived callback.");
    }

    const targetPathKey = normalizePath(targetPath);
    const sourcePathKeys = [...new Set(sourcePaths.map((path) => normalizePath(path)))];

    if (derivedByTarget.has(targetPathKey)) {
      throw new Error(`Bolt derived target "${targetPathKey}" is already registered.`);
    }

    const overlappingTarget = findOverlappingDerivedTargets(targetPathKey)[0];

    if (overlappingTarget) {
      throw new Error(
        `Bolt derived target "${targetPathKey}" overlaps existing derived target "${overlappingTarget.targetPathKey}".`,
      );
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
      compute,
      equality: options?.equality ?? Object.is,
      manualWrites: options?.manualWrites ?? "reject",
    };

    const previousState = state;

    try {
      const topology = registerDerivedNode(node);
      validateNewDerivedNode(node, topology);

      if (options?.initialize !== false) {
        const changedPathKeys = new Set<string>();

        if (computeAndWriteDerivedNode(node, changedPathKeys)) {
          changedPathKeys.add(node.targetPathKey);

          for (const downstreamPathKey of settleDerived(changedPathKeys)) {
            changedPathKeys.add(downstreamPathKey);
          }

          notifySettledPaths(changedPathKeys);
        }
      }
    } catch (error) {
      unregisterDerivedNode(node);
      state = previousState;
      throw error;
    }

    let disposed = false;

    return () => {
      if (derivedExecutionDepth > 0) {
        throw new Error("Bolt derived disposers cannot run inside a derived callback.");
      }

      if (disposed) {
        return;
      }

      disposed = true;
      unregisterDerivedNode(node);
    };
  }

  function settleDerived(initialChangedPathKeys: ReadonlySet<string>) {
    const changedPathKeys = new Set(initialChangedPathKeys);
    const derivedChangedPathKeys = new Set<string>();
    const pendingNodes = new Map<number, DerivedNode<TState>>();
    const previousBatch = activeDerivedWriteBatch;
    activeDerivedWriteBatch = createImmutablePathWriteBatch(state);

    try {
      enqueueAffectedNodes(initialChangedPathKeys, pendingNodes);

      while (pendingNodes.size > 0) {
        const orderedNodes = topologicallySortDerivedNodes([...pendingNodes.values()]);
        const currentIds = new Set(orderedNodes.map((node) => node.id));
        const processedIds = new Set<number>();
        pendingNodes.clear();

        for (const node of orderedNodes) {
          const didChange = computeAndWriteDerivedNode(node, changedPathKeys);

          processedIds.add(node.id);

          if (!didChange) {
            continue;
          }

          changedPathKeys.add(node.targetPathKey);
          derivedChangedPathKeys.add(node.targetPathKey);
          enqueueDownstreamNodes(node, pendingNodes, currentIds, processedIds);
        }
      }

      return derivedChangedPathKeys;
    } finally {
      activeDerivedWriteBatch = previousBatch;
    }
  }

  function enqueueAffectedNodes(
    changedPathKeys: Iterable<string>,
    target: Map<number, DerivedNode<TState>>,
  ) {
    for (const changedPathKey of changedPathKeys) {
      for (const node of findDependentsForChangedPath(changedPathKey)) {
        target.set(node.id, node);
      }
    }
  }

  function enqueueDownstreamNodes(
    node: DerivedNode<TState>,
    target: Map<number, DerivedNode<TState>>,
    currentIds: ReadonlySet<number>,
    processedIds: ReadonlySet<number>,
  ) {
    for (const downstreamId of downstreamByNodeId.get(node.id) ?? []) {
      if (currentIds.has(downstreamId) && !processedIds.has(downstreamId)) {
        continue;
      }

      const downstreamNode = derivedNodes.get(downstreamId);

      if (downstreamNode) {
        target.set(downstreamNode.id, downstreamNode);
      }
    }
  }

  function registerDerivedNode(node: DerivedNode<TState>) {
    // Discover only nodes connected to the new target/source paths. Scanning all
    // nodes here turns dynamic registration into O(n²).
    const producerIds = new Set<number>();

    for (const sourcePathKey of node.sourcePathKeys) {
      collectOverlappingPathIndexIds(targetIndexRoot, sourcePathKey, producerIds);
    }

    const consumerIds = new Set<number>();
    collectOverlappingPathIndexIds(sourceIndexRoot, node.targetPathKey, consumerIds);

    derivedNodes.set(node.id, node);
    derivedByTarget.set(node.targetPathKey, node);
    addPathIndexNode(targetIndexRoot, node.targetPathKey, node.id);

    for (const sourcePathKey of node.sourcePathKeys) {
      addPathIndexNode(sourceIndexRoot, sourcePathKey, node.id);
    }

    downstreamByNodeId.set(node.id, new Set());
    upstreamByNodeId.set(node.id, new Set());

    for (const producerId of producerIds) {
      addDownstreamEdge(producerId, node.id);
    }

    for (const consumerId of consumerIds) {
      addDownstreamEdge(node.id, consumerId);
    }

    return { consumerIds, producerIds };
  }

  function unregisterDerivedNode(node: DerivedNode<TState>) {
    derivedNodes.delete(node.id);
    derivedByTarget.delete(node.targetPathKey);
    removePathIndexNode(targetIndexRoot, node.targetPathKey, node.id);

    for (const sourcePathKey of node.sourcePathKeys) {
      removePathIndexNode(sourceIndexRoot, sourcePathKey, node.id);
    }

    for (const producerId of upstreamByNodeId.get(node.id) ?? []) {
      downstreamByNodeId.get(producerId)?.delete(node.id);
    }

    for (const consumerId of downstreamByNodeId.get(node.id) ?? []) {
      upstreamByNodeId.get(consumerId)?.delete(node.id);
    }

    downstreamByNodeId.delete(node.id);
    upstreamByNodeId.delete(node.id);
  }

  function validateNewDerivedNode(
    node: DerivedNode<TState>,
    topology: { consumerIds: ReadonlySet<number>; producerIds: ReadonlySet<number> },
  ) {
    // A newly registered node can only close a cycle if it bridges an existing
    // producer to an existing consumer. Pure forward or reverse chain growth
    // has one empty side, so it is cycle-safe without walking the full suffix.
    if (topology.producerIds.size === 0 || topology.consumerIds.size === 0) {
      return;
    }

    for (const consumerId of topology.consumerIds) {
      for (const producerId of topology.producerIds) {
        const path = findDownstreamPath(consumerId, producerId);

        if (path) {
          const formattedPath = [node.id, ...path, node.id]
            .map((id) => formatPathKey(derivedNodes.get(id)?.targetPathKey ?? `${id}`))
            .join(" -> ");
          throw new Error(`Bolt derived cycle: ${formattedPath}`);
        }
      }
    }
  }

  function topologicallySortDerivedNodes(nodes: readonly DerivedNode<TState>[]) {
    const ordered: DerivedNode<TState>[] = [];
    const nodeIds = new Set(nodes.map((node) => node.id));
    const indegreeById = new Map<number, number>();
    const ready: DerivedNode<TState>[] = [];

    for (const node of nodes) {
      indegreeById.set(node.id, 0);
    }

    for (const node of nodes) {
      for (const downstreamId of downstreamByNodeId.get(node.id) ?? []) {
        if (nodeIds.has(downstreamId)) {
          indegreeById.set(downstreamId, (indegreeById.get(downstreamId) ?? 0) + 1);
        }
      }
    }

    for (const node of nodes) {
      if (indegreeById.get(node.id) === 0) {
        ready.push(node);
      }
    }

    // `nodes` comes from insertion-ordered Maps and downstream Sets, so this
    // FIFO preserves deterministic registration order without re-sorting or
    // shifting an array for every node.
    for (let readyIndex = 0; readyIndex < ready.length; readyIndex += 1) {
      const node = ready[readyIndex];
      ordered.push(node);

      for (const downstreamId of downstreamByNodeId.get(node.id) ?? []) {
        if (!nodeIds.has(downstreamId)) {
          continue;
        }

        const nextIndegree = (indegreeById.get(downstreamId) ?? 0) - 1;
        indegreeById.set(downstreamId, nextIndegree);

        if (nextIndegree === 0) {
          const downstreamNode = derivedNodes.get(downstreamId);

          if (downstreamNode) {
            ready.push(downstreamNode);
          }
        }
      }
    }

    if (ordered.length !== nodes.length) {
      throw new Error("Bolt derived cycle detected.");
    }

    return ordered;
  }

  function computeAndWriteDerivedNode(
    node: DerivedNode<TState>,
    changedPathKeys: ReadonlySet<string>,
  ) {
    const previous = readPath(state, node.targetSegments);
    const { next, isEqual } = evaluateDerivedNode(node, previous, changedPathKeys);

    if (isEqual) {
      return false;
    }

    return writePathKey(node.targetPathKey, next, false);
  }

  function evaluateDerivedNode(
    node: DerivedNode<TState>,
    previous: unknown,
    changedPathKeys: ReadonlySet<string>,
  ) {
    derivedExecutionDepth += 1;

    try {
      const next = node.compute({
        get: get as BoltDerivedStoreApi<TState>["get"],
        getState,
        previous,
        targetPath: node.targetPathKey,
        sourcePaths: node.sourcePathKeys,
        changedPaths: [...changedPathKeys],
      });

      return { next, isEqual: node.equality(previous, next) };
    } finally {
      derivedExecutionDepth -= 1;
    }
  }

  function findDependentsForChangedPath(pathKey: string) {
    const dependentIds = new Set<number>();

    collectOverlappingPathIndexIds(sourceIndexRoot, pathKey, dependentIds);

    return [...dependentIds]
      .map((id) => derivedNodes.get(id))
      .filter((node): node is DerivedNode<TState> => !!node);
  }

  function findOverlappingDerivedTargets(pathKey: string) {
    const targetIds = new Set<number>();

    collectOverlappingPathIndexIds(targetIndexRoot, pathKey, targetIds);

    return [...targetIds]
      .map((id) => derivedNodes.get(id))
      .filter((node): node is DerivedNode<TState> => !!node);
  }

  function addDownstreamEdge(producerId: number, dependentId: number) {
    let downstreamIds = downstreamByNodeId.get(producerId);

    if (!downstreamIds) {
      downstreamIds = new Set();
      downstreamByNodeId.set(producerId, downstreamIds);
    }

    downstreamIds.add(dependentId);
    let upstreamIds = upstreamByNodeId.get(dependentId);

    if (!upstreamIds) {
      upstreamIds = new Set();
      upstreamByNodeId.set(dependentId, upstreamIds);
    }

    upstreamIds.add(producerId);
  }

  function findDownstreamPath(startId: number, targetId: number) {
    const parents = new Map<number, number | undefined>([[startId, undefined]]);
    const queue = [startId];

    for (let index = 0; index < queue.length; index += 1) {
      const nodeId = queue[index];

      if (nodeId === targetId) {
        const path: number[] = [];

        for (let cursor: number | undefined = nodeId; cursor !== undefined; ) {
          path.push(cursor);
          cursor = parents.get(cursor);
        }

        return path.reverse();
      }

      for (const downstreamId of downstreamByNodeId.get(nodeId) ?? []) {
        if (!parents.has(downstreamId)) {
          parents.set(downstreamId, nodeId);
          queue.push(downstreamId);
        }
      }
    }

    return undefined;
  }

  function formatPathKey(pathKey: string) {
    return pathKey === "" ? "<root>" : pathKey;
  }

  function notifySettledPaths(changedPathKeys: Iterable<string>) {
    pendingNotificationBatches.push(new Set(changedPathKeys));

    if (isDispatchingNotifications) {
      return;
    }

    let completed = false;
    isDispatchingNotifications = true;

    try {
      for (
        let index = 0;
        index < pendingNotificationBatches.length;
        index += 1
      ) {
        notifyChangedPaths(listenersByPath, pendingNotificationBatches[index]);
      }
      completed = true;
    } finally {
      pendingNotificationBatches.length = 0;
      isDispatchingNotifications = false;

      if (!completed) {
        // A listener may have queued writes before another listener throws.
        // Those writes belong to the failed notification transaction and must
        // never leak into a later, unrelated set().
        deferredWrites.length = 0;
      }
    }

    if (completed) {
      flushDeferredWrites();
    }
  }

  function notifyLegacyPath(pathKey: string) {
    let completed = false;
    isDispatchingNotifications = true;

    try {
      if (pathKey === "") {
        notifyAll(listenersByPath);
      } else {
        notifyPrefixes(listenersByPath, pathKey);
      }
      completed = true;
    } finally {
      isDispatchingNotifications = false;

      if (!completed) {
        deferredWrites.length = 0;
      }
    }

    if (completed) {
      flushDeferredWrites();
    }
  }

  function flushDeferredWrites() {
    if (isFlushingDeferredWrites) {
      return;
    }

    isFlushingDeferredWrites = true;

    try {
      for (let index = 0; index < deferredWrites.length; index += 1) {
        deferredWrites[index]();
      }
    } finally {
      deferredWrites.length = 0;
      isFlushingDeferredWrites = false;
    }
  }

  function createPathIndexNode(): PathIndexNode {
    return {
      derivedIds: new Set(),
      children: new Map(),
    };
  }

  function addPathIndexNode(
    root: PathIndexNode,
    pathKey: string,
    derivedId: number,
  ) {
    let current = root;

    for (const segment of splitPathKey(pathKey)) {
      let child = current.children.get(segment);

      if (!child) {
        child = createPathIndexNode();
        current.children.set(segment, child);
      }

      current = child;
    }

    current.derivedIds.add(derivedId);
  }

  function removePathIndexNode(
    root: PathIndexNode,
    pathKey: string,
    derivedId: number,
  ) {
    const stack: Array<[PathIndexNode, string]> = [];
    let current = root;

    for (const segment of splitPathKey(pathKey)) {
      const child = current.children.get(segment);

      if (!child) {
        return;
      }

      stack.push([current, segment]);
      current = child;
    }

    current.derivedIds.delete(derivedId);

    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const [parent, segment] = stack[index];
      const child = parent.children.get(segment);

      if (!child || child.derivedIds.size > 0 || child.children.size > 0) {
        break;
      }

      parent.children.delete(segment);
    }
  }

  function collectOverlappingPathIndexIds(
    root: PathIndexNode,
    pathKey: string,
    target: Set<number>,
  ) {
    if (pathKey === "") {
      collectPathIndexSubtree(root, target);
      return;
    }

    let current: PathIndexNode | undefined = root;

    for (const id of root.derivedIds) {
      target.add(id);
    }

    for (const segment of splitPathKey(pathKey)) {
      current = current?.children.get(segment);

      if (!current) {
        return;
      }

      for (const id of current.derivedIds) {
        target.add(id);
      }
    }

    for (const child of current.children.values()) {
      collectPathIndexSubtree(child, target);
    }
  }

  function collectPathIndexSubtree(node: PathIndexNode, target: Set<number>) {
    for (const id of node.derivedIds) {
      target.add(id);
    }

    for (const child of node.children.values()) {
      collectPathIndexSubtree(child, target);
    }
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
    get: get as BoltDerivedStoreApi<TState>["get"],
    getByPathKey,
    getState,
    derive: derive as BoltDerivedStoreApi<TState>["derive"],
    deriveUnsafe: deriveUnsafe as BoltDerivedStoreApi<TState>["deriveUnsafe"],
    set: set as BoltDerivedStoreApi<TState>["set"],
    subscribe,
    subscribePathKey,
  };
}
