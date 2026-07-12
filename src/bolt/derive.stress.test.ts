import { describe, expect, test } from "vitest";
import { createBoltStore } from "./bolt";

const SCALE = 4_096;

describe("derived graph deterministic stress", () => {
  test("settles a long chain once per derived target", () => {
    const initial: Record<string, number> = {};

    for (let index = 0; index <= SCALE; index += 1) {
      initial[`n${index}`] = 0;
    }

    const store = createBoltStore(initial);
    const calls = new Uint8Array(SCALE + 1);

    for (let index = 1; index <= SCALE; index += 1) {
      const target = `n${index}`;
      const source = `n${index - 1}`;
      store.deriveUnsafe(
        target,
        [source],
        ({ get }) => {
          calls[index] += 1;
          return Number(get(source)) + 1;
        },
        { initialize: false },
      );
    }

    calls.fill(0);
    store.set("n0", 1);

    expect(store.get(`n${SCALE}`)).toBe(SCALE + 1);
    expect([...calls.slice(1)].every((count) => count === 1)).toBe(true);
  });

  test("settles wide fan-out once per target", () => {
    const initial: Record<string, number> = { source: 0 };

    for (let index = 0; index < SCALE; index += 1) {
      initial[`target${index}`] = 0;
    }

    const store = createBoltStore(initial);
    const calls = new Uint8Array(SCALE);

    for (let index = 0; index < SCALE; index += 1) {
      const target = `target${index}`;
      store.deriveUnsafe(
        target,
        ["source"],
        ({ get }) => {
          calls[index] += 1;
          return Number(get("source")) + index;
        },
        { initialize: false },
      );
    }

    calls.fill(0);
    store.set("source", 1);

    expect(store.get(`target${SCALE - 1}`)).toBe(SCALE);
    expect([...calls].every((count) => count === 1)).toBe(true);
  });

  test("registers a reverse-ordered long chain and settles each target once", () => {
    const initial: Record<string, number> = {};

    for (let index = 0; index <= SCALE; index += 1) {
      initial[`reverse${index}`] = 0;
    }

    const store = createBoltStore(initial);
    const calls = new Uint8Array(SCALE);

    for (let index = SCALE - 1; index >= 0; index -= 1) {
      const target = `reverse${index}`;
      const source = `reverse${index + 1}`;
      store.deriveUnsafe(
        target,
        [source],
        ({ get }) => {
          calls[index] += 1;
          return Number(get(source)) + 1;
        },
        { initialize: false },
      );
    }

    store.set(`reverse${SCALE}`, 1);

    expect(store.get("reverse0")).toBe(SCALE + 1);
    expect([...calls].every((count) => count === 1)).toBe(true);
  });

  test("registers a high fan-in/high fan-out bridge with one reachability traversal", () => {
    const bridgeSize = 2_048;
    const inputs: Record<string, number> = {};
    const producers: Record<string, number> = {};
    const outputs: Record<string, number> = {};
    const producerPaths: string[] = [];

    for (let index = 0; index < bridgeSize; index += 1) {
      const key = `p${index}`;
      inputs[key] = 0;
      producers[key] = 0;
      outputs[key] = 0;
      producerPaths.push(`producers.${key}`);
    }

    const store = createBoltStore({ bridge: 0, inputs, outputs, producers });
    const producerCalls = new Uint8Array(bridgeSize);
    const outputCalls = new Uint8Array(bridgeSize);
    let bridgeCalls = 0;

    for (let index = 0; index < bridgeSize; index += 1) {
      const key = `p${index}`;
      store.deriveUnsafe(
        `producers.${key}`,
        [`inputs.${key}`],
        ({ get }) => {
          producerCalls[index] += 1;
          return Number(get(`inputs.${key}`));
        },
        { initialize: false },
      );
      store.deriveUnsafe(
        `outputs.${key}`,
        ["bridge"],
        ({ get }) => {
          outputCalls[index] += 1;
          return Number(get("bridge")) + index;
        },
        { initialize: false },
      );
    }

    store.deriveUnsafe(
      "bridge",
      producerPaths,
      ({ get }) => {
        bridgeCalls += 1;
        return producerPaths.reduce((total, path) => total + Number(get(path)), 0);
      },
      { initialize: false },
    );

    store.set("inputs.p0", 1);

    expect(producerCalls[0]).toBe(1);
    expect(bridgeCalls).toBe(1);
    expect([...outputCalls].every((count) => count === 1)).toBe(true);
    expect(store.get(`outputs.p${bridgeSize - 1}`)).toBe(bridgeSize);
  });

  test("tears down and re-registers bulk independent targets without stale edges", () => {
    const initial: Record<string, number> = {};

    for (let index = 0; index < SCALE; index += 1) {
      initial[`source${index}`] = 0;
      initial[`target${index}`] = 0;
    }

    const store = createBoltStore(initial);
    const calls = new Uint8Array(SCALE);
    const registerAll = () =>
      Array.from({ length: SCALE }, (_, index) => {
        const source = `source${index}`;
        return store.deriveUnsafe(
          `target${index}`,
          [source],
          ({ get }) => {
            calls[index] += 1;
            return Number(get(source)) + 1;
          },
          { initialize: false, manualWrites: "allow" },
        );
      });

    const disposers = registerAll();
    disposers.forEach((dispose) => dispose());
    const replacements = registerAll();

    const nextState = { ...store.getState() };

    for (let index = 0; index < SCALE; index += 1) {
      nextState[`source${index}`] = 1;
    }

    store.set("", nextState);

    expect([...calls].every((count) => count === 1)).toBe(true);
    expect(store.get(`target${SCALE - 1}`)).toBe(2);
    replacements.forEach((dispose) => dispose());
  });

  test("tears down and re-registers a short chain without stale producer links", () => {
    const chainLength = 512;
    const initial: Record<string, number> = {};

    for (let index = 0; index <= chainLength; index += 1) {
      initial[`short${index}`] = 0;
    }

    const store = createBoltStore(initial);
    const calls = new Uint8Array(chainLength);
    const registerChain = () =>
      Array.from({ length: chainLength }, (_, offset) => {
        const index = offset + 1;
        const source = `short${index - 1}`;
        return store.deriveUnsafe(
          `short${index}`,
          [source],
          ({ get }) => {
            calls[offset] += 1;
            return Number(get(source)) + 1;
          },
          { initialize: false },
        );
      });

    const disposers = registerChain();
    disposers.forEach((dispose) => dispose());
    registerChain();
    store.set("short0", 1);

    expect(store.get(`short${chainLength}`)).toBe(chainLength + 1);
    expect([...calls].every((count) => count === 1)).toBe(true);
  });
});
