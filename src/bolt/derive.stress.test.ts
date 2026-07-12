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
});
