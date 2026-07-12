import { createBoltStore } from "./bolt";
import type { BoltPath } from "./types";

type State = {
  items: Array<{ count: number }>;
  one: { two: { three: { four: { five: { six: string } } } } };
};

const store = createBoltStore<State>({
  items: [{ count: 1 }],
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

const dynamic = createBoltStore<Record<string, unknown>>({});
dynamic.set("entry", 1);
// @ts-expect-error Unknown dynamic-record values cannot be traversed without a schema.
dynamic.set(["entry", "nested"], 1);
