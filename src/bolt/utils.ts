/**
 * Runtime utility functions for Bolt path normalization, path reads/writes, and
 * listener dispatch.
 */
import get from "lodash/get";
import { create } from "mutative";
import type { BoltRuntimePath, Listener } from "./types";

export function readPath(value: unknown, segments: readonly string[]) {
  return segments.length === 0 ? value : get(value, segments);
}

/**
 * Replaces a nested value without mutating the current snapshot. Direct path
 * writes copy only the root and the containers on the written path.
 */
export function writeImmutablePath<TState>(
  root: TState,
  segments: readonly string[],
  valueOrUpdater: unknown,
  resolveUpdater = true,
): TState {
  assertSafePathSegments(segments);

  const previousValue = readOwnPath(root, segments);
  const leafExists = hasPath(root, segments);
  const nextValue = resolveImmutableValue(
    valueOrUpdater,
    previousValue,
    resolveUpdater,
  );

  if (leafExists && Object.is(previousValue, nextValue)) {
    return root;
  }

  const nextRoot = cloneContainer(root) as TState;
  let previousCursor: unknown = root;
  let nextCursor = nextRoot as Indexable;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const previousChild = readOwnProperty(previousCursor, segment);
    const nextChild = isPathContainer(previousChild)
      ? cloneContainer(previousChild)
      : createContainerForSegment(nextSegment);

    defineOwnValue(nextCursor, segment, nextChild);
    previousCursor = previousChild;
    nextCursor = nextChild as Indexable;
  }

  defineOwnValue(nextCursor, segments[segments.length - 1], nextValue);
  return nextRoot;
}

export function resolveValue(valueOrUpdater: unknown, previousValue: unknown) {
  return typeof valueOrUpdater === "function"
    ? (valueOrUpdater as (previous: unknown) => unknown)(previousValue)
    : valueOrUpdater;
}

/**
 * Runs object updaters through Mutative's lazy copy-on-write draft. Graphs
 * that cannot retain Bolt's snapshot guarantees are rejected before the
 * callback is invoked; callers can always replace those values directly.
 */
export function resolveImmutableValue(
  valueOrUpdater: unknown,
  previousValue: unknown,
  resolveUpdater = true,
) {
  if (!resolveUpdater || typeof valueOrUpdater !== "function") {
    return valueOrUpdater;
  }

  if (!isDraftable(previousValue)) {
    if (isObject(previousValue)) {
      throw new TypeError(
        `Bolt cannot safely draft ${describeValue(previousValue)}; use a direct replacement instead.`,
      );
    }

    return (valueOrUpdater as (previous: unknown) => unknown)(previousValue);
  }

  const graph = inspectDraftGraph(previousValue);

  if (graph.unsupported) {
    throw new TypeError(
      `Bolt cannot safely draft ${graph.unsupported}; use a direct replacement instead.`,
    );
  }

  if (graph.hasAliasesOrCycles) {
    throw new TypeError(
      "Bolt cannot safely draft graphs with cycles or shared references; use a direct replacement instead.",
    );
  }

  return create(
    previousValue,
    (draft) =>
      (valueOrUpdater as (previous: unknown) => unknown)(draft) as
        | object
        | void,
    { strict: true },
  );
}

export function notifyPrefixes(
  listenersByPath: Map<string, Set<Listener>>,
  pathKey: string,
) {
  notifyPath(listenersByPath, "");

  let prefix = "";

  for (const segment of splitPathKey(pathKey)) {
    prefix = prefix ? `${prefix}.${segment}` : segment;
    notifyPath(listenersByPath, prefix);
  }
}

export function notifyAll(listenersByPath: Map<string, Set<Listener>>) {
  notifyChangedPaths(listenersByPath, [""]);
}

/**
 * Batches notifications for all paths changed by one settled transaction.
 */
export function notifyChangedPaths(
  listenersByPath: Map<string, Set<Listener>>,
  changedPathKeys: Iterable<string>,
) {
  const listeners = new Set<Listener>();

  for (const pathKey of changedPathKeys) {
    if (pathKey === "") {
      collectAllListeners(listenersByPath, listeners);
      continue;
    }

    collectPathListeners(listenersByPath, "", listeners);

    for (const prefix of pathPrefixes(pathKey)) {
      collectPathListeners(listenersByPath, prefix, listeners);
    }
  }

  listeners.forEach((listener) => listener());
}

export function isPrefixPath(prefix: string, pathKey: string) {
  return prefix !== "" && pathKey.startsWith(`${prefix}.`);
}

export function pathsOverlap(a: string, b: string) {
  return (
    a === "" ||
    b === "" ||
    a === b ||
    isPrefixPath(a, b) ||
    isPrefixPath(b, a)
  );
}

export function pathPrefixes(pathKey: string) {
  const prefixes: string[] = [];
  let prefix = "";

  for (const segment of splitPathKey(pathKey)) {
    prefix = prefix ? `${prefix}.${segment}` : segment;
    prefixes.push(prefix);
  }

  return prefixes;
}

export function normalizePath(path?: BoltRuntimePath) {
  return toSegments(path).join(".");
}

export function splitPathKey(pathKey: string) {
  return pathKey === "" ? [] : pathKey.split(".");
}

