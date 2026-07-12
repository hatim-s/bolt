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

function measure(workload: string, size: number, run: () => number | void): Sample {
  const start = performance.now();
  const reportedDuration = run();
  return {
    durationMs: reportedDuration ?? performance.now() - start,
    size,
    workload,
  };
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

  const start = performance.now();
  store.set("node0", 1);
  const durationMs = performance.now() - start;

  if (store.get(`node${size}`) !== size + 1) {
    throw new Error("chain did not settle");
  }

  return durationMs;
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

  const start = performance.now();
  store.set("source", 1);
  const durationMs = performance.now() - start;

  if (store.get(`target${size - 1}`) !== size) {
    throw new Error("fan-out did not settle");
  }

  return durationMs;
}

function registerReverseChain(size: number) {
  const initial: Record<string, number> = {};

  for (let index = 0; index <= size; index += 1) {
    initial[`reverse${index}`] = 0;
  }

  const store = createBoltStore(initial);
  const start = performance.now();

  for (let index = size - 1; index >= 0; index -= 1) {
    const source = `reverse${index + 1}`;
    store.deriveUnsafe(
      `reverse${index}`,
      [source],
      ({ get }) => Number(get(source)) + 1,
      { initialize: false },
    );
  }
  const durationMs = performance.now() - start;

  store.set(`reverse${size}`, 1);

  if (store.get("reverse0") !== size + 1) {
    throw new Error("reverse chain did not settle");
  }

  return durationMs;
}

function registerHighFanBridge(size: number) {
  const inputs: Record<string, number> = {};
  const producers: Record<string, number> = {};
  const outputs: Record<string, number> = {};
  const producerPaths: string[] = [];

  for (let index = 0; index < size; index += 1) {
    const key = `p${index}`;
    inputs[key] = 0;
    producers[key] = 0;
    outputs[key] = 0;
    producerPaths.push(`producers.${key}`);
  }

  const store = createBoltStore({ bridge: 0, inputs, outputs, producers });

  for (let index = 0; index < size; index += 1) {
    const key = `p${index}`;
    store.deriveUnsafe(
      `producers.${key}`,
      [`inputs.${key}`],
      ({ get }) => Number(get(`inputs.${key}`)),
      { initialize: false },
    );
    store.deriveUnsafe(
      `outputs.${key}`,
      ["bridge"],
      ({ get }) => Number(get("bridge")) + index,
      { initialize: false },
    );
  }

  const start = performance.now();
  store.deriveUnsafe(
    "bridge",
    producerPaths,
    ({ get }) => producerPaths.reduce((total, path) => total + Number(get(path)), 0),
    { initialize: false },
  );
  const durationMs = performance.now() - start;

  store.set("inputs.p0", 1);

  if (store.get(`outputs.p${size - 1}`) !== size) {
    throw new Error("high-fan bridge did not settle");
  }

  return durationMs;
}

function disposeIndependentAndReregister(size: number) {
  const initial: Record<string, number> = {};

  for (let index = 0; index < size; index += 1) {
    initial[`source${index}`] = 0;
    initial[`target${index}`] = 0;
  }

  const store = createBoltStore(initial);
  const registerAll = () =>
    Array.from({ length: size }, (_, index) => {
      const source = `source${index}`;
      return store.deriveUnsafe(
        `target${index}`,
        [source],
        ({ get }) => Number(get(source)) + 1,
        { initialize: false },
      );
    });
  const disposers = registerAll();
  const start = performance.now();
  disposers.forEach((dispose) => dispose());
  const replacements = registerAll();
  const durationMs = performance.now() - start;

  store.set("source0", 1);

  if (store.get("target0") !== 2) {
    throw new Error("independent target did not re-register");
  }

  replacements.forEach((dispose) => dispose());
  return durationMs;
}

function disposeShortChainAndReregister(size: number) {
  const initial: Record<string, number> = {};

  for (let index = 0; index <= size; index += 1) {
    initial[`short${index}`] = 0;
  }

  const store = createBoltStore(initial);
  const registerChain = () =>
    Array.from({ length: size }, (_, offset) => {
      const index = offset + 1;
      const source = `short${index - 1}`;
      return store.deriveUnsafe(
        `short${index}`,
        [source],
        ({ get }) => Number(get(source)) + 1,
        { initialize: false },
      );
    });
  const disposers = registerChain();
  const start = performance.now();
  disposers.forEach((dispose) => dispose());
  const replacements = registerChain();
  const durationMs = performance.now() - start;

  store.set("short0", 1);

  if (store.get(`short${size}`) !== size + 1) {
    throw new Error("short chain did not re-register");
  }

  replacements.forEach((dispose) => dispose());
  return durationMs;
}

const workloads = [
  ["independent-registration", registerIndependent],
  ["chain-settlement", settleChain],
  ["wide-fanout-settlement", settleWideFanout],
  ["reverse-chain-registration", registerReverseChain],
  ["high-fan-bridge-registration", registerHighFanBridge],
  ["independent-dispose-reregister", disposeIndependentAndReregister],
  ["short-chain-dispose-reregister", disposeShortChainAndReregister],
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
