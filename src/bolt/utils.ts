/**
 * Runtime utility functions for Bolt path normalization, path reads/writes, and
 * listener dispatch.
 */
import get from "lodash/get";
import set from "lodash/set";
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
 * Writes a value into a Mutative draft at the provided path.
 *
 * Missing intermediate branches are created as objects or arrays based on the
 * next path segment, which lets set("a.0.b", value) build an array at a.
 */
export function writePath(
  draft: unknown,
  segments: readonly string[],
  valueOrUpdater: unknown,
) {
  // Read before writing so updater functions receive the current path value.
  const previousValue = get(draft, segments);
  const nextValue = resolveValue(valueOrUpdater, previousValue);

  // Mutative gives us a mutable draft. lodash/set performs the nested write and
  // creates missing object/array containers using lodash's path rules.
  set(draft as object, segments, nextValue);
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
