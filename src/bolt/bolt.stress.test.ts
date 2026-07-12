import { describe, expect, test } from "vitest";
import { createBoltStore } from "./bolt";

const STRESS_UPDATES = 100_000;

describe("immutable writer deterministic stress", () => {
  test("handles at least 100k mixed leaf and mutation-style writes", () => {
    const cellCount = 512;
    const cells = Object.fromEntries(
      Array.from({ length: cellCount }, (_, index) => [
        `cell-${index}`,
        { count: 0, tags: new Set<string>() },
      ]),
    );
    const store = createBoltStore({ cells, revisions: new Map<string, number>() });
    const initialSnapshot = store.getState();
    let random = 17;
    let expectedTotal = 0;

    for (let index = 0; index < STRESS_UPDATES; index += 1) {
      random = (random * 1_664_525 + 1_013_904_223) >>> 0;
      const id = `cell-${random % cellCount}`;

      if (index % 20 === 0) {
        store.set(["cells", id], (cell) => {
          cell.count += 1;
          cell.tags.add(`batch-${index % 7}`);
          return cell;
        });
      } else {
        store.set(["cells", id, "count"], (count) => count + 1);
      }

      if (index % 100 === 0) {
        store.set("revisions", (revisions) => {
          revisions.set(id, (revisions.get(id) ?? 0) + 1);
          return revisions;
        });
      }

      expectedTotal += 1;
    }

    const actualTotal = Object.values(store.get("cells")).reduce(
      (total, cell) => total + cell.count,
      0,
    );

    expect(STRESS_UPDATES).toBeGreaterThanOrEqual(100_000);
    expect(actualTotal).toBe(expectedTotal);
    expect(store.get("revisions").size).toBeGreaterThan(0);
    expect(Object.values(initialSnapshot.cells).every((cell) => cell.count === 0)).toBe(
      true,
    );
    expect(initialSnapshot.revisions.size).toBe(0);
  });
});