function assertSafePathSegments(segments: readonly string[]) {
  for (const segment of segments) {
    if (
      segment === "__proto__" ||
      segment === "prototype" ||
      segment === "constructor"
    ) {
      throw new TypeError(`Unsafe Bolt path segment: ${segment}`);
    }
  }
}

function notifyPath(
  listenersByPath: Map<string, Set<Listener>>,
  pathKey: string,
) {
  const listeners = listenersByPath.get(pathKey);

  if (listeners) {
    [...listeners].forEach((listener) => listener());
  }
}

function collectPathListeners(
  listenersByPath: Map<string, Set<Listener>>,
  pathKey: string,
  target: Set<Listener>,
) {
  for (const listener of listenersByPath.get(pathKey) ?? []) {
    target.add(listener);
  }
}

function collectAllListeners(
  listenersByPath: Map<string, Set<Listener>>,
  target: Set<Listener>,
) {
  for (const listeners of listenersByPath.values()) {
    for (const listener of listeners) {
      target.add(listener);
    }
  }
}

function toSegments(path?: BoltRuntimePath) {
  if (!path) {
    return [];
  }

  return typeof path === "string" ? path.split(".") : path.map(String);
}

type Indexable = Record<string, unknown>;

function cloneContainer(value: unknown): unknown[] | Indexable {
  if (!isPathContainer(value)) {
    throw new TypeError(
      `Bolt cannot safely traverse ${describeValue(value as object)}; replace it directly instead.`,
    );
  }

  const clone: object = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(Object.getPrototypeOf(value));

  for (const property of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && property === "length") {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, property);

    if (descriptor) {
      Object.defineProperty(clone, property, descriptor);
    }
  }

  return clone as unknown[] | Indexable;
}

function createContainerForSegment(segment: string) {
  return isArrayIndex(segment) ? [] : {};
}

function readOwnPath(value: unknown, segments: readonly string[]) {
  let cursor = value;

  for (const segment of segments) {
    cursor = readOwnProperty(cursor, segment);
  }

  return cursor;
}

function readOwnProperty(value: unknown, property: string): unknown {
  if (!isIndexable(value) || !Object.hasOwn(value, property)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, property);

  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(
      `Bolt cannot safely traverse accessor property ${property}; replace its owning value directly instead.`,
    );
  }

  return descriptor.value;
}

function defineOwnValue(target: Indexable, property: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);

  if (!descriptor) {
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return;
  }

  if (!("value" in descriptor) || (!descriptor.writable && !descriptor.configurable)) {
    throw new TypeError(
      `Bolt cannot safely write non-writable or accessor property ${property}; replace its owning value directly instead.`,
    );
  }

  Object.defineProperty(target, property, { ...descriptor, value });
}

function hasPath(value: unknown, segments: readonly string[]) {
  let cursor = value;

  for (const segment of segments) {
    if (!isIndexable(cursor) || !Object.hasOwn(cursor, segment)) {
      return false;
    }

    cursor = readOwnProperty(cursor, segment);
  }

  return true;
}

function isIndexable(value: unknown): value is Indexable {
  return isObject(value);
}

function isDraftable(value: unknown): value is object {
  return Array.isArray(value) || value instanceof Map || value instanceof Set || isPlainObject(value);
}

function isPathContainer(value: unknown): value is object {
  return Array.isArray(value) || isPlainObject(value) || isSupportedClassInstance(value);
}

function isSupportedClassInstance(value: unknown): value is object {
  if (!isObject(value) || isPlainObject(value) || Array.isArray(value)) {
    return false;
  }

  return !isUnsupportedAtomicObject(value);
}

function isUnsupportedAtomicObject(value: object) {
  return (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Date ||
    value instanceof RegExp ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Promise ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  );
}

function describeValue(value: object) {
  return value.constructor?.name || "object";
}

function inspectDraftGraph(root: object): {
  hasAliasesOrCycles: boolean;
  unsupported?: string;
} {
  const visited = new WeakSet<object>();
  const visiting = new WeakSet<object>();
  let hasAliasesOrCycles = false;
  let unsupported: string | undefined;

  function visit(value: unknown) {
    if (!isObject(value) || unsupported) {
      return;
    }

    if (
      ((isUnsupportedAtomicObject(value) &&
        !(value instanceof Map) &&
        !(value instanceof Set)) ||
        isSupportedClassInstance(value))
    ) {
      unsupported = describeValue(value);
      return;
    }

    if (visiting.has(value) || visited.has(value)) {
      hasAliasesOrCycles = true;
      return;
    }

    visiting.add(value);

    const objectValue = value as object;

    if (objectValue instanceof Map) {
      for (const [key, childValue] of objectValue) {
        visit(key);
        visit(childValue);
      }
    } else if (objectValue instanceof Set) {
      for (const childValue of objectValue) {
        visit(childValue);
      }
    } else {
      for (const property of Reflect.ownKeys(objectValue)) {
        if (Array.isArray(objectValue) && property === "length") {
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(objectValue, property);

        if (!descriptor || !("value" in descriptor)) {
          unsupported = "an accessor property";
          return;
        }

        visit(descriptor.value);
      }
    }

    visiting.delete(value);
    visited.add(value);
  }

  visit(root);
  return { hasAliasesOrCycles, unsupported };
}

function isPlainObject(value: unknown): value is Indexable {
  if (!isObject(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isArrayIndex(segment: string) {
  return /^(0|[1-9]\d*)$/.test(segment);
}
