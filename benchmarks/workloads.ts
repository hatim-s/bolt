export type BenchmarkPath = string | readonly (string | number)[];

export type BenchmarkStore<TState extends object> = {
  get: (path?: BenchmarkPath) => unknown;
  getState: () => TState;
  set: (path: BenchmarkPath, valueOrUpdater: unknown) => void;
  subscribe: (
    path: BenchmarkPath | undefined,
    listener: () => void,
  ) => () => void;
};

export type CreateBoltStore = <TState extends object>(
  initialState: TState,
) => BenchmarkStore<TState>;

export type WorkloadSample = {
  checksum: number;
  durationMs: number;
  operations: number;
};

export type BenchmarkWorkload = {
  description: string;
  name: string;
  run: (
    createBoltStore: CreateBoltStore,
    iterations: number,
  ) => WorkloadSample;
};

const CELL_COUNT = 512;
const SEED = 0x5eedc0de;

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function createIndices(count: number, length: number): number[] {
  let value = SEED;
  const indices = new Array<number>(count);

  for (let index = 0; index < count; index += 1) {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    indices[index] = value % length;
  }

  return indices;
}

function checksumNumbers(values: readonly number[]): number {
  let checksum = 0;

  for (let index = 0; index < values.length; index += 1) {
    checksum += values[index] * (index + 1);
  }

  return checksum;
}

const leafWrites: BenchmarkWorkload = {
  description:
    "Deterministic leaf updates with root and exact-path subscribers attached.",
  name: "leaf-writes",
  run(createBoltStore, iterations) {
    const sequence = createIndices(iterations, CELL_COUNT);
    const expected = new Array<number>(CELL_COUNT).fill(0);
    const cells = Object.fromEntries(
      Array.from({ length: CELL_COUNT }, (_, index) => [`cell-${index}`, 0]),
    );
    const stableMetadata = { label: "stable" };
    const store = createBoltStore({ cells, metadata: stableMetadata });
    let leafNotifications = 0;
    let rootNotifications = 0;

    store.subscribe("", () => {
      rootNotifications += 1;
    });

    for (let index = 0; index < CELL_COUNT; index += 1) {
      store.subscribe(`cells.cell-${index}`, () => {
        leafNotifications += 1;
      });
    }

    for (const cellIndex of sequence) {
      expected[cellIndex] += 1;
    }

    const startedAt = performance.now();

    for (const cellIndex of sequence) {
      store.set(`cells.cell-${cellIndex}`, (previous: unknown) =>
        Number(previous) + 1,
      );
    }

    const durationMs = performance.now() - startedAt;
    const state = store.getState();
    const actual = Array.from(
      { length: CELL_COUNT },
      (_, index) => state.cells[`cell-${index}`],
    );

    assertEqual(checksumNumbers(actual), checksumNumbers(expected), "leaf checksum");
    assertEqual(rootNotifications, iterations, "root notification count");
    assertEqual(leafNotifications, iterations, "leaf notification count");
    assertEqual(state.metadata, stableMetadata, "untouched sibling identity");
    assertEqual(
      Object.values(cells).reduce((sum, value) => sum + value, 0),
      0,
      "previous snapshot mutation",
    );

    return {
      checksum: checksumNumbers(actual),
      durationMs,
      operations: iterations,
    };
  },
};

type DeepState = {
  sibling: { marker: number };
  tree: {
    a: {
      b: {
        c: {
          d: { value: number };
        };
      };
    };
  };
};

