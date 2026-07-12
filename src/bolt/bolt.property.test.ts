import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { writeImmutablePath } from "./utils";

type ModelState = {
  left: { values: number[] };
  right: { values: number[] };
  dynamic: Record<string, Array<{ value: number }>>;
};

type Operation =
  | {
      kind: "existing";
      branch: "left" | "right";
      index: number;
      value: number;
    }
  | {
      kind: "missing";
      key: string;
      index: number;
      value: number;
    };

const existingOperation = fc
  .record({
    branch: fc.constantFrom<"left" | "right">("left", "right"),
    index: fc.integer({ min: 0, max: 7 }),
    value: fc.integer({ min: -1_000, max: 1_000 }),
  })
  .map((operation): Operation => ({ kind: "existing", ...operation }));

const missingOperation = fc
  .record({
    key: fc.stringMatching(/^[a-z]{1,5}$/),
    index: fc.integer({ min: 0, max: 4 }),
    value: fc.integer({ min: -1_000, max: 1_000 }),
  })
  .map((operation): Operation => ({ kind: "missing", ...operation }));

function initialState(): ModelState {
  return {
    left: { values: [0, 1, 2, 3, 4, 5, 6, 7] },
    right: { values: [8, 9, 10, 11, 12, 13, 14, 15] },
    dynamic: {},
  };
}

function applyReference(state: ModelState, operation: Operation) {
  const next = structuredClone(state);

  if (operation.kind === "existing") {
    next[operation.branch].values[operation.index] = operation.value;
    return next;
  }

  const entries = (next.dynamic[operation.key] ??= []);
  entries[operation.index] = { value: operation.value };
  return next;
}

function applyWriter(state: ModelState, operation: Operation) {
  return operation.kind === "existing"
    ? writeImmutablePath(
        state,
        [operation.branch, "values", String(operation.index)],
        operation.value,
      )
    : writeImmutablePath(
        state,
        ["dynamic", operation.key, String(operation.index), "value"],
        operation.value,
      );
}

describe("writeImmutablePath properties", () => {
  test("matches a full-clone model and never mutates prior snapshots", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(existingOperation, missingOperation), {
          minLength: 1,
          maxLength: 40,
        }),
        (operations) => {
          let actual = initialState();
          let model = initialState();

          for (const operation of operations) {
            const previous = actual;
            const previousValue = structuredClone(previous);
            const untouchedBranch =
              operation.kind === "existing"
                ? operation.branch === "left"
                  ? previous.right
                  : previous.left
                : previous.left;

            actual = applyWriter(actual, operation);
            model = applyReference(model, operation);

            expect(actual).toEqual(model);
            expect(previous).toEqual(previousValue);

            if (operation.kind === "existing") {
              expect(
                operation.branch === "left" ? actual.right : actual.left,
              ).toBe(untouchedBranch);
            } else {
              expect(actual.left).toBe(untouchedBranch);
              expect(actual.right).toBe(previous.right);
            }
          }
        },
      ),
      {
        endOnFailure: true,
        numRuns: 1_000,
        seed: 20_260_710,
      },
    );
  });
});
