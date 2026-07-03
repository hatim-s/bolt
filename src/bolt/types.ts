/**
 * Public and internal types for Bolt.
 *
 * Most of this file exists to make path strings and path arrays type-safe up to
 * six levels deep while keeping runtime code simple.
 */
import type { PropsWithChildren, ReactElement } from "react";

/**
 * Values that cannot be traversed for child path keys.
 */
type Primitive = string | number | bigint | boolean | symbol | null | undefined;

/**
 * Values treated as leaves by Bolt path generation.
 *
 * Date, RegExp, and functions are objects at runtime, but callers should not get
 * generated paths like "createdAt.toISOString" or "fn.call".
 */
type Terminal = Primitive | Date | RegExp | ((...args: never[]) => unknown);

/**
 * Supported path-generation depth.
 *
 * Depth 6 means a type can generate paths such as "a.b.c.d.e.f".
 */
type Depth = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Type-level decrement table used to stop recursive path generation.
 */
type PreviousDepth = [0, 0, 1, 2, 3, 4, 5];

/**
 * Object keys that can appear in Bolt paths.
 */
type ObjectKey = string | number;

/**
 * Runtime path segment format accepted in array paths.
 */
type PathSegment = string | number;

/**
 * Subscription callback stored by Bolt.
 */
export type Listener = () => void;

/**
 * Joins one head segment to a tail path with dot notation.
 */
type JoinPath<Head extends string, Tail> = Tail extends string
  ? `${Head}.${Tail}`
  : never;

/**
 * Builds dot-separated paths up to six levels deep.
 *
 * Arrays accept numeric segments as strings so "items.0.name" and
 * ["items", "0", "name"] align.
 */
type ObjectPath<T, TDepth extends Depth = 6> = TDepth extends 0
  ? never
  : T extends Terminal
    ? never
    : T extends readonly (infer Item)[]
      ?
          | `${number}`
          | JoinPath<
              `${number}`,
              ObjectPath<NonNullable<Item>, PreviousDepth[TDepth]>
            >
      : T extends object
        ? {
            [Key in Extract<keyof T, ObjectKey>]:
              | `${Key}`
              | JoinPath<
                  `${Key}`,
                  ObjectPath<NonNullable<T[Key]>, PreviousDepth[TDepth]>
                >;
          }[Extract<keyof T, ObjectKey>]
        : never;

/**
 * Extracts valid tail tuple segments for SegmentPath.
 *
 * This helper keeps variadic tuple generation readable and prevents non-array
 * results from being spread into tuple paths.
 */
type SegmentTail<T, TDepth extends Depth> = SegmentPath<
  NonNullable<T>,
  PreviousDepth[TDepth]
> extends infer Tail
  ? Tail extends readonly string[]
    ? Tail
    : never
  : never;

/**
 * Tuple form of ObjectPath.
 *
 * Keeping this separate gives callers type-safe path arrays without needing to
 * parse string literals at the callsite.
 */
type SegmentPath<T, TDepth extends Depth = 6> = TDepth extends 0
  ? never
  : T extends Terminal
    ? never
    : T extends readonly (infer Item)[]
      ?
          | readonly [`${number}`]
          | readonly [`${number}`, ...SegmentTail<Item, TDepth>]
      : T extends object
        ? {
            [Key in Extract<keyof T, ObjectKey>]:
              | readonly [`${Key}`]
              | readonly [`${Key}`, ...SegmentTail<T[Key], TDepth>];
          }[Extract<keyof T, ObjectKey>]
        : never;

/**
 * Splits a dot path string into a tuple of path segments.
 */
type SplitPath<Path extends string> = Path extends ""
  ? []
  : Path extends `${infer Head}.${infer Tail}`
    ? [Head, ...SplitPath<Tail>]
    : [Path];

/**
 * Resolves the value type at one path segment.
 *
 * Missing keys intentionally become undefined because runtime reads of missing
 * paths also return undefined.
 */
type ValueAtKey<T, Key> = T extends null | undefined
  ? undefined
  : T extends readonly (infer Item)[]
    ? Key extends number | `${number}`
      ? Item
      : undefined
    : Key extends keyof T
      ? T[Key]
      : Key extends `${infer NumericKey extends number}`
        ? NumericKey extends keyof T
          ? T[NumericKey]
          : undefined
        : undefined;

