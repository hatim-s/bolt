/**
 * Runtime utility functions for Bolt path normalization, path reads/writes, and
 * listener dispatch.
 */
import get from "lodash/get";
import type { BoltRuntimePath, Listener } from "./types";

/**
 * Reads a path from any object-like value.
 *
 * Missing intermediate values return undefined instead of throwing, matching
 * lodash-style path access.
 */
export function readPath(value: unknown, segments: readonly string[]) {
  // Empty segment list represents the whole store, so return the input as-is.
  return segments.length === 0 ? value : get(value, segments);
}

/**
 * Returns a new root with one path immutably replaced.
 *
 * Missing intermediate branches are created as objects or arrays based on the
 * next path segment, which lets set("a.0.b", value) build an array at a.
 */
export function writeImmutablePath<TState>(
  root: TState,
  segments: readonly string[],
  valueOrUpdater: unknown,
): TState {
  // Read before writing so updater functions receive the current path value.
  const previousValue = get(root, segments);
  const leafExists = hasPath(root, segments);
  const { nextValue, forceChange } = resolvePathValue(
    valueOrUpdater,
    previousValue,
  );

  if (leafExists && !forceChange && Object.is(previousValue, nextValue)) {
    return root;
  }

  const nextRoot = cloneContainer(root) as TState;
  let previousCursor: unknown = root;
  let nextCursor = nextRoot as Indexable;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const previousChild = isIndexable(previousCursor)
      ? previousCursor[segment]
      : undefined;
    const nextChild = isIndexable(previousChild)
      ? cloneContainer(previousChild)
      : createContainerForSegment(nextSegment);

    nextCursor[segment] = nextChild;
    previousCursor = previousChild;
    nextCursor = nextChild as Indexable;
  }

  nextCursor[segments[segments.length - 1]] = nextValue;

  return nextRoot;
}

/**
 * Applies direct values and updater functions with the same set API.
 */
export function resolveValue(valueOrUpdater: unknown, previousValue: unknown) {
  // Treat functions as updater callbacks; all other inputs are direct values.
  return typeof valueOrUpdater === "function"
    ? (valueOrUpdater as (previous: unknown) => unknown)(previousValue)
    : valueOrUpdater;
}

function resolvePathValue(
  valueOrUpdater: unknown,
  previousValue: unknown,
): { nextValue: unknown; forceChange: boolean } {
  if (typeof valueOrUpdater !== "function") {
    return { nextValue: valueOrUpdater, forceChange: false };
  }

  if (!isDraftable(previousValue)) {
    return {
      nextValue: (valueOrUpdater as (previous: unknown) => unknown)(
        previousValue,
      ),
      forceChange: false,
    };
  }

  const draft = cloneDraftValue(previousValue);
  const tracker = createMutationTracker();
  const draftProxy = trackDraft(draft, tracker);
  const returnedValue = (valueOrUpdater as (previous: unknown) => unknown)(
    draftProxy,
  );
  const nextValue = unwrapTrackedValue(returnedValue, tracker);

  if (!tracker.mutated && Object.is(nextValue, draft)) {
    return { nextValue: previousValue, forceChange: false };
  }

  return { nextValue, forceChange: tracker.mutated };
}

/**
 * Notifies listeners for the root and every prefix of one updated path.
 *
 * For a.b.c, Bolt wakes "", "a", "a.b", and "a.b.c" only.
 */
export function notifyPrefixes(
  listenersByPath: Map<string, Set<Listener>>,
  pathKey: string,
) {
  // The whole-store subscriber always sees every nested write.
  notifyPath(listenersByPath, "");

  let prefix = "";

  for (const segment of splitPathKey(pathKey)) {
    // Grow one prefix per segment: a -> a.b -> a.b.c.
    prefix = prefix ? `${prefix}.${segment}` : segment;
    notifyPath(listenersByPath, prefix);
  }
}

/**
 * Notifies every unique listener after a whole-store replacement.
 */
export function notifyAll(listenersByPath: Map<string, Set<Listener>>) {
  // A listener can be subscribed to multiple paths. Deduplicate so root
  // replacement calls each listener at most once.
  const listeners = new Set<Listener>();

  for (const pathListeners of listenersByPath.values()) {
    for (const listener of pathListeners) {
      listeners.add(listener);
    }
  }

  listeners.forEach((listener) => listener());
}