const deepWrites: BenchmarkWorkload = {
  description:
    "Six-segment writes that exercise ancestor cloning and prefix notifications.",
  name: "deep-writes",
  run(createBoltStore, iterations) {
    const initialState: DeepState = {
      sibling: { marker: 17 },
      tree: { a: { b: { c: { d: { value: 0 } } } } },
    };
    const store = createBoltStore(initialState);
    const previousRoot = store.getState();
    const stableSibling = previousRoot.sibling;
    let leafNotifications = 0;
    let parentNotifications = 0;
    let rootNotifications = 0;
    let siblingNotifications = 0;

    store.subscribe("", () => {
      rootNotifications += 1;
    });
    store.subscribe("tree.a.b", () => {
      parentNotifications += 1;
    });
    store.subscribe("tree.a.b.c.d.value", () => {
      leafNotifications += 1;
    });
    store.subscribe("sibling", () => {
      siblingNotifications += 1;
    });

    const startedAt = performance.now();

    for (let index = 0; index < iterations; index += 1) {
      store.set("tree.a.b.c.d.value", (previous: unknown) =>
        Number(previous) + 1,
      );
    }

    const durationMs = performance.now() - startedAt;
    const state = store.getState();
    const value = state.tree.a.b.c.d.value;

    assertEqual(value, iterations, "deep value");
    assertEqual(rootNotifications, iterations, "root notification count");
    assertEqual(parentNotifications, iterations, "parent notification count");
    assertEqual(leafNotifications, iterations, "leaf notification count");
    assertEqual(siblingNotifications, 0, "sibling notification count");
    assertEqual(state.sibling, stableSibling, "untouched sibling identity");
    assertEqual(previousRoot.tree.a.b.c.d.value, 0, "previous snapshot mutation");

    return {
      checksum: value * 31 + state.sibling.marker,
      durationMs,
      operations: iterations,
    };
  },
};

type DraftState = {
  items: {
    left: { nested: { count: number }; value: number };
    right: { value: number };
  };
};

const draftUpdaters: BenchmarkWorkload = {
  description:
    "Mutation-style object updaters with old-snapshot and sibling-identity checks.",
  name: "draft-updaters",
  run(createBoltStore, iterations) {
    const operations = Math.max(1, Math.floor(iterations / 5));
    const initialState: DraftState = {
      items: {
        left: { nested: { count: 0 }, value: 0 },
        right: { value: 7 },
      },
    };
    const store = createBoltStore(initialState);
    const previousRoot = store.getState();
    const stableRight = previousRoot.items.right;
    let exactNotifications = 0;
    let rootNotifications = 0;

    store.subscribe("", () => {
      rootNotifications += 1;
    });
    store.subscribe("items.left", () => {
      exactNotifications += 1;
    });

    const startedAt = performance.now();

    for (let index = 0; index < operations; index += 1) {
      store.set("items.left", (value: unknown) => {
        const draft = value as DraftState["items"]["left"];
        draft.value += 1;
        draft.nested.count += 2;
        return draft;
      });
    }

    const durationMs = performance.now() - startedAt;
    const state = store.getState();

    assertEqual(state.items.left.value, operations, "draft value");
    assertEqual(state.items.left.nested.count, operations * 2, "nested draft value");
    assertEqual(rootNotifications, operations, "root notification count");
    assertEqual(exactNotifications, operations, "exact notification count");
    assertEqual(state.items.right, stableRight, "untouched sibling identity");
    assertEqual(previousRoot.items.left.value, 0, "previous snapshot mutation");
    assertEqual(
      previousRoot.items.left.nested.count,
      0,
      "previous nested snapshot mutation",
    );

    return {
      checksum:
        state.items.left.value * 31 +
        state.items.left.nested.count * 17 +
        state.items.right.value,
      durationMs,
      operations,
    };
  },
};

const noOpWrites: BenchmarkWorkload = {
  description:
    "Repeated equal-value updaters that must preserve root identity and stay silent.",
  name: "no-op-writes",
  run(createBoltStore, iterations) {
    const initialState = { node: { value: 1 }, sibling: { marker: 23 } };
    const store = createBoltStore(initialState);
    const previousRoot = store.getState();
    let notifications = 0;

    store.subscribe("", () => {
      notifications += 1;
    });
    store.subscribe("node.value", () => {
      notifications += 1;
    });

    const startedAt = performance.now();

    for (let index = 0; index < iterations; index += 1) {
      store.set("node.value", (previous: unknown) => previous);
    }

    const durationMs = performance.now() - startedAt;
    const state = store.getState();

    assertEqual(state, previousRoot, "no-op root identity");
    assertEqual(notifications, 0, "no-op notification count");

    return {
      checksum: state.node.value * 31 + state.sibling.marker,
      durationMs,
      operations: iterations,
    };
  },
};

export const immutableWorkloads: readonly BenchmarkWorkload[] = [
  leafWrites,
  deepWrites,
  draftUpdaters,
  noOpWrites,
];