/**
 * Recursively resolves the value type at a full path segment tuple.
 */
type ValueAtSegments<T, Segments extends readonly unknown[]> = Segments extends []
  ? T
  : Segments extends readonly [infer Head, ...infer Tail]
    ? ValueAtSegments<ValueAtKey<T, Head>, Tail>
    : T;

/**
 * Runtime path format accepted by Bolt.
 *
 * The empty string targets the whole store. Other paths can be dot-separated
 * strings or arrays of string/number path segments.
 */
export type BoltRuntimePath = "" | string | readonly PathSegment[];

/**
 * Compile-time-safe path union for one state shape.
 *
 * Bolt generates both dot-string and array-segment paths up to six levels deep.
 */
export type BoltPath<T> = "" | ObjectPath<T> | SegmentPath<T>;

/**
 * Value type found at a Bolt path.
 *
 * Invalid or missing branches resolve to undefined, matching runtime behavior.
 */
export type BoltPathValue<T, Path> = Path extends undefined
  ? T
  : Path extends ""
    ? T
    : Path extends readonly unknown[]
      ? ValueAtSegments<T, Path>
      : Path extends string
        ? ValueAtSegments<T, SplitPath<Path>>
        : never;

/**
 * Value accepted by set.
 *
 * Updaters receive the current path value and return the next path value.
 */
export type BoltValueOrUpdater<T> = T | ((previous: T) => T);

/**
 * Path-bound setter returned by useStore(path).
 *
 * The path is already captured, so callers only pass the next value or updater.
 */
export type BoltBoundSet<T> = (valueOrUpdater: BoltValueOrUpdater<T>) => void;

/**
 * Framework-independent store API.
 *
 * Subscriptions are path-indexed. A nested write notifies the root listener and
 * every subscribed prefix of the updated path.
 */
export type BoltStoreApi<TState extends object> = {
  /**
   * Returns the current root state object without subscribing.
   */
  getState: () => TState;

  /**
   * Reads the whole store or one typed path without subscribing.
   */
  get: {
    (): TState;
    <Path extends BoltPath<TState>>(path: Path): BoltPathValue<TState, Path>;
  };

  /**
   * Replaces a path value, or derives the next value from the previous value.
   */
  set: <Path extends BoltPath<TState>>(
    path: Path,
    valueOrUpdater: BoltValueOrUpdater<BoltPathValue<TState, Path>>,
  ) => void;

  /**
   * Registers a listener for a path. Nested writes notify matching prefixes.
   */
  subscribe: (path: BoltRuntimePath | undefined, listener: Listener) => () => void;
};

/**
 * React hook overload for reading either the full state or one path value.
 */
export type BoltUseStore<TState extends object> = {
  (): TState;
  <Path extends BoltPath<TState>>(
    path: Path,
  ): [BoltPathValue<TState, Path>, BoltBoundSet<BoltPathValue<TState, Path>>];
};

export type BoltProviderProps<TState extends object> = PropsWithChildren<{
  /**
   * Initial root state for the provider-scoped store.
   */
  state: TState;
}>;

/**
 * React-facing API returned by createBolt.
 */
export type BoltReactApi<TState extends object> = {
  /**
   * Provider that owns one Bolt store instance.
   */
  Provider: (props: BoltProviderProps<TState>) => ReactElement;

  /**
   * Hook for imperative store access.
   */
  useApi: () => BoltStoreApi<TState>;

  /**
   * Hook for the typed set function.
   */
  useSet: () => BoltStoreApi<TState>["set"];

  /**
   * Hook for reactive whole-store or path reads.
   */
  useStore: BoltUseStore<TState>;
};

/**
 * Internal extension used by useSyncExternalStore.
 *
 * Public callers get the smaller BoltStoreApi surface from useApi.
 */
export type InternalBoltStore<TState extends object> = BoltStoreApi<TState> & {
  /**
   * Reads a path after it has already been normalized to a dot key.
   */
  getByPathKey: (pathKey: string) => unknown;

  /**
   * Subscribes to a path after it has already been normalized to a dot key.
   */
  subscribePathKey: (pathKey: string, listener: Listener) => () => void;
};
