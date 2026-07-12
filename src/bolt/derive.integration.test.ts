import { describe, expect, test } from "vitest";
import { createBoltStore } from "./bolt";

describe("derived graph integration", () => {
  test("stores computed function values through the immutable writer", () => {
    const store = createBoltStore<{ input: number; handler: () => number }>({
      input: 2,
      handler: () => 0,
    });

    store.derive("handler", ["input"], ({ get }) => () => get("input") * 3);

    expect(store.get("handler")()).toBe(6);
    store.set("input", 4);
    expect(store.get("handler")()).toBe(12);
  });

  test("treats compute and equality callbacks as one protected, atomic transaction", () => {
    const store = createBoltStore({ a: 1, b: 0, c: 0, disposable: 0 });
    let cNotifications = 0;
    const dispose = store.derive("disposable", ["a"], ({ get }) => get("a"));

    store.subscribe("c", () => {
      cNotifications += 1;
    });

    store.derive("b", ["a"], ({ get }) => get("a") * 2, {
      equality(previous, next) {
        if (next === 4) {
          expect(() => store.set("c", 1)).toThrow("derived callbacks cannot call set");
          expect(() => store.derive("c", ["a"], ({ get }) => get("a"))).toThrow(
            "cannot be called inside a derived callback",
          );
          expect(() => dispose()).toThrow("cannot run inside a derived callback");
          throw new Error("equality rollback");
        }

        return Object.is(previous, next);
      },
    });

    expect(() => store.set("a", 2)).toThrow("equality rollback");
    expect(store.getState()).toEqual({ a: 1, b: 2, c: 0, disposable: 1 });
    expect(cNotifications).toBe(0);

    // A successful registration proves the failed equality callback did not
    // leak a node or its ownership/index entries.
    const disposeC = store.derive("c", ["a"], ({ get }) => get("a") + 10);
    expect(store.get("c")).toBe(11);
    disposeC();
  });

  test("rolls back partial chain and branch settlement without notifications", () => {
    const store = createBoltStore({ a: 1, b: 0, c: 0, branch: 0 });
    const notifications: string[] = [];

    store.derive("b", ["a"], ({ get }) => get("a") * 2);
    store.derive("c", ["b"], ({ get }) => {
      if (get("b") === 4) {
        throw new Error("chain failure");
      }

      return get("b") + 1;
    });
    store.derive("branch", ["a"], ({ get }) => get("a") + 100);
    store.subscribe(undefined, () => notifications.push("root"));

    expect(() => store.set("a", 2)).toThrow("chain failure");
    expect(store.getState()).toEqual({ a: 1, b: 2, c: 3, branch: 101 });
    expect(notifications).toEqual([]);
  });

  test("rolls back a partially settled branch when a sibling throws", () => {
    const store = createBoltStore({ a: 1, left: 0, right: 0 });

    store.derive("left", ["a"], ({ get }) => get("a") + 10);
    store.derive("right", ["a"], ({ get }) => {
      if (get("a") === 2) {
        throw new Error("branch failure");
      }

      return get("a") + 20;
    });

    expect(() => store.set("a", 2)).toThrow("branch failure");
    expect(store.getState()).toEqual({ a: 1, left: 11, right: 21 });
  });

  test("settles diamonds once per node and skips downstream work after no-op sources", () => {
    const store = createBoltStore({ a: 1, b: 0, c: 0, d: 0 });
    const calls = { b: 0, c: 0, d: 0 };

    store.derive("b", ["a"], ({ get }) => {
      calls.b += 1;
      return get("a") + 1;
    });
    store.derive("c", ["a"], ({ get }) => {
      calls.c += 1;
      return get("a") + 2;
    });
    store.derive("d", ["b", "c"], ({ get }) => {
      calls.d += 1;
      return get("b") + get("c");
    });

    calls.b = 0;
    calls.c = 0;
    calls.d = 0;
    store.set("a", 2);
    expect(calls).toEqual({ b: 1, c: 1, d: 1 });

    const noOpStore = createBoltStore({ source: 1, stable: 0, downstream: 0 });
    let downstreamCalls = 0;
    noOpStore.derive("stable", ["source"], () => 0);
    noOpStore.derive(
      "downstream",
      ["stable"],
      () => {
        downstreamCalls += 1;
        return 1;
      },
      { initialize: false },
    );
    noOpStore.set("source", 2);
    expect(downstreamCalls).toBe(0);

    const noOpUpdaterStore = createBoltStore({ source: 1, target: 0 });
    let targetCalls = 0;
    noOpUpdaterStore.derive("target", ["source"], ({ get }) => {
      targetCalls += 1;
      return get("source");
    });
    targetCalls = 0;
    noOpUpdaterStore.set("source", (previous) => previous);
    expect(targetCalls).toBe(0);
  });

  test("queues listener writes until every listener has observed the settled snapshot", () => {
    const store = createBoltStore({ a: 0, b: 0, c: 0 });
    const seen: Array<[string, number, number, number]> = [];
    store.derive("c", ["b"], ({ get }) => get("b") + 1);

    store.subscribe(undefined, () => {
      seen.push(["first", store.get("a"), store.get("b"), store.get("c")]);
      if (store.get("a") === 1 && store.get("b") === 0) {
        store.set("b", 2);
      }
    });
    store.subscribe(undefined, () => {
      seen.push(["second", store.get("a"), store.get("b"), store.get("c")]);
    });

    store.set("a", 1);

    expect(seen).toEqual([
      ["first", 1, 0, 1],
      ["second", 1, 0, 1],
      ["first", 1, 2, 3],
      ["second", 1, 2, 3],
    ]);
  });

  test("discards deferred writes when a derived-graph subscriber throws", () => {
    const store = createBoltStore({ a: 0, b: 0, derived: 0 });
    let shouldThrow = true;

    store.derive("derived", ["a"], ({ get }) => get("a") + 1);
    store.subscribe(undefined, () => {
      if (store.get("a") === 1) {
        store.set("b", 2);
      }
    });
    store.subscribe(undefined, () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("derived listener failure");
      }
    });

    expect(() => store.set("a", 1)).toThrow("derived listener failure");
    expect(store.getState()).toEqual({ a: 1, b: 0, derived: 2 });

    store.set("a", 2);
    expect(store.getState()).toEqual({ a: 2, b: 0, derived: 3 });
  });

  test("discards deferred writes when a legacy subscriber throws", () => {
    const store = createBoltStore({ a: 0, b: 0 });
    let shouldThrow = true;

    store.subscribe(undefined, () => {
      if (store.get("a") === 1) {
        store.set("b", 2);
      }
    });
    store.subscribe(undefined, () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("legacy listener failure");
      }
    });

    expect(() => store.set("a", 1)).toThrow("legacy listener failure");
    expect(store.getState()).toEqual({ a: 1, b: 0 });

    store.set("a", 2);
    expect(store.getState()).toEqual({ a: 2, b: 0 });
  });

  test("cleans up disposed upstream, middle, and diamond edges before target re-registration", () => {
    const store = createBoltStore({ a: 1, b: 0, c: 0, d: 0 });
    const disposeB = store.derive("b", ["a"], ({ get }) => get("a") + 1);
    const disposeC = store.derive("c", ["b"], ({ get }) => get("b") + 1);
    const disposeD = store.derive("d", ["a", "b"], ({ get }) => get("a") + get("b"));

    disposeB();
    store.set("a", 2);
    expect(store.getState()).toEqual({ a: 2, b: 2, c: 3, d: 4 });

    const replacement = store.derive("b", ["a"], ({ get }) => get("a") * 10);
    store.set("a", 3);
    expect(store.getState()).toEqual({ a: 3, b: 30, c: 31, d: 33 });

    replacement();
    disposeC();
    disposeD();

    const middleStore = createBoltStore({ a: 1, b: 0, c: 0, d: 0 });
    middleStore.derive("b", ["a"], ({ get }) => get("a") + 1);
    const disposeMiddle = middleStore.derive("c", ["b"], ({ get }) => get("b") + 1);
    middleStore.derive("d", ["b"], ({ get }) => get("b") + 2);
    disposeMiddle();
    middleStore.set("a", 2);
    expect(middleStore.getState()).toEqual({ a: 2, b: 3, c: 3, d: 5 });
  });

  test("supports deriveUnsafe dynamic string, tuple, and numeric paths", () => {
    const store = createBoltStore({ cells: [{ input: 2, output: 0 }] });

    store.deriveUnsafe(
      ["cells", 0, "output"],
      [["cells", 0, "input"]],
      ({ get }) => Number(get(["cells", 0, "input"])) * 4,
    );
    store.set(["cells", 0, "input"], 3);

    expect(store.get(["cells", 0, "output"])).toBe(12);
  });
});
