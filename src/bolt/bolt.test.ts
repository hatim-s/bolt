import { describe, expect, test } from "bun:test";
import { createBoltStore } from "./bolt";

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
    const store = createBoltStore<Record<string, unknown>>({});

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
});
