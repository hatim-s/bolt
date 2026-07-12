import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createBoltStore } from "../src/bolt/bolt";

type Sample = {
  durationMs: number;
  size: number;
  workload: string;
};

const SIZES = [1_024, 2_048, 4_096] as const;
const MEASURED_PASSES = 3;
const WARMUP_PASSES = 1;

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(workload: string, size: number, run: () => void): Sample {
  const start = performance.now();
  run();
  return { durationMs: performance.now() - start, size, workload };
}

function registerIndependent(size: number) {
  const initial: Record<string, number> = {};

  for (let index = 0; index < size; index += 1) {
    initial[`source${index}`] = index;
    initial[`target${index}`] = 0;
  }

  const store = createBoltStore(initial);

  for (let index = 0; index < size; index += 1) {
    const source = `source${index}`;
    store.deriveUnsafe(`target${index}`, [source], ({ get }) => get(source), {
      initialize: false,
    });
  }

  if (store.get("target0") !== 0) {
    throw new Error("independent registration changed state");
  }
}

function settleChain(size: number) {
  const initial: Record<string, number> = {};

  for (let index = 0; index <= size; index += 1) {
    initial[`node${index}`] = 0;
  }

  const store = createBoltStore(initial);

  for (let index = 1; index <= size; index += 1) {
    const source = `node${index - 1}`;
    store.deriveUnsafe(
      `node${index}`,
      [source],
      ({ get }) => Number(get(source)) + 1,
      { initialize: false },
    );
  }

  store.set("node0", 1);

  if (store.get(`node${size}`) !== size + 1) {
    throw new Error("chain did not settle");
  }
}

function settleWideFanout(size: number) {
  const initial: Record<string, number> = { source: 0 };

  for (let index = 0; index < size; index += 1) {
    initial[`target${index}`] = 0;
  }

  const store = createBoltStore(initial);

  for (let index = 0; index < size; index += 1) {
    store.deriveUnsafe(
      `target${index}`,
      ["source"],
      ({ get }) => Number(get("source")) + index,
      { initialize: false },
    );
  }

  store.set("source", 1);

  if (store.get(`target${size - 1}`) !== size) {
    throw new Error("fan-out did not settle");
  }
}

const workloads = [
  ["independent-registration", registerIndependent],
  ["chain-settlement", settleChain],
  ["wide-fanout-settlement", settleWideFanout],
] as const;

const samples: Sample[] = [];

for (const [workload, run] of workloads) {
  for (const size of SIZES) {
    for (let pass = 0; pass < WARMUP_PASSES; pass += 1) {
      run(size);
    }

    for (let pass = 0; pass < MEASURED_PASSES; pass += 1) {
      samples.push(measure(workload, size, () => run(size)));
    }
  }
}

const results = workloads.flatMap(([workload]) =>
  SIZES.map((size) => {
    const durationsMs = samples
      .filter((sample) => sample.workload === workload && sample.size === size)
      .map((sample) => sample.durationMs);
    return {
      durationsMs,
      medianMs: median(durationsMs),
      size,
      workload,
    };
  }),
);

console.table(results.map((result) => ({
  size: result.size,
  workload: result.workload,
  "median ms": result.medianMs.toFixed(3),
})));

const jsonFlag = process.argv.indexOf("--json");

if (jsonFlag >= 0) {
  const path = resolve(process.argv[jsonFlag + 1] ?? "artifacts/benchmarks/derived.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ measuredPasses: MEASURED_PASSES, results, warmupPasses: WARMUP_PASSES }, null, 2)}\n`,
  );
  console.log(`JSON: ${path}`);
}
