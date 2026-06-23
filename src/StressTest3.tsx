import {
  createContext,
  createElement,
  forwardRef,
  memo,
  type ComponentType,
  type PropsWithChildren,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createBolt } from "@hatimcodes/bolt";
import { observable, type Observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";

type MixedState = {
  cells: Record<string, number>;
  revision: number;
};

type WorkloadStep =
  | {
      id: string;
      kind: "leaf";
      update: CellUpdate;
    }
  | {
      id: string;
      kind: "burst";
      updates: CellUpdate[];
    }
  | {
      id: string;
      kind: "snapshot";
      state: MixedState;
      updateCount: number;
    };

type CellUpdate = {
  id: string;
  value: number;
};

type WorkloadStats = {
  burstSteps: number;
  leafSteps: number;
  snapshotSteps: number;
  totalChangedValues: number;
};

type BenchmarkResult = WorkloadStats & {
  cellRenders: number;
  dispatchMs: number;
  steps: number;
  totalMs: number;
  updatesPerMs: number;
};

type BenchmarkHandle = {
  reset: () => Promise<void>;
  run: (
    steps: readonly WorkloadStep[],
    stats: WorkloadStats,
  ) => Promise<BenchmarkResult>;
};

type EngineId = "legend" | "bolt";

type CellProps = {
  id: string;
  onRender: () => void;
};

const CELL_OPTIONS = [128, 512, 1024, 2048] as const;
const STEP_OPTIONS = [250, 1000, 2500, 5000] as const;
const DEFAULT_CELL_COUNT = 512;
const DEFAULT_SEED = 17;
const DEFAULT_STEP_COUNT = 1000;
const BURST_SIZE = 8;
const SNAPSHOT_CHANGE_RATIO = 0.1;

const legendContext = createContext<Observable<MixedState> | null>(null);

const {
  Provider: BoltMixedProvider,
  useSet: useBoltMixedSet,
  useStore: useBoltMixedStore,
} = createBolt<MixedState>();

function createCellIds(count: number) {
  return Array.from({ length: count }, (_, index) => `cell-${index}`);
}

function createInitialState(ids: readonly string[]): MixedState {
  const cells: Record<string, number> = {};

  for (const id of ids) {
    cells[id] = 0;
  }

  return { cells, revision: 0 };
}

function nextRandom(value: number) {
  return (value * 1_664_525 + 1_013_904_223) >>> 0;
}

function createMixedWorkload(
  ids: readonly string[],
  stepCount: number,
  seed: number,
) {
  let random = seed || DEFAULT_SEED;
  let state = createInitialState(ids);
  const steps: WorkloadStep[] = [];
  const stats: WorkloadStats = {
    burstSteps: 0,
    leafSteps: 0,
    snapshotSteps: 0,
    totalChangedValues: 0,
  };
  const snapshotChangeCount = Math.max(
    1,
    Math.round(ids.length * SNAPSHOT_CHANGE_RATIO),
  );

  for (let index = 0; index < stepCount; index += 1) {
    random = nextRandom(random);
    const roll = random % 100;

    if (roll < 70) {
      random = nextRandom(random);
      const id = ids[random % ids.length];
      const value = state.cells[id] + 1;
      state = {
        cells: { ...state.cells, [id]: value },
        revision: state.revision + 1,
      };
      steps.push({ id: `leaf-${index}`, kind: "leaf", update: { id, value } });
      stats.leafSteps += 1;
      stats.totalChangedValues += 1;
      continue;
    }

    if (roll < 95) {
      random = nextRandom(random);
      const start = random % ids.length;
      const updates: CellUpdate[] = [];
      const cells = { ...state.cells };

      for (let offset = 0; offset < BURST_SIZE; offset += 1) {
        const id = ids[(start + offset) % ids.length];
        const value = cells[id] + 1;
        cells[id] = value;
        updates.push({ id, value });
      }

      state = { cells, revision: state.revision + 1 };
      steps.push({ id: `burst-${index}`, kind: "burst", updates });
      stats.burstSteps += 1;
      stats.totalChangedValues += updates.length;
      continue;
    }

    random = nextRandom(random);
    const start = random % ids.length;
    const cells = { ...state.cells };

    for (let offset = 0; offset < snapshotChangeCount; offset += 1) {
      const id = ids[(start + offset) % ids.length];
      cells[id] += 1;
    }

    state = { cells, revision: state.revision + 1 };
    steps.push({
      id: `snapshot-${index}`,
      kind: "snapshot",
      state,
      updateCount: snapshotChangeCount,
    });
    stats.snapshotSteps += 1;
    stats.totalChangedValues += snapshotChangeCount;
  }

  return { stats, steps };
}

function LegendMixedProvider({
  children,
  state,
}: PropsWithChildren<{ state: MixedState }>) {
  const storeRef = useRef<Observable<MixedState>>(undefined);

  if (!storeRef.current) {
    storeRef.current = observable(state);
  }

  return createElement(
    legendContext.Provider,
    { value: storeRef.current },
    children,
  );
}

function useLegendMixed<T>(selector: (state: Observable<MixedState>) => T) {
  const store = useContext(legendContext);

  if (!store) {
    throw new Error("useLegendMixed must be used inside LegendMixedProvider");
  }

  return useSelector(() => selector(store));
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function buildResult(
  steps: readonly WorkloadStep[],
  stats: WorkloadStats,
  dispatchMs: number,
  totalMs: number,
  cellRenders: number,
): BenchmarkResult {
  return {
    ...stats,
    cellRenders,
    dispatchMs,
    steps: steps.length,
    totalMs,
    updatesPerMs:
      dispatchMs === 0 ? 0 : stats.totalChangedValues / dispatchMs,
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatMs(value: number) {
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function formatRate(value: number) {
  return `${formatNumber(Math.round(value))}/ms`;
}

function resultSummary(
  boltResult: BenchmarkResult,
  legendResult: BenchmarkResult,
) {
  const winner =
    boltResult.totalMs <= legendResult.totalMs ? "Bolt" : "Legend State";
  const faster = Math.min(legendResult.totalMs, boltResult.totalMs);
  const slower = Math.max(legendResult.totalMs, boltResult.totalMs);
  const delta = slower === 0 ? 0 : ((slower - faster) / slower) * 100;
  const ratio = faster === 0 ? 0 : slower / faster;

  return `${winner} lower total-to-paint by ${delta.toFixed(1)}% (${ratio.toFixed(2)}x)`;
}

export function StressTest3Route() {
  const [cellCount, setCellCount] = useState<number>(DEFAULT_CELL_COUNT);
  const [stepCount, setStepCount] = useState<number>(DEFAULT_STEP_COUNT);
  const [seed, setSeed] = useState<number>(DEFAULT_SEED);
  const [isRunning, setIsRunning] = useState(false);
  const [summary, setSummary] = useState("No benchmark run yet");
  const ids = useMemo(() => createCellIds(cellCount), [cellCount]);
  const initialState = useMemo(() => createInitialState(ids), [ids]);
  const workload = useMemo(
    () => createMixedWorkload(ids, stepCount, seed),
    [ids, seed, stepCount],
  );
  const legendRef = useRef<BenchmarkHandle>(null);
  const boltRef = useRef<BenchmarkHandle>(null);
  const runCountRef = useRef(0);

  const resetPanels = useCallback(async () => {
    setIsRunning(true);
    await Promise.all([legendRef.current?.reset(), boltRef.current?.reset()]);
    setSummary("Stores reset");
    setIsRunning(false);
  }, []);

  const runBenchmark = useCallback(async () => {
    const boltHandle = boltRef.current;
    const legendHandle = legendRef.current;

    if (!boltHandle || !legendHandle || isRunning) {
      return;
    }

    const handles: Record<EngineId, BenchmarkHandle> = {
      bolt: boltHandle,
      legend: legendHandle,
    };
    const order: EngineId[] =
      runCountRef.current % 2 === 0 ? ["legend", "bolt"] : ["bolt", "legend"];
    const results = {} as Record<EngineId, BenchmarkResult>;

    runCountRef.current += 1;
    setIsRunning(true);
    await Promise.all([handles.legend.reset(), handles.bolt.reset()]);
    await waitForPaint();
    setSummary(`Running ${order.join(" then ")}`);

    for (const engine of order) {
      setSummary(`Running ${engine}`);
      results[engine] = await handles[engine].run(
        workload.steps,
        workload.stats,
      );
      await waitForPaint();
    }

    setSummary(resultSummary(results.bolt, results.legend));
    setIsRunning(false);
  }, [isRunning, workload]);

  return (
    <main className="min-h-dvh bg-paper px-5 py-7 text-ink sm:px-8 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-5 border-b border-ink/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
              React · Mixed workload test
            </span>
            <h1 className="font-serif text-3xl font-medium leading-none text-ink sm:text-4xl">
              Real-world blend
            </h1>
            <p className="max-w-xl text-sm leading-6 text-ink-soft">
              70% single-cell writes, 25% burst patches, 5% partial snapshots.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <a
              href="/stress-test"
              className="w-fit rounded-md border border-ink/15 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ink-soft transition hover:border-ink/40 hover:text-ink"
            >
              Leaf writes
            </a>
            <a
              href="/stress-test-2"
              className="w-fit rounded-md border border-ink/15 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ink-soft transition hover:border-ink/40 hover:text-ink"
            >
              Snapshots
            </a>
          </div>
        </header>

        <section className="grid gap-3 rounded-lg border border-ink/10 bg-card p-3 sm:grid-cols-[repeat(4,minmax(0,1fr))]">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ink-faint">
              Cells
            </span>
            <select
              className="h-10 rounded-md border border-ink/10 bg-white px-3 font-mono text-sm text-ink"
              disabled={isRunning}
              onChange={(event) => setCellCount(Number(event.target.value))}
              value={cellCount}
            >
              {CELL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {formatNumber(option)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ink-faint">
              Steps
            </span>
            <select
              className="h-10 rounded-md border border-ink/10 bg-white px-3 font-mono text-sm text-ink"
              disabled={isRunning}
              onChange={(event) => setStepCount(Number(event.target.value))}
              value={stepCount}
            >
              {STEP_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {formatNumber(option)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ink-faint">
              Seed
            </span>
            <input
              className="h-10 rounded-md border border-ink/10 bg-white px-3 font-mono text-sm text-ink"
              disabled={isRunning}
              min={1}
              onChange={(event) => setSeed(Number(event.target.value) || 1)}
              type="number"
              value={seed}
            />
          </label>

          <div className="flex items-end gap-2">
            <button
              className="h-10 flex-1 rounded-md bg-ink px-4 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-white transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isRunning}
              onClick={runBenchmark}
              type="button"
            >
              {isRunning ? "Running" : "Run benchmark"}
            </button>
            <button
              className="h-10 rounded-md border border-ink/15 px-3 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ink-soft transition hover:border-ink/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isRunning}
              onClick={resetPanels}
              type="button"
            >
              Reset
            </button>
          </div>
        </section>

        <div className="rounded-md border border-ink/10 bg-white px-3 py-2 font-mono text-xs text-ink-soft">
          {summary} · Leaf {formatNumber(workload.stats.leafSteps)} · Burst{" "}
          {formatNumber(workload.stats.burstSteps)} · Snapshot{" "}
          {formatNumber(workload.stats.snapshotSteps)}
        </div>

        <section
          className="grid gap-4 lg:grid-cols-2"
          key={`${cellCount}-${stepCount}-${seed}`}
        >
          <LegendMixedProvider state={initialState}>
            <LegendBenchmarkPanel ids={ids} ref={legendRef} />
          </LegendMixedProvider>

          <BoltMixedProvider state={initialState}>
            <BoltBenchmarkPanel ids={ids} ref={boltRef} />
          </BoltMixedProvider>
        </section>
      </div>
    </main>
  );
}

const LegendBenchmarkPanel = forwardRef<BenchmarkHandle, { ids: string[] }>(
  function LegendBenchmarkPanel({ ids }, ref) {
    const store = useContext(legendContext);
    const [phase, setPhase] = useState("idle");
    const [result, setResult] = useState<BenchmarkResult | null>(null);
    const cellRenderCount = useRef(0);

    if (!store) {
      throw new Error("LegendBenchmarkPanel must be used inside LegendMixedProvider");
    }

    const onCellRender = useCallback(() => {
      cellRenderCount.current += 1;
    }, []);

    const reset = useCallback(async () => {
      store.set(createInitialState(ids));
      cellRenderCount.current = 0;
      setResult(null);
      setPhase("idle");
      await waitForPaint();
    }, [ids, store]);

    const run = useCallback(
      async (steps: readonly WorkloadStep[], stats: WorkloadStats) => {
        setPhase("running");
        await waitForPaint();
        cellRenderCount.current = 0;

        const startedAt = performance.now();

        for (const step of steps) {
          applyLegendStep(store, step);
        }

        const dispatchMs = performance.now() - startedAt;
        await waitForPaint();

        const nextResult = buildResult(
          steps,
          stats,
          dispatchMs,
          performance.now() - startedAt,
          cellRenderCount.current,
        );

        setResult(nextResult);
        setPhase("done");
        return nextResult;
      },
      [store],
    );

    useImperativeHandle(ref, () => ({ reset, run }), [reset, run]);

    return (
      <BenchmarkPanel
        accentClassName="bg-[#8b5d9f]"
        cellComponent={LegendCell}
        engine="Legend State"
        ids={ids}
        onCellRender={onCellRender}
        phase={phase}
        result={result}
      />
    );
  },
);

const BoltBenchmarkPanel = forwardRef<BenchmarkHandle, { ids: string[] }>(
  function BoltBenchmarkPanel({ ids }, ref) {
    const set = useBoltMixedSet();
    const [phase, setPhase] = useState("idle");
    const [result, setResult] = useState<BenchmarkResult | null>(null);
    const cellRenderCount = useRef(0);

    const onCellRender = useCallback(() => {
      cellRenderCount.current += 1;
    }, []);

    const reset = useCallback(async () => {
      set("", createInitialState(ids));
      cellRenderCount.current = 0;
      setResult(null);
      setPhase("idle");
      await waitForPaint();
    }, [ids, set]);

    const run = useCallback(
      async (steps: readonly WorkloadStep[], stats: WorkloadStats) => {
        setPhase("running");
        await waitForPaint();
        cellRenderCount.current = 0;

        const startedAt = performance.now();

        for (const step of steps) {
          applyBoltStep(set, step);
        }

        const dispatchMs = performance.now() - startedAt;
        await waitForPaint();

        const nextResult = buildResult(
          steps,
          stats,
          dispatchMs,
          performance.now() - startedAt,
          cellRenderCount.current,
        );

        setResult(nextResult);
        setPhase("done");
        return nextResult;
      },
      [set],
    );

    useImperativeHandle(ref, () => ({ reset, run }), [reset, run]);

    return (
      <BenchmarkPanel
        accentClassName="bg-[#356bb3]"
        cellComponent={BoltCell}
        engine="Bolt"
        ids={ids}
        onCellRender={onCellRender}
        phase={phase}
        result={result}
      />
    );
  },
);

function applyLegendStep(store: Observable<MixedState>, step: WorkloadStep) {
  if (step.kind === "snapshot") {
    store.set(step.state);
    return;
  }

  if (step.kind === "leaf") {
    store.cells[step.update.id].set(step.update.value);
    return;
  }

  for (const update of step.updates) {
    store.cells[update.id].set(update.value);
  }
}

function applyBoltStep(
  set: ReturnType<typeof useBoltMixedSet>,
  step: WorkloadStep,
) {
  if (step.kind === "snapshot") {
    set("", step.state);
    return;
  }

  if (step.kind === "leaf") {
    set(["cells", step.update.id], step.update.value);
    return;
  }

  for (const update of step.updates) {
    set(["cells", update.id], update.value);
  }
}

function BenchmarkPanel({
  accentClassName,
  cellComponent: Cell,
  engine,
  ids,
  onCellRender,
  phase,
  result,
}: {
  accentClassName: string;
  cellComponent: ComponentType<CellProps>;
  engine: string;
  ids: string[];
  onCellRender: () => void;
  phase: string;
  result: BenchmarkResult | null;
}) {
  return (
    <article className="overflow-hidden rounded-lg border border-ink/10 bg-card">
      <div className={`h-1.5 ${accentClassName}`} />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-serif text-2xl font-medium leading-none text-ink">
              {engine}
            </h2>
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ink-faint">
              {phase}
            </span>
          </div>
          <Metric
            label="dispatch"
            value={result ? formatMs(result.dispatchMs) : "-"}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label="paint" value={result ? formatMs(result.totalMs) : "-"} />
          <Metric
            label="rate"
            value={result ? formatRate(result.updatesPerMs) : "-"}
          />
          <Metric
            label="cell renders"
            value={result ? formatNumber(result.cellRenders) : "-"}
          />
          <Metric
            label="steps"
            value={result ? formatNumber(result.steps) : "-"}
          />
          <Metric
            label="changed values"
            value={result ? formatNumber(result.totalChangedValues) : "-"}
          />
          <Metric
            label="snapshots"
            value={result ? formatNumber(result.snapshotSteps) : "-"}
          />
        </div>

        <div className="grid max-h-[380px] grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1.5 overflow-auto pr-1">
          {ids.map((id) => (
            <Cell key={id} id={id} onRender={onCellRender} />
          ))}
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-ink/10 bg-white px-3 py-2">
      <div className="truncate font-mono text-base font-semibold tabular-nums text-ink">
        {value}
      </div>
      <div className="truncate font-mono text-[0.55rem] uppercase tracking-[0.16em] text-ink-faint">
        {label}
      </div>
    </div>
  );
}

const LegendCell = memo(function LegendCell({ id, onRender }: CellProps) {
  const count = useLegendMixed((store) => store.cells[id].get());
  onRender();

  return <MixedCell count={count} id={id} />;
});

const BoltCell = memo(function BoltCell({ id, onRender }: CellProps) {
  const count = useBoltMixedStore(["cells", id]);
  onRender();

  return <MixedCell count={count} id={id} />;
});

function MixedCell({ count, id }: { count: number; id: string }) {
  return (
    <div
      className="flex aspect-[5/3] min-w-0 flex-col justify-between rounded-md border border-ink/10 bg-white px-2 py-1.5"
      title={`${id}: ${count}`}
    >
      <span className="truncate font-mono text-[0.52rem] uppercase tracking-[0.14em] text-ink-faint">
        {id.replace("cell-", "#")}
      </span>
      <span className="truncate font-mono text-lg font-semibold leading-none tabular-nums text-ink">
        {count}
      </span>
    </div>
  );
}
