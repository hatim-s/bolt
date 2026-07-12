import { execFileSync } from "node:child_process";
import { cpus, arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import {
  immutableWorkloads,
  type CreateBoltStore,
  type WorkloadSample,
} from "./workloads";

type EntryArgument = {
  label: string;
  path: string;
};

type LoadedEntry = EntryArgument & {
  createBoltStore: CreateBoltStore;
  git: {
    branch: string | null;
    dirty: boolean | null;
    sha: string | null;
  };
  resolvedPath: string;
};

type Options = {
  entries: EntryArgument[];
  iterations: number;
  jsonPath: string | null;
  measuredPasses: number;
  warmupPasses: number;
};

type BenchmarkResult = {
  checksum: number;
  description: string;
  durationsMs: number[];
  entry: string;
  medianMs: number;
  operations: number;
  operationsPerSecond: number;
  p95Ms: number;
  workload: string;
};

const DEFAULT_JSON_PATH = "artifacts/benchmarks/immutable.json";

function readPositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received ${value}`);
  }

  return parsed;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  args.splice(index, 2);
  return value;
}

function parseEntry(value: string): EntryArgument {
  const separator = value.indexOf("=");

  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`--entry must use label=path, received ${value}`);
  }

  return {
    label: value.slice(0, separator),
    path: value.slice(separator + 1),
  };
}

function parseOptions(argv: string[]): Options {
  const args = [...argv];
  const options: Options = {
    entries: [],
    iterations: 25_000,
    jsonPath: null,
    measuredPasses: 9,
    warmupPasses: 3,
  };

  for (let index = 0; index < args.length; ) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      console.log(`Immutable update benchmark

Usage:
  bun benchmarks/run.ts [options]

Options:
  --entry label=path   Entry module exporting createBoltStore; repeat to compare
  --warmups number     Discarded warmup passes (default: 3)
  --passes number      Measured passes (default: 9)
  --iterations number  Base operations per pass (default: 25000)
  --json [path]        Write machine-readable results (default artifact path)
  --help               Show this message

Example:
  bun benchmarks/run.ts \\
    --entry base=/tmp/bolt-main/dist/index.js \\
    --entry candidate=./dist/index.js \\
    --json artifacts/benchmarks/pr3.json`);
      process.exit(0);
    }

    if (argument.startsWith("--entry=")) {
      options.entries.push(parseEntry(argument.slice("--entry=".length)));
      args.splice(index, 1);
      continue;
    }

    if (argument === "--entry") {
      options.entries.push(parseEntry(takeValue(args, index, argument)));
      continue;
    }

    if (argument === "--warmups") {
      options.warmupPasses = readPositiveInteger(
        takeValue(args, index, argument),
        argument,
      );
      continue;
    }

    if (argument === "--passes") {
      options.measuredPasses = readPositiveInteger(
        takeValue(args, index, argument),
        argument,
      );
      continue;
    }

    if (argument === "--iterations") {
      options.iterations = readPositiveInteger(
        takeValue(args, index, argument),
        argument,
      );
      continue;
    }

    if (argument.startsWith("--json=")) {
      options.jsonPath = argument.slice("--json=".length) || DEFAULT_JSON_PATH;
      args.splice(index, 1);
      continue;
    }

    if (argument === "--json") {
      const next = args[index + 1];
      options.jsonPath =
        next && !next.startsWith("--")
          ? takeValue(args, index, argument)
          : DEFAULT_JSON_PATH;

      if (!next || next.startsWith("--")) {
        args.splice(index, 1);
      }
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.entries.length === 0) {
    options.entries.push({
      label: "candidate",
      path: fileURLToPath(new URL("../src/bolt/index.ts", import.meta.url)),
    });
  }

  const labels = new Set<string>();

  for (const entry of options.entries) {
    if (labels.has(entry.label)) {
      throw new Error(`Duplicate entry label: ${entry.label}`);
    }
    labels.add(entry.label);
  }

  return options;
}

function gitValue(directory: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function loadEntry(entry: EntryArgument): Promise<LoadedEntry> {
  const resolvedPath = resolve(entry.path);
  const moduleUrl = pathToFileURL(resolvedPath);
  moduleUrl.searchParams.set("benchmark-entry", entry.label);
  const imported = (await import(moduleUrl.href)) as {
    createBoltStore?: CreateBoltStore;
    default?: { createBoltStore?: CreateBoltStore };
  };
  const createBoltStore =
    imported.createBoltStore ?? imported.default?.createBoltStore;

  if (typeof createBoltStore !== "function") {
    throw new Error(
      `${entry.label} (${resolvedPath}) does not export createBoltStore`,
    );
  }

  const entryDirectory = dirname(resolvedPath);
  const repositoryRoot = gitValue(entryDirectory, ["rev-parse", "--show-toplevel"]);

  return {
    ...entry,
    createBoltStore,
    git: {
      branch: repositoryRoot
        ? gitValue(repositoryRoot, ["branch", "--show-current"])
        : null,
      dirty: repositoryRoot
        ? gitValue(repositoryRoot, ["status", "--porcelain"]) !== ""
        : null,
      sha: repositoryRoot ? gitValue(repositoryRoot, ["rev-parse", "HEAD"]) : null,
    },
    resolvedPath,
  };
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  if (values.length < 2) {
    return [...values];
  }

  const start = offset % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values: readonly number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index];
}

function collectResult(
  entry: LoadedEntry,
  workload: (typeof immutableWorkloads)[number],
  samples: WorkloadSample[],
): BenchmarkResult {
  const durationsMs = samples.map((sample) => sample.durationMs);
  const operations = samples[0].operations;
  const checksum = samples[0].checksum;

  for (const sample of samples) {
    if (sample.operations !== operations || sample.checksum !== checksum) {
      throw new Error(
        `${entry.label}/${workload.name} produced inconsistent measured samples`,
      );
    }
  }

  const medianMs = median(durationsMs);

  return {
    checksum,
    description: workload.description,
    durationsMs,
    entry: entry.label,
    medianMs,
    operations,
    operationsPerSecond: medianMs === 0 ? 0 : (operations / medianMs) * 1_000,
    p95Ms: percentile(durationsMs, 0.95),
    workload: workload.name,
  };
}

function tryGarbageCollection(): void {
  const maybeGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  maybeGc?.();
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const entries = await Promise.all(options.entries.map(loadEntry));
  const results: BenchmarkResult[] = [];

  for (const workload of immutableWorkloads) {
    for (let pass = 0; pass < options.warmupPasses; pass += 1) {
      for (const entry of rotate(entries, pass)) {
        tryGarbageCollection();
        workload.run(entry.createBoltStore, options.iterations);
      }
    }

    const samplesByEntry = new Map<string, WorkloadSample[]>(
      entries.map((entry) => [entry.label, []]),
    );

    for (let pass = 0; pass < options.measuredPasses; pass += 1) {
      for (const entry of rotate(entries, pass)) {
        tryGarbageCollection();
        samplesByEntry
          .get(entry.label)
          ?.push(workload.run(entry.createBoltStore, options.iterations));
      }
    }

    for (const entry of entries) {
      const samples = samplesByEntry.get(entry.label);

      if (!samples || samples.length !== options.measuredPasses) {
        throw new Error(`Missing measured samples for ${entry.label}/${workload.name}`);
      }

      results.push(collectResult(entry, workload, samples));
    }
  }

  console.table(
    results.map((result) => ({
      checksum: result.checksum,
      entry: result.entry,
      "median ms": result.medianMs.toFixed(3),
      "ops/sec": Math.round(result.operationsPerSecond),
      "p95 ms": result.p95Ms.toFixed(3),
      workload: result.workload,
    })),
  );

  const report = {
    config: {
      iterations: options.iterations,
      measuredPasses: options.measuredPasses,
      warmupPasses: options.warmupPasses,
    },
    entries: entries.map(({ git, label, path, resolvedPath }) => ({
      git,
      label,
      path,
      resolvedPath,
    })),
    environment: {
      arch: arch(),
      bun: process.versions.bun ?? "unknown",
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      node: process.versions.node,
      platform: platform(),
      release: release(),
      v8: process.versions.v8,
    },
    generatedAt: new Date().toISOString(),
    results,
    schemaVersion: 1,
  };

  if (options.jsonPath) {
    const outputPath = resolve(options.jsonPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`JSON: ${outputPath}`);
  }
}

await main();
