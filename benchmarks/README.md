# Immutable update benchmarks

This runner measures Bolt's public `createBoltStore` API. It keeps correctness
checks outside timed sections, discards warmups, alternates entry order, and
reports median and p95 across measured passes.

Default candidate run:

```sh
bun run bench:immutable
```

Compare built base and candidate artifacts in one process:

```sh
bun benchmarks/run.ts \
  --entry base=/tmp/bolt-main/dist/index.js \
  --entry candidate=./dist/index.js \
  --warmups 3 \
  --passes 9 \
  --iterations 25000 \
  --json artifacts/benchmarks/pr3.json
```

Build both entries first. Benchmark `dist/index.js`, not source, for release-like
numbers. Run on an idle machine with the same Bun version and power settings.
Generated `artifacts/` stay untracked.

Workloads cover subscribed leaf writes, deep writes, mutation-style object
updaters, and no-op writes. Every pass validates final values, notification
counts, old snapshots, untouched sibling identity, and a deterministic checksum.
Timing never gates tests: compare medians from the same machine and treat p95 as
noise evidence, not a release threshold.

## Derived graph benchmarks

```sh
bun run bench:derived:json
```

This records three measured passes after one warmup at 1,024, 2,048, and 4,096
nodes. It covers independent registration, forward and reverse chains,
wide-fan-out settlement, high-fan-in/high-fan-out bridge registration, and
independent/short-chain dispose-and-reregister workloads. The matching stress
suite asserts each affected derived node computes exactly once, so timings are
evidence rather than the correctness gate.