/**
 * Converts all accepted path inputs into Bolt's canonical dot path key.
 */
export function normalizePath(path?: BoltRuntimePath) {
  // The normalized key is the Map key used for both subscriptions and reads.
  return toSegments(path).join(".");
}

/**
 * Splits Bolt's canonical dot path key back into segments.
 *
 * The empty string is reserved for the whole-store subscription and must remain
 * an empty segment list.
 */
export function splitPathKey(pathKey: string) {
  // pathKey.split(".") would return [""] for root, which would incorrectly
  // read state[""] instead of the whole store.
  return pathKey === "" ? [] : pathKey.split(".");
}

/**
 * Notifies listeners registered for one exact canonical path key.
 */
function notifyPath(
  listenersByPath: Map<string, Set<Listener>>,
  pathKey: string,
) {
  const listeners = listenersByPath.get(pathKey);

  if (!listeners) {
    // No subscribers for this exact path, so dispatch is a no-op.
    return;
  }

  // Copy before iterating so unsubscribe calls during notification cannot
  // mutate the Set being traversed.
  [...listeners].forEach((listener) => listener());
}

/**
 * Converts external path input into string segments before canonicalization.
 *
 * Numeric array segments are stringified so ["items", 0, "name"] and
 * "items.0.name" share the same listener bucket.
 */
function toSegments(path?: BoltRuntimePath) {
  if (!path) {
    // undefined and "" both mean "the root store".
    return [];
  }

  // String paths are already dot-delimited. Array paths preserve caller-provided
  // segment boundaries, then stringify numeric segments for canonical keys.
  return typeof path === "string" ? path.split(".") : path.map(String);
}

type Indexable = Record<string, unknown>;
type MutationTracker = {
  mutated: boolean;
  proxiesByTarget: WeakMap<object, object>;
  targetsByProxy: WeakMap<object, object>;
};

function cloneContainer(value: unknown): unknown[] | Indexable {
  if (Array.isArray(value)) {
    return value.slice();
  }

  return { ...(value as Indexable) };
}

function createContainerForSegment(segment: string) {
  return isArrayIndex(segment) ? [] : {};
}

function cloneDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneDraftValue);
  }

  if (isPlainObject(value)) {
    const clone: Indexable = {};

    for (const [key, childValue] of Object.entries(value)) {
      clone[key] = cloneDraftValue(childValue);
    }

    return clone;
  }

  return value;
}

function createMutationTracker(): MutationTracker {
  return {
    mutated: false,
    proxiesByTarget: new WeakMap(),
    targetsByProxy: new WeakMap(),
  };
}

function trackDraft(value: unknown, tracker: MutationTracker): unknown {
  if (!isDraftable(value)) {
    return value;
  }

  const existingProxy = tracker.proxiesByTarget.get(value);

  if (existingProxy) {
    return existingProxy;
  }

  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      return trackDraft(Reflect.get(target, property, receiver), tracker);
    },
    set(target, property, childValue, receiver) {
      tracker.mutated = true;
      return Reflect.set(
        target,
        property,
        unwrapTrackedValue(childValue, tracker),
        receiver,
      );
    },
    deleteProperty(target, property) {
      tracker.mutated = true;
      return Reflect.deleteProperty(target, property);
    },
  });

  tracker.proxiesByTarget.set(value, proxy);
  tracker.targetsByProxy.set(proxy, value);

  return proxy;
}

function unwrapTrackedValue(value: unknown, tracker: MutationTracker): unknown {
  return isObject(value) ? (tracker.targetsByProxy.get(value) ?? value) : value;
}

function hasPath(value: unknown, segments: readonly string[]) {
  let cursor = value;

  for (const segment of segments) {
    if (!isIndexable(cursor) || !(segment in cursor)) {
      return false;
    }

    cursor = cursor[segment];
  }

  return true;
}

function isIndexable(value: unknown): value is Indexable {
  return isObject(value);
}

function isDraftable(value: unknown): value is object {
  return Array.isArray(value) || isPlainObject(value);
}

function isPlainObject(value: unknown): value is Indexable {
  if (!isObject(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObject(value: unknown): value is Indexable {
  return typeof value === "object" && value !== null;
}

function isArrayIndex(segment: string) {
  return /^(0|[1-9]\d*)$/.test(segment);
}
