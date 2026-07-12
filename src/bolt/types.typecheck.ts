import { createBoltStore } from "./bolt";
import type { BoltPath } from "./types";

type State = {
  items: Array<{ count: number }>;
  total: number;
  enabled: boolean;
  one: { two: { three: { four: { five: { six: string } } } } };
};

const store = createBoltStore<State>({
  items: [{ count: 1 }],
  total: 0,
  enabled: false,
  one: { two: { three: { four: { five: { six: "ok" } } } } },
});

store.set("items.0.count", (count) => count + 1);
store.set(["items", 0, "count"], 2);
store.set("", (state) => state);
store.get("one.two.three.four.five.six");

// @ts-expect-error Bolt paths stop at valid keys.
store.set("items.0.missing", 1);
// @ts-expect-error The generated path depth is six segments.
store.get("one.two.three.four.five.six.tooDeep");
// @ts-expect-error Leaf updater values retain their exact type.
store.set(["items", 0, "count"], "two");

const numericTuplePath = ["items", 0, "count"] as const satisfies BoltPath<State>;
store.set(numericTuplePath, 3);

store.derive("total", ["items.0.count"], ({ get, previous, sourcePaths }) => {
  const count: number = get("items.0.count");
  const prior: number = previous;
  const source: string = sourcePaths[0];
  void source;
  return count + prior;
});
store.derive(
  "total",
  [["items", "0", "count"]],
  ({ get }) => get(["items", "0", "count"]),
  { equality: (previous, next) => previous === next, initialize: true },
);

// @ts-expect-error Invalid static sources must use deriveUnsafe.
store.derive("total", ["missing.path"], () => 0);
// @ts-expect-error The target path controls the compute return type.
store.derive("enabled", ["items.0.count"], () => 1);
// @ts-expect-error Options equality uses the target's exact value type.
store.derive("enabled", ["items.0.count"], () => true, { equality: (a, b: number) => a === b });

const dynamicTarget = "items.0.count";
const dynamicSources = ["items.0.count"];
store.deriveUnsafe(dynamicTarget, dynamicSources, ({ get, previous }) => {
  const value: unknown = get(dynamicSources[0]);
  const prior: unknown = previous;
  return value ?? prior;
});

const dynamic = createBoltStore<Record<string, unknown>>({});
dynamic.set("entry", 1);
// @ts-expect-error Unknown dynamic-record values cannot be traversed without a schema.
dynamic.set(["entry", "nested"], 1);
