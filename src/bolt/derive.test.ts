import { describe, expect, test } from "bun:test";
import { createBoltStore, type BoltStoreApi } from "./bolt";

type TestState = {
  a: number;
  b: number;
  c: number;
  z: number;
  nested: {
    x: {
      y: number;
    };
    sibling: number;
  };
  node: {
    value: number;
    override?: number;
  };
};

function createTestStore(overrides: Partial<TestState> = {}) {
  return createBoltStore<TestState>({
    a: 1,
    b: 0,
    c: 0,
    z: 0,
    nested: {
      x: {
        y: 1,
      },
      sibling: 0,
    },
    node: {
      value: 0,
    },
    ...overrides,
  });
}

describe("Bolt derived paths", () => {
  test("keeps prefix notifications unchanged without a derived graph", () => {
    const store = createTestStore();
    const calls: string[] = [];

    store.subscribe(undefined, () => calls.push("root"));
    store.subscribe("nested", () => calls.push("nested"));
    store.subscribe("nested.x", () => calls.push("nested.x"));
    store.subscribe("nested.x.y", () => calls.push("nested.x.y"));
    store.subscribe("z", () => calls.push("z"));

    store.set("nested.x.y", 2);

    expect(calls).toEqual(["root", "nested", "nested.x", "nested.x.y"]);
  });

  test("keeps duplicate listener calls unchanged without a derived graph", () => {
    const store = createBoltStore({ a: { b: 1 } });
    let calls = 0;
    const listener = () => {
      calls += 1;
    };

    store.subscribe(undefined, listener);
    store.subscribe("a", listener);
    store.subscribe("a.b", listener);
    store.set("a.b", 2);

    expect(calls).toBe(3);
  });

  test("initializes a derived target and disposes idempotently", () => {
    const store = createTestStore();
    let targetCalls = 0;

    store.subscribe("b", () => {
      targetCalls += 1;
    });

    const dispose = store.derive("b", ["a"], ({ get }) => get("a") * 2);

    expect(store.get("b")).toBe(2);
    expect(targetCalls).toBe(1);

    dispose();
    dispose();
    store.set("a", 3);

    expect(store.get("b")).toBe(2);
  });

  test("recomputes for leaf, parent, ancestor, and root writes", () => {
    const store = createTestStore();
    const seen: number[] = [];

    store.derive(
      "b",
      ["nested.x.y"],
      ({ get }) => {
        const next = get("nested.x.y") * 2;
        seen.push(next);
        return next;
      },
      { manualWrites: "allow" },
    );

    store.set("nested.x.y", 2);
    store.set("nested.x", { y: 3 });
    store.set("", {
      ...store.getState(),
      nested: {
        x: {
          y: 4,
        },
        sibling: 0,
      },
    });

    expect(seen).toEqual([2, 4, 6, 8]);
    expect(store.get("b")).toBe(8);
  });

  test("recomputes parent sources for descendant writes and skips siblings", () => {
    const store = createTestStore();
    let computes = 0;

    store.derive("b", ["nested.x"], ({ get }) => {
      computes += 1;
      return get("nested.x").y + 1;
    });

    store.set("nested.x.y", 2);
    expect(store.get("b")).toBe(3);
    expect(computes).toBe(2);

    store.set("nested.sibling", 5);
    expect(store.get("b")).toBe(3);
    expect(computes).toBe(2);
  });

  test("settles chained derived targets before notifying subscribers", () => {
    const store = createTestStore();
    const order: string[] = [];
    const snapshots: Array<Pick<TestState, "a" | "b" | "c">> = [];

    store.derive("b", ["a"], ({ get, changedPaths }) => {
      order.push(`b:${changedPaths.join(",")}`);
      return get("a") + 1;
    });
    store.derive("c", ["b"], ({ get, changedPaths }) => {
      order.push(`c:${changedPaths.join(",")}`);
      return get("b") * 2;
    });

    order.length = 0;
    store.subscribe(undefined, () => {
      snapshots.push({
        a: store.get("a"),
        b: store.get("b"),
        c: store.get("c"),
      });
    });

    store.set("a", 2);

    expect(order).toEqual(["b:a", "c:a,b"]);
    expect(snapshots).toEqual([{ a: 2, b: 3, c: 6 }]);
  });

  test("rejects manual writes by default and allows them when configured", () => {
    const rejectingStore = createTestStore();
    rejectingStore.derive("b", ["a"], ({ get }) => get("a") * 2);

    expect(() => rejectingStore.set("b", 10)).toThrow(
      'Bolt derived target "b" cannot be set directly.',
    );

    const allowingStore = createTestStore();
    allowingStore.derive("b", ["a"], ({ get }) => get("a") * 2, {
      manualWrites: "allow",
    });

    allowingStore.set("b", 10);
    expect(allowingStore.get("b")).toBe(10);

    allowingStore.set("a", 3);
    expect(allowingStore.get("b")).toBe(6);
  });

  test("supports manual override source paths without target/source overlap", () => {
    const store = createTestStore();

    store.derive("node.value", ["a", "node.override"], ({ get }) => {
      return get("node.override") ?? get("a") * 2;
    });

    expect(store.get("node.value")).toBe(2);

    store.set("node.override", 10);
    expect(store.get("node.value")).toBe(10);

    store.set("a", 4);
    expect(store.get("node.value")).toBe(10);
  });

  test("rejects duplicate targets, self-overlap, and indirect cycles", () => {
    const store = createTestStore();

    store.derive("b", ["a"], ({ get }) => get("a") * 2);

    expect(() => store.derive("b", ["z"], ({ get }) => get("z"))).toThrow(
      'Bolt derived target "b" is already registered.',
    );

    expect(() => store.derive("node.value", ["node"], () => 1)).toThrow(
      'Bolt derived target "node.value" cannot depend on overlapping source "node".',
    );

    expect(() => store.derive("a", ["b"], ({ get }) => get("b"))).toThrow(
      "Bolt derived cycle: a -> b -> a",
    );
  });

  test("rejects overlapping derived targets", () => {
    const store = createBoltStore({
      x: 1,
      y: 2,
      a: {
        b: 0,
        c: 0,
      },
    });

    store.derive("a", ["x"], ({ get }) => ({ b: get("x"), c: 0 }));

    expect(() => store.derive("a.b", ["y"], ({ get }) => get("y") * 10)).toThrow(
      'Bolt derived target "a.b" overlaps existing derived target "a".',
    );
  });

  test("guards manual writes that overlap derived targets", () => {
    const rejectingStore = createTestStore();

    rejectingStore.derive("node.value", ["a"], ({ get }) => get("a") * 2);

    expect(() => rejectingStore.set("node", { value: 99, other: 1 })).toThrow(
      'Bolt derived target "node.value" cannot be set directly.',
    );
    expect(() => rejectingStore.set("node.value.extra" as never, 1)).toThrow(
      'Bolt derived target "node.value" cannot be set directly.',
    );

    const allowingStore = createTestStore();
    let downstreamCalls = 0;

    allowingStore.derive("node.value", ["a"], ({ get }) => get("a") * 2, {
      manualWrites: "allow",
    });
    allowingStore.derive("b", ["node.value"], ({ get }) => get("node.value") + 1);
    allowingStore.subscribe("b", () => {
      downstreamCalls += 1;
    });

    allowingStore.set("node", { value: 99, override: 1 });

    expect(allowingStore.get("node.value")).toBe(99);
    expect(allowingStore.get("b")).toBe(100);
    expect(downstreamCalls).toBe(1);
  });

  test("rolls back source and derived writes when compute throws", () => {
    const store = createTestStore();
    let calls = 0;

    store.subscribe("a", () => {
      calls += 1;
    });
    store.derive("b", ["a"], ({ get }) => {
      if (get("a") === 2) {
        throw new Error("boom");
      }

      return get("a") * 2;
    });

    expect(() => store.set("a", 2)).toThrow("boom");
    expect(store.get("a")).toBe(1);
    expect(store.get("b")).toBe(2);
    expect(calls).toBe(0);
  });

  test("does not run downstream computes when upstream equality passes", () => {
    const store = createTestStore();

    store.derive("b", ["a"], () => 0);
    store.derive(
      "c",
      ["b"],
      () => {
        throw new Error("should not run");
      },
      { initialize: false },
    );

    expect(() => store.set("a", 2)).not.toThrow();
    expect(store.get("c")).toBe(0);
  });

  test("rejects derived graph mutation and set calls while computing", () => {
    const store = createTestStore();
    let dispose: (() => void) | undefined;

    dispose = store.derive("c", ["z"], ({ get }) => get("z") + 1);

    expect(() =>
      store.derive("b", ["a"], () => {
        store.derive("z", [], () => 1);
        return 2;
      }),
    ).toThrow("Bolt derive() cannot be called inside a derived compute.");

    expect(() =>
      store.derive("b", ["a"], () => {
        dispose?.();
        return 2;
      }),
    ).toThrow("Bolt derived disposers cannot run inside a derived compute.");

    expect(() =>
      store.derive("b", ["a"], () => {
        store.set("z", 1);
        return 2;
      }),
    ).toThrow("Bolt derived compute functions cannot call set().");

    store.set("a", 2);
    expect(store.get("b")).toBe(0);
  });

  test("registers and settles long derived chains without quadratic blowups", () => {
    type ChainState = Record<`n${number}`, number>;
    const initialState: ChainState = {};
    const size = 600;

    for (let index = 0; index <= size; index += 1) {
      initialState[`n${index}`] = 0;
    }

    const store = createBoltStore(initialState);
    const start = performance.now();

    for (let index = 1; index <= size; index += 1) {
      const target = `n${index}` as keyof ChainState & string;
      const source = `n${index - 1}` as keyof ChainState & string;

      store.derive(target, [source], ({ get }) => get(source) + 1);
    }

    store.set("n0", 1);

    expect(store.get(`n${size}` as keyof ChainState & string)).toBe(size + 1);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test("keeps the base store interface mock-compatible", () => {
    const fake: BoltStoreApi<{ count: number }> = {
      getState: () => ({ count: 0 }),
      get: (() => 0) as BoltStoreApi<{ count: number }>["get"],
      set: () => {},
      subscribe: () => () => {},
    };

    expect(fake.getState().count).toBe(0);
  });

  test("dedupes listeners across source and derived target notifications", () => {
    const store = createTestStore();
    let calls = 0;
    const listener = () => {
      calls += 1;
    };

    store.derive("b", ["a"], ({ get }) => get("a") * 2);
    store.subscribe(undefined, listener);
    store.subscribe("a", listener);
    store.subscribe("b", listener);

    store.set("a", 2);

    expect(calls).toBe(1);
  });

  test("does not notify unchanged derived targets when equality passes", () => {
    const store = createTestStore();
    let computes = 0;
    let targetCalls = 0;

    store.derive("b", ["a"], () => {
      computes += 1;
      return 0;
    });
    store.subscribe("b", () => {
      targetCalls += 1;
    });

    store.set("a", 2);

    expect(computes).toBe(2);
    expect(targetCalls).toBe(0);
    expect(store.get("b")).toBe(0);
  });
});
