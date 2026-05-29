# Bolt

Path-indexed external store for React.

Bolt keeps store state outside React and uses `useSyncExternalStore` to notify
React consumers. Consumers subscribe with a lodash-like path instead of selector
functions. Updating `a.b.c.d` notifies subscribers for the whole store plus
`a`, `a.b`, `a.b.c`, and `a.b.c.d`.

## Install

```sh
bun add bolt-react-store react
```

## Usage

```tsx
import { createBolt } from "bolt-react-store";

type State = {
  user: {
    profile: {
      name: string;
    };
  };
};

const { Provider, useSet, useStore } = createBolt<State>();

function Name() {
  const name = useStore("user.profile.name");
  const set = useSet();

  return (
    <button onClick={() => set("user.profile.name", "Ada")}>
      {name}
    </button>
  );
}

export function App() {
  return (
    <Provider state={{ user: { profile: { name: "Grace" } } }}>
      <Name />
    </Provider>
  );
}
```

Paths can be dot-separated strings or arrays of path segments:

```ts
useStore("user.profile.name");
useStore(["user", "profile", "name"]);
set("user.profile.name", (previous) => previous.toUpperCase());
```

## Build

```sh
bun run build:lib
```

The library build writes ESM, CJS, and TypeScript declarations to `dist/`.
