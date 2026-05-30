# ⚡ Bolt

A small, fast state store for React that you talk to with **paths**, not
selectors. ~4.3 kB gzip, no boilerplate, no providers-in-providers, and it only
re-renders the components that actually care.

```tsx
const name = useStore("user.profile.name"); // read one path
set("user.profile.name", "Ada");            // write one path — no spreads
```

Don't disregard it because it's tiny. Bolt keeps state outside React and talks
to it through `useSyncExternalStore`, so it plays nicely with concurrent
rendering, never tears, and won't wake a component that didn't subscribe to what
changed. Writes are immutable under the hood — you just write the path.

You can try the live comparison playground: `bun run dev` → open `/stresstest`.

```bash
npm install bolt react
# or: bun add bolt react
```

## First, create a store

`createBolt<State>()` hands you a `Provider` and a few hooks, all typed to your
state shape. No actions to declare, no reducers — `set` is generic.

```tsx
import { createBolt } from "bolt";

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
  const count = useStore("count");
  const set = useSet();
  return <button onClick={() => set("count", (c) => c + 1)}>{count}</button>;
}

function Name() {
  const name = useStore("user.profile.name");
  const set = useSet();
  return <input value={name} onChange={(e) => set("user.profile.name", e.target.value)} />;
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
useStore("items.0.name");
useStore(["items", 0, "name"]);             // same subscription

set("user.profile.name", "Ada");            // value
set("count", (previous) => previous + 1);   // updater
set(["cells", cellId], (n) => n + 1);       // dynamic key
set("", nextWholeState);                    // replace the whole store

useStore();                                 // no path = whole store
```

Paths and `set` values are type-checked from your state, up to 6 levels deep.

## API

| Member | What it does |
| --- | --- |
| `Provider` | `({ state, children })` — owns one store. `state` is read once on mount. |
| `useStore(path?)` | Subscribe to a path and return its value. No arg = whole store. |
| `useSet()` | Returns the typed `set(path, valueOrUpdater)`. |
| `useApi()` | Imperative `{ get, set, getState, subscribe }` — no re-render. |

Need it without React (tests, vanilla code)? `createBoltStore(initialState)`
gives you the same `get` / `set` / `subscribe`.

## It stays fast as the store grows

Same mounted grid of N cells, each cell leaf-subscribed to its own value (a
Zustand selector vs a Bolt path), driven by the **same 10,000 single-cell
updates**. Both re-render the *same* cells — so this is pure store-dispatch cost,
not wasted renders. Chrome, Apple Silicon, React 19. **Lower is better.**

| Cells | Zustand dispatch | Bolt dispatch | Zustand → paint | Bolt → paint | Bolt faster |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 165 ms | **79 ms** | 209 ms | **100 ms** | **52%** |
| 512 | 882 ms | **364 ms** | 1056 ms | **413 ms** | **61%** |
| 1024 | 2055 ms | **462 ms** | 2386 ms | **565 ms** | **76%** |
| 2048 | 4045 ms | **876 ms** | 4612 ms | **1066 ms** | **77%** |

The gap **widens with size**: Zustand re-runs every selector on every write
(O(subscribers)), while Bolt only wakes the touched path's parents (O(depth)). At
2048 cells Bolt dispatches the same updates ~4.6× faster. Run it yourself with
`bun run dev` → `/stresstest` (numbers vary by machine; the trend is the point).

## How it works

State lives in a closure outside React. Each `useStore(path)` registers a
`useSyncExternalStore` subscription keyed by that path. When you write `a.b.c.d`,
Bolt notifies the listeners for `a.b.c.d` **and its prefixes** — `a.b.c`, `a.b`,
`a`, and the root — and nobody else. So a parent watching `a.b` updates when
anything beneath it changes, while a sibling on `a.x` never hears about it.
Nested writes go through [Mutative](https://github.com/unadlib/mutative), which
gives you mutation-style writes while keeping state immutable.

## When *not* to reach for bolt

Pick Zustand or Jotai if you want a mature, widely-audited library with a
middleware ecosystem (`persist`, `devtools`, `immer`), transient updates, or
derived/computed state. Bolt is young, has no middleware, and caps typed paths at
6 levels deep. It's deliberately small.

## Build

```sh
bun run build:lib   # writes ESM, CJS, and .d.ts to dist/
```

## License

MIT
