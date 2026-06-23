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

type SnapshotState = {
  cells: Record<string, number>;
  revision: number;
};

type BenchmarkResult = {
  cellRenders: number;
  commits: number;
  dispatchMs: number;
  totalChangedValues: number;
  totalMs: number;
  updatesPerMs: number;
};

type BenchmarkHandle = {
  reset: () => Promise<void>;
  run: (snapshots: readonly SnapshotState[]) => Promise<BenchmarkResult>;
};

type EngineId = "legend" | "bolt";

type CellProps = {
  id: string;
  onRender: () => void;
};

const CELL_OPTIONS = [128, 512, 1024, 2048] as const;
const COMMIT_OPTIONS = [25, 100, 250, 500] as const;
const DEFAULT_CELL_COUNT = 512;
const DEFAULT_COMMIT_COUNT = 100;

const legendContext = createContext<Observable<SnapshotState> | null>(null);

const {
  Provider: BoltSnapshotProvider,
  useSet: useBoltSnapshotSet,
  useStore: useBoltSnapshotStore,
} = createBolt<SnapshotState>();

function createCellIds(count: number) {
  return Array.from({ length: count }, (_, index) => `cell-${index}`);
}

function createInitialState(ids: readonly string[]): SnapshotState {
  const cells: Record<string, number> = {};

  for (const id of ids) {
    cells[id] = 0;
  }

  return { cells, revision: 0 };
}

function createSnapshots(
  ids: readonly string[],
  commitCount: number,
): SnapshotState[] {
  let cells = createInitialState(ids).cells;
  const snapshots: SnapshotState[] = [];

  for (let revision = 1; revision <= commitCount; revision += 1) {
    const nextCells: Record<string, number> = {};

    for (const id of ids) {
      nextCells[id] = cells[id] + 1;
    }

    cells = nextCells;
    snapshots.push({ cells, revision });
  }

  return snapshots;
}

function LegendSnapshotProvider({
  children,
  state,
}: PropsWithChildren<{ state: SnapshotState }>) {
  const storeRef = useRef<Observable<SnapshotState>>(undefined);

  if (!storeRef.current) {
    storeRef.current = observable(state);
  }

  return createElement(
    legendContext.Provider,
    { value: storeRef.current },
    children,
  );
}

function useLegendSnapshot<T>(
  selector: (state: Observable<SnapshotState>) => T,
) {
  const store = useContext(legendContext);

  if (!store) {
    throw new Error("useLegendSnapshot must be used inside LegendSnapshotProvider");
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
  snapshots: readonly SnapshotState[],
  dispatchMs: number,
  totalMs: number,
  cellRenders: number,
): BenchmarkResult {
  const commits = snapshots.length;
  const cellCount = Object.keys(snapshots.at(-1)?.cells ?? {}).length;
  const totalChangedValues = commits * cellCount;

  return {
    cellRenders,
    commits,
    dispatchMs,
    totalChangedValues,
    totalMs,
    updatesPerMs: dispatchMs === 0 ? 0 : totalChangedValues / dispatchMs,
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

export function StressTest2Route() {
  const [cellCount, setCellCount] = useState<number>(DEFAULT_CELL_COUNT);
  const [commitCount, setCommitCount] = useState<number>(DEFAULT_COMMIT_COUNT);
  const [isRunning, setIsRunning] = useState(false);
  const [summary, setSummary] = useState("No benchmark run yet");
  const ids = useMemo(() => createCellIds(cellCount), [cellCount]);
  const initialState = useMemo(() => createInitialState(ids), [ids]);
  const snapshots = useMemo(
    () => createSnapshots(ids, commitCount),
    [commitCount, ids],
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
      results[engine] = await handles[engine].run(snapshots);
      await waitForPaint();
    }

    setSummary(resultSummary(results.bolt, results.legend));
    setIsRunning(false);
  }, [isRunning, snapshots]);

  return (
    <main className="min-h-dvh bg-paper px-5 py-7 text-ink sm:px-8 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-5 border-b border-ink/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
              React · Snapshot commit test
            </span>
            <h1 className="font-serif text-3xl font-medium leading-none text-ink sm:text-4xl">
              Legend State vs Bolt
            </h1>
            <p className="max-w-xl text-sm leading-6 text-ink-soft">
              Bulk root-state commits where every mounted cell changes every
              commit.
            </p>
          </div>

          <a
            href="/stress-test"
            className="w-fit rounded-md border border-ink/15 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ink-soft transition hover:border-ink/40 hover:text-ink"
          >
            Leaf-write test
          </a>
        </header>

        <section className="grid gap-3 rounded-lg border border-ink/10 bg-card p-3 sm:grid-cols-[repeat(3,minmax(0,1fr))]">
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
              Commits
            </span>
            <select
              className="h-10 rounded-md border border-ink/10 bg-white px-3 font-mono text-sm text-ink"
              disabled={isRunning}
              onChange={(event) => setCommitCount(Number(event.target.value))}
              value={commitCount}
            >
              {COMMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {formatNumber(option)}
                </option>
              ))}
            </select>
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
          {summary}
        </div>

        <section
          className="grid gap-4 lg:grid-cols-2"
          key={`${cellCount}-${commitCount}`}
        >
          <LegendSnapshotProvider state={initialState}>
            <LegendBenchmarkPanel ids={ids} ref={legendRef} />
          </LegendSnapshotProvider>

          <BoltSnapshotProvider state={initialState}>
            <BoltBenchmarkPanel ids={ids} ref={boltRef} />
          </BoltSnapshotProvider>
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
      throw new Error("LegendBenchmarkPanel must be used inside LegendSnapshotProvider");
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
      async (snapshots: readonly SnapshotState[]) => {
        setPhase("running");
        await waitForPaint();
        cellRenderCount.current = 0;

        const startedAt = performance.now();

        for (const snapshot of snapshots) {
          store.set(snapshot);
        }

        const dispatchMs = performance.now() - startedAt;
        await waitForPaint();

        const nextResult = buildResult(
          snapshots,
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
    const set = useBoltSnapshotSet();
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
      async (snapshots: readonly SnapshotState[]) => {
        setPhase("running");
        await waitForPaint();
        cellRenderCount.current = 0;

        const startedAt = performance.now();

        for (const snapshot of snapshots) {
          set("", snapshot);
        }

        const dispatchMs = performance.now() - startedAt;
        await waitForPaint();

        const nextResult = buildResult(
          snapshots,
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
            label="commits"
            value={result ? formatNumber(result.commits) : "-"}
          />
          <Metric
            label="changed values"
            value={result ? formatNumber(result.totalChangedValues) : "-"}
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
  const count = useLegendSnapshot((store) => store.cells[id].get());
  onRender();

  return <SnapshotCell count={count} id={id} />;
});

const BoltCell = memo(function BoltCell({ id, onRender }: CellProps) {
  const count = useBoltSnapshotStore(["cells", id]);
  onRender();

  return <SnapshotCell count={count} id={id} />;
});

function SnapshotCell({ count, id }: { count: number; id: string }) {
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
