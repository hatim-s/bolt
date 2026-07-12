# ⚡ Bolt

[![npm version](https://img.shields.io/npm/v/@hatimcodes/bolt.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/@hatimcodes/bolt)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@hatimcodes/bolt?color=success&label=gzip)](https://bundlephobia.com/package/@hatimcodes/bolt)
[![types](https://img.shields.io/npm/types/@hatimcodes/bolt?logo=typescript&logoColor=white)](https://www.npmjs.com/package/@hatimcodes/bolt)
[![stars](https://img.shields.io/github/stars/hatim-s/bolt?style=social)](https://github.com/hatim-s/bolt)

A small, fast state store for React that you talk to with **paths**, not
selectors. ~4.3 kB gzip, no boilerplate, no providers-in-providers, and it only
re-renders the components that actually care.

```tsx
const [name, setName] = useStore("user.profile.name"); // read and write one path
setName("Ada");                                        // no spreads
```

Don't disregard it because it's tiny. Bolt keeps state outside React and talks
to it through `useSyncExternalStore`, so it plays nicely with concurrent
rendering, never tears, and won't wake a component that didn't subscribe to what
changed. Writes are immutable under the hood — you just write the path.

```bash
npm install @hatimcodes/bolt react
# or: bun add @hatimcodes/bolt react
```

## First, create a store

`createBolt<State>()` hands you a `Provider` and a few hooks, all typed to your
state shape. No actions to declare, no reducers — `set` is generic.

```tsx
import { createBolt } from "@hatimcodes/bolt";

type State = {
  user: { profile: { name: string } };
  count: number;
};

const { Provider, useStore, useSet } = createBolt<State>();
```

## Then read a path, and that's it!

Subscribe to a path and your component re-renders only when *that* path changes.
Nothing else does.

```tsx
function Counter() {
  const [count, setCount] = useStore("count");
  return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
}

function Name() {
  const [name, setName] = useStore("user.profile.name");
  return <input value={name} onChange={(e) => setName(e.target.value)} />;
}

function App() {
  return (
    <Provider state={{ user: { profile: { name: "Grace" } }, count: 0 }}>
      <Counter />
      <Name />
    </Provider>
  );
}
```

Click the button and `Name` stays put — it only subscribes to
`user.profile.name`. No selectors to write, no `useMemo`, no equality helpers.

### Why bolt over zustand?

- **No selectors.** You subscribe to a path, so the scope is right by
  construction. No more re-rendering every tick because a selector returned a
  fresh object (and no reaching for `shallow`).
- **No manual spreads.** `set("user.profile.name", "Ada")` instead of
  `set((s) => ({ user: { ...s.user, profile: { ...s.user.profile, name } } }))`.
- **Writes don't fan out.** A write wakes only the touched path and its parents —
  not every subscriber in the app. It stays fast as the store grows (see below).
- **Nothing to declare.** No actions, no slices — `set` works on any path.

### Why bolt over Context?

- Re-renders only the components that read the changed path, not the whole tree.
- No "split your context to avoid re-renders" gymnastics.
- Read and write from anywhere under one `<Provider>`.

## Reading and writing

Paths are **dot strings or arrays** — arrays are handy for dynamic keys. `set`
takes a value or an updater function.

```ts
const [itemName, setItemName] = useStore("items.0.name");
const [sameItemName] = useStore(["items", 0, "name"]); // same subscription

setItemName("Pear");                        // bound setter from useStore(path)
set("user.profile.name", "Ada");            // value
set("count", (previous) => previous + 1);   // updater
set(["cells", cellId], (n) => n + 1);       // dynamic key
set("", nextWholeState);                    // replace the whole store

useStore();                                 // no path = whole store
```

Paths and `set` values are type-checked from your state, up to 6 levels deep.

## Derived paths

`derive(target, sources, compute)` materializes one path from other typed paths.
The target behaves like normal store state: `get`, `useStore`, and `subscribe`
all read it at the same path, and Bolt updates it before subscribers are
notified.

```tsx
const { Provider, useApi, useStore } = createBolt<State>();

function RegisterTotal() {
  const api = useApi();

  useEffect(() => {
    return api.derive(
      "cart.total",
      ["cart.items", "cart.discount"],
      ({ get }) => {
        const items = get("cart.items");
        const discount = get("cart.discount") ?? 0;
        return items.reduce((sum, item) => sum + item.price, 0) - discount;
      },
    );
  }, [api]);

  return null;
}

function Total() {
  const [total] = useStore("cart.total");
  return <span>{total}</span>;
}
```

Derived targets can chain. If `b` derives from `a`, and `c` derives from `b`, a
write to `a` recomputes `b` and then `c` before React gets notified.

Manual writes that overlap a derived target are rejected by default so a normal
`set` call does not silently fight the derivation. That includes writes to the
target itself, one of its parents, or one of its descendants. Put local edits or
overrides in a separate source path instead:

```ts
api.derive("node.value", ["input.value", "node.override"], ({ get }) => {
  return get("node.override") ?? transform(get("input.value"));
});
```

If you really want manual writes to the target, opt in with
`{ manualWrites: "allow" }`. The next source change may overwrite that value.
Bolt then treats overlapping manual writes as changes to the derived target too,
so downstream derived paths and subscribers stay in sync.

Cycles are invalid. A target cannot derive from itself, one of its parents, one
of its descendants, an overlapping derived target, or an indirect dependency
chain that points back to it. Derived compute and equality callbacks are
synchronous and should only return a value or comparison result; async jobs,
effects, nested `set` calls, graph mutation, and multi-target writes belong
outside this v1 primitive. A write triggered by a subscriber is queued until
every subscriber has observed the settled transaction that triggered it.

Source paths are type checked. For generated systems that only know paths at
runtime, use the explicit escape hatch:

```ts
api.deriveUnsafe(dynamicTarget, dynamicSources, ({ get }) => {
  return computeFromRuntimePaths(get);
});
```

## API

| Member | What it does |
| --- | --- |
| `Provider` | `({ state, children })` — owns one store. `state` is read once on mount. |
| `useStore(path)` | Subscribe to a path and return `[value, setValue]`. The setter is already bound to that path. |
| `useStore()` | Subscribe to the whole store and return its value. |
| `useSet()` | Returns the typed `set(path, valueOrUpdater)`. |
| `useApi()` | Imperative `{ get, set, getState, subscribe, derive, deriveUnsafe }` — no re-render. |

Need it without React (tests, vanilla code)? `createBoltStore(initialState)`
gives you the same `get` / `set` / `subscribe` / `derive` / `deriveUnsafe`.

## It stays fast as the store grows

Bolt indexes listeners by path: a nested write wakes the root, the written path,
and its prefixes—not unrelated subscriptions. Direct path writes clone only the
ancestor chain. Run `bun run bench:immutable` for machine-specific medians and
p95 values across leaf, deep, mutation-style updater, and no-op workloads.
Run `bun run bench:derived` for 1K/2K/4K independent-registration, chain, and
wide-fan-out graph measurements.

## How it works

State lives in a closure outside React. Each `useStore(path)` registers a
`useSyncExternalStore` subscription keyed by that path and returns a setter
already bound to the same path. When you write `a.b.c.d`, Bolt notifies the
listeners for `a.b.c.d` **and its prefixes** — `a.b.c`, `a.b`, `a`, and the root
— and nobody else. So a parent watching `a.b` updates when anything beneath it
changes, while a sibling on `a.x` never hears about it. Direct nested writes
clone only changed ancestors. Object and collection updater callbacks use a
lazy copy-on-write draft, so untouched descendants keep their references.

Updater callbacks intentionally reject values that cannot keep this snapshot
contract without exposing mutable state: `Date`, `RegExp`, typed arrays,
custom-class instances, accessor properties, and graphs containing cycles or
shared references. Replace those values directly instead. Direct writes through
plain, null-prototype, and simple class containers preserve own descriptors and
prototypes; unsafe prototype path segments are rejected.

Derived paths live in the same external store. When a write touches a derived
source, Bolt settles the affected derived graph first, batches all changed paths,
and then notifies each affected listener once.

## When *not* to reach for bolt

Pick Zustand or Jotai if you want a mature, widely-audited library with a
middleware ecosystem (`persist`, `devtools`, `immer`), transient updates, or
async derivation. Bolt is young, has no middleware, no devtools integration, and
caps typed paths at 6 levels deep. It's deliberately small.

## Contributing

Development setup, build, and the release process live in
[CONTRIBUTING.md](./CONTRIBUTING.md).
