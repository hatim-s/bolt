import { describe, expect, test } from "vitest";
import { createBoltStore } from "./bolt";
import { writeImmutablePath } from "./utils";

type TestState = {
  profile: {
    name: string;
    stats: {
      visits: number;
    };
  };
  settings: {
    theme: string;
  };
};

describe("createBoltStore immutable path writes", () => {
  test("notifies root, parent, and exact leaf subscribers only", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const calls = {
      leaf: 0,
      parent: 0,
      root: 0,
      sibling: 0,
    };

    store.subscribe("", () => {
      calls.root += 1;
    });
    store.subscribe("profile", () => {
      calls.parent += 1;
    });
    store.subscribe("profile.name", () => {
      calls.leaf += 1;
    });
    store.subscribe("settings.theme", () => {
      calls.sibling += 1;
    });

    store.set("profile.name", "Grace");

    expect(store.get("profile.name")).toBe("Grace");
    expect(calls).toEqual({
      leaf: 1,
      parent: 1,
      root: 1,
      sibling: 0,
    });
  });

  test("preserves sibling references and old state snapshots", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const previousRoot = store.getState();
    const previousProfile = previousRoot.profile;
    const previousStats = previousRoot.profile.stats;
    const previousSettings = previousRoot.settings;

    store.set("profile.stats.visits", 2);

    const nextRoot = store.getState();
    expect(nextRoot).not.toBe(previousRoot);
    expect(nextRoot.profile).not.toBe(previousProfile);
    expect(nextRoot.profile.stats).not.toBe(previousStats);
    expect(nextRoot.settings).toBe(previousSettings);
    expect(previousRoot.profile.stats.visits).toBe(1);
    expect(previousProfile.stats.visits).toBe(1);
    expect(nextRoot.profile.stats.visits).toBe(2);
  });

  test("skips notifications and state replacement for no-op writes", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const previousRoot = store.getState();
    let calls = 0;

    store.subscribe("profile.name", () => {
      calls += 1;
    });

    store.set("profile.name", "Ada");
    store.set("profile.name", (previous) => previous);

    expect(store.getState()).toBe(previousRoot);
    expect(calls).toBe(0);
  });

  test("passes current path value to updater callbacks", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const seen: unknown[] = [];

    store.set("profile.stats.visits", (previous) => {
      seen.push(previous);
      return previous + 4;
    });

    expect(seen).toEqual([1]);
    expect(store.get("profile.stats.visits")).toBe(5);
  });

  test("lets object updaters mutate a draft without touching old snapshots", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const previousRoot = store.getState();
    const previousStats = previousRoot.profile.stats;
    let calls = 0;

    store.subscribe("profile.stats", () => {
      calls += 1;
    });

    store.set("profile.stats", (stats) => {
      stats.visits += 1;
      return stats;
    });

    const nextStats = store.get("profile.stats");
    expect(nextStats).toEqual({ visits: 2 });
    expect(nextStats).not.toBe(previousStats);
    expect(previousStats.visits).toBe(1);
    expect(previousRoot.profile.stats.visits).toBe(1);
    expect(calls).toBe(1);
  });

  test("skips no-op object updaters", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const previousRoot = store.getState();
    const previousStats = previousRoot.profile.stats;
    let calls = 0;

    store.subscribe("profile.stats", () => {
      calls += 1;
    });

    store.set("profile.stats", (stats) => stats);

    expect(store.getState()).toBe(previousRoot);
    expect(store.get("profile.stats")).toBe(previousStats);
    expect(calls).toBe(0);
  });

  test("creates missing branches when writing undefined", () => {
    const store = createBoltStore<{ items?: Array<{ name?: string }> }>({});
    let rootCalls = 0;
    let parentCalls = 0;

    store.subscribe("", () => {
      rootCalls += 1;
    });
    store.subscribe("items.0", () => {
      parentCalls += 1;
    });

    store.set(["items", 0, "name"], undefined);

    expect(Array.isArray(store.get("items"))).toBe(true);
    expect(store.get(["items", 0])).toEqual({ name: undefined });
    expect(rootCalls).toBe(1);
    expect(parentCalls).toBe(1);
  });

  test("root replacement notifies all subscribed paths", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const calls = {
      child: 0,
      parent: 0,
      root: 0,
      sibling: 0,
    };

    store.subscribe("", () => {
      calls.root += 1;
    });
    store.subscribe("profile", () => {
      calls.parent += 1;
    });
    store.subscribe("profile.name", () => {
      calls.child += 1;
    });
    store.subscribe("settings.theme", () => {
      calls.sibling += 1;
    });

    store.set("", {
      profile: { name: "Grace", stats: { visits: 2 } },
      settings: { theme: "light" },
    });

    expect(calls).toEqual({
      child: 1,
      parent: 1,
      root: 1,
      sibling: 1,
    });
  });

  test("creates missing object and array branches from numeric segments", () => {
    const store = createBoltStore<{ items?: Array<{ name: string }> }>({});

    store.set(["items", 0, "name"], "Bolt");
    store.set(["items", 1, "name"], "Legend");

    expect(Array.isArray(store.get("items"))).toBe(true);
    expect(store.get(["items", 0, "name"])).toBe("Bolt");
    expect(store.get(["items", 1, "name"])).toBe("Legend");
  });

  test("updates dynamic array paths immutably", () => {
    const store = createBoltStore({
      items: [{ count: 1 }, { count: 2 }],
    });
    const previousRoot = store.getState();
    const previousItems = previousRoot.items;
    const previousFirstItem = previousRoot.items[0];
    const previousSecondItem = previousRoot.items[1];

    store.set(["items", 1, "count"], 3);

    expect(store.get(["items", 1, "count"])).toBe(3);
    expect(store.getState()).not.toBe(previousRoot);
    expect(store.getState().items).not.toBe(previousItems);
    expect(store.getState().items[0]).toBe(previousFirstItem);
    expect(store.getState().items[1]).not.toBe(previousSecondItem);
    expect(previousSecondItem.count).toBe(2);
  });

  test("isolates Map and Set mutation-style updaters from old snapshots", () => {
    const store = createBoltStore({
      lookup: new Map([["bolt", { count: 1 }]]),
      selected: new Set(["bolt"]),
    });
    const previousRoot = store.getState();
    const previousLookup = previousRoot.lookup;
    const previousSelected = previousRoot.selected;

    store.set("lookup", (lookup) => {
      lookup.get("bolt")!.count += 1;
      lookup.set("legend", { count: 3 });
      return lookup;
    });
    store.set("selected", (selected) => {
      selected.add("legend");
      return selected;
    });

    expect(previousLookup.get("bolt")).toEqual({ count: 1 });
    expect(previousLookup.has("legend")).toBe(false);
    expect(previousSelected.has("legend")).toBe(false);
    expect(store.get("lookup").get("bolt")).toEqual({ count: 2 });
    expect(store.get("lookup").get("legend")).toEqual({ count: 3 });
    expect(store.get("selected")).toEqual(new Set(["bolt", "legend"]));

    const nested = createBoltStore({ wrapper: { lookup: new Map([["a", 1]]) } });
    const nestedPrevious = nested.getState();
    nested.set("wrapper", (wrapper) => {
      wrapper.lookup.set("b", 2);
      return wrapper;
    });
    expect(nestedPrevious.wrapper.lookup.has("b")).toBe(false);
    expect(nested.get("wrapper.lookup").get("b")).toBe(2);
  });

  test("rejects cycle and shared-alias updater graphs before invoking callbacks", () => {
    type Node = {
      left: { count: number };
      right: { count: number };
      self?: Node;
    };
    const shared = { count: 1 };
    const node: Node = { left: shared, right: shared };
    node.self = node;
    const store = createBoltStore({ node });
    const previousRoot = store.getState();

    let invoked = false;
    expect(() =>
      store.set("node", (draft) => {
        invoked = true;
        draft.left.count += 1;
        return draft;
      }),
    ).toThrow("cycles or shared references");

    expect(invoked).toBe(false);
    expect(store.getState()).toBe(previousRoot);
    expect(previousRoot.node.self).toBe(previousRoot.node);
    expect(previousRoot.node.left.count).toBe(1);
  });

  test("rolls back when an updater mixes mutation with a replacement return", () => {
    const previousChild = { count: 1 };
    const root: Record<string, unknown> = {
      slot: { child: previousChild },
    };

    expect(() =>
      writeImmutablePath(root, ["slot"], (draft: { child: { count: number } }) => {
        draft.child.count += 1;
        return { wrapped: draft.child };
      }),
    ).toThrow();

    expect(root).toEqual({ slot: { child: { count: 1 } } });
    expect(previousChild).toEqual({ count: 1 });
  });

  test("rejects prototype path segments before invoking an updater", () => {
    const store = createBoltStore<Record<string, unknown>>({ safe: true });
    const setUnsafe = store.set as (
      path: readonly string[],
      value: unknown,
    ) => void;
    let invoked = false;

    for (const segment of ["__proto__", "prototype", "constructor"]) {
      expect(() =>
        setUnsafe([segment, "polluted"], () => {
          invoked = true;
          return true;
        }),
      ).toThrow(`Unsafe Bolt path segment: ${segment}`);
    }

    expect(invoked).toBe(false);
    expect(store.getState()).toEqual({ safe: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("keeps root mutation-style updaters snapshot-safe and skips no-ops", () => {
    const store = createBoltStore({ nested: { count: 1 }, stable: { id: 1 } });
    const previousRoot = store.getState();
    let calls = 0;
    store.subscribe("", () => {
      calls += 1;
    });

    store.set("", (draft) => {
      draft.nested.count += 1;
      return draft;
    });

    const changedRoot = store.getState();
    expect(changedRoot).not.toBe(previousRoot);
    expect(changedRoot.nested.count).toBe(2);
    expect(changedRoot.stable).toBe(previousRoot.stable);
    expect(previousRoot.nested.count).toBe(1);
    expect(calls).toBe(1);

    store.set("", (draft) => {
      draft.nested.count = draft.nested.count;
      delete (draft as { missing?: unknown }).missing;
      return draft;
    });

    expect(store.getState()).toBe(changedRoot);
    expect(calls).toBe(1);
  });

  test("updates frozen object and array drafts without mutating snapshots", () => {
    const frozenObject = Object.freeze({ count: 1 });
    const frozenArray = Object.freeze([1, 2]);
    const store = createBoltStore({
      items: frozenArray as number[],
      node: frozenObject as { count: number },
    });

    store.set("node", (node) => {
      node.count += 1;
      return node;
    });
    store.set("items", (items) => {
      items.push(3);
      return items;
    });

    expect(store.get("node")).toEqual({ count: 2 });
    expect(store.get("items")).toEqual([1, 2, 3]);
    expect(frozenObject).toEqual({ count: 1 });
    expect(frozenArray).toEqual([1, 2]);
  });

  test("keeps notification dispatch scoped to the written path and its prefixes", () => {
    const store = createBoltStore<TestState>({
      profile: { name: "Ada", stats: { visits: 1 } },
      settings: { theme: "dark" },
    });
    const calls = { name: 0, stats: 0, visits: 0 };
    store.subscribe("profile.name", () => {
      calls.name += 1;
    });
    store.subscribe("profile.stats", () => {
      calls.stats += 1;
    });
    store.subscribe("profile.stats.visits", () => {
      calls.visits += 1;
    });

    store.set("profile", (profile) => {
      profile.name = "Grace";
      return profile;
    });
    expect(calls).toEqual({ name: 0, stats: 0, visits: 0 });

    store.set("profile", {
      name: "Katherine",
      stats: { visits: 2 },
    });
    expect(calls).toEqual({ name: 0, stats: 0, visits: 0 });
  });

  test("stores a literal function when updater resolution is disabled", () => {
    let invoked = false;
    const literal = () => {
      invoked = true;
      return "value";
    };
    const root: { handler: (() => string) | null } = { handler: null };

    const next = writeImmutablePath(root, ["handler"], literal, false);

    expect(next.handler).toBe(literal);
    expect(invoked).toBe(false);
    expect(next.handler?.()).toBe("value");
    expect(invoked).toBe(true);
  });

  test("preserves null prototypes, symbols, getters, and class prototypes on direct writes", () => {
    class Counter {
      value = 1;

      increment() {
        this.value += 1;
      }
    }

    const marker = Symbol("marker");
    const dictionary = Object.create(null) as {
      visible: number;
      [marker]: string;
    };
    dictionary.visible = 1;
    dictionary[marker] = "kept";
    Object.defineProperty(dictionary, "hidden", {
      configurable: false,
      enumerable: false,
      value: { id: 1 },
      writable: false,
    });
    const source = { computed: 3 } as { computed: number; double: number };
    Object.defineProperty(source, "double", {
      enumerable: false,
      get(this: { computed: number }) {
        return this.computed * 2;
      },
    });
    const store = createBoltStore({ counter: new Counter(), dictionary, source });
    const previous = store.getState();

    store.set("counter.value", 2);
    store.set("dictionary.visible", 4);
    store.set("source.computed", 5);

    const next = store.getState();
    expect(next.counter).toBeInstanceOf(Counter);
    expect(next.counter.value).toBe(2);
    expect(previous.counter.value).toBe(1);
    expect(Object.getPrototypeOf(next.dictionary)).toBe(null);
    expect(next.dictionary[marker]).toBe("kept");
    expect(Object.getOwnPropertyDescriptor(next.dictionary, "hidden")).toEqual(
      Object.getOwnPropertyDescriptor(dictionary, "hidden"),
    );
    expect(Object.getOwnPropertyDescriptor(next.source, "double")?.enumerable).toBe(
      false,
    );
    expect(next.source.double).toBe(10);
  });

  test("rejects unsupported updater values before callbacks can mutate snapshots", () => {
    class Counter {
      value = 1;
    }

    for (const value of [
      new Date("2020-01-01T00:00:00.000Z"),
      /bolt/,
      new Uint8Array([1]),
      new Counter(),
    ]) {
      const store = createBoltStore({ value });
      const previous = store.getState();
      let invoked = false;

      expect(() =>
        (store.set as (path: string, updater: (current: unknown) => unknown) => void)(
          "value",
          (current) => {
            invoked = true;
            return current;
          },
        ),
      ).toThrow("cannot safely draft");

      expect(invoked).toBe(false);
      expect(store.getState()).toBe(previous);
    }

    const date = new Date("2020-01-01T00:00:00.000Z");
    const store = createBoltStore({ wrapper: { date } });
    let invoked = false;
    expect(() =>
      store.set("wrapper", (wrapper) => {
        invoked = true;
        wrapper.date.setUTCFullYear(2021);
        return wrapper;
      }),
    ).toThrow("cannot safely draft Date");
    expect(invoked).toBe(false);
    expect(date.getUTCFullYear()).toBe(2020);
  });

  test("keeps sparse arrays and missing deletes semantically stable", () => {
    const store = createBoltStore({ items: new Array<number | undefined>(2), node: {} });
    const previous = store.getState();

    store.set(["items", 1], undefined);
    const materialized = store.getState();
    expect(Object.hasOwn(materialized.items, 0)).toBe(false);
    expect(Object.hasOwn(materialized.items, 1)).toBe(true);
    expect(materialized.items[1]).toBeUndefined();

    store.set("node", (node) => {
      delete (node as { missing?: unknown }).missing;
      return node;
    });
    expect(store.getState()).toBe(materialized);
    expect(previous.items).not.toBe(materialized.items);
  });

  test("rolls back thrown updaters and supports reentrant, cleanup-safe listeners", () => {
    const store = createBoltStore({ count: 0, node: { value: 1 } });
    const previous = store.getState();
    expect(() =>
      store.set("node", (node) => {
        node.value = 2;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getState()).toBe(previous);
    expect(previous.node.value).toBe(1);

    let primaryCalls = 0;
    let secondaryCalls = 0;
    let cleanupSecondary = () => {};
    store.subscribe("count", () => {
      primaryCalls += 1;
      cleanupSecondary();
      if (store.get("count") === 1) {
        store.set("count", 2);
      }
    });
    cleanupSecondary = store.subscribe("count", () => {
      secondaryCalls += 1;
    });

    store.set("count", 1);
    expect(store.get("count")).toBe(2);
    expect(primaryCalls).toBe(2);
    expect(secondaryCalls).toBe(1);

    const listener = () => {
      primaryCalls += 1;
    };
    const cleanupOne = store.subscribe("count", listener);
    const cleanupTwo = store.subscribe("count", listener);
    store.set("count", 3);
    expect(primaryCalls).toBe(4);
    cleanupOne();
    store.set("count", 4);
    expect(primaryCalls).toBe(5);
    cleanupTwo();
  });
});
