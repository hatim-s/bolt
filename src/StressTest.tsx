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
import { createBolt } from "bolt-react-store";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

type StressState = {
  cells: Record<string, number>;
};

type ZustandStressState = {
  state: StressState;
  reset: (state: StressState) => void;
  setCell: (id: string, updater: (previous: number) => number) => void;
};

type BenchmarkResult = {
  cellRenders: number;
  dispatchMs: number;
  renderRatio: number;
  totalMs: number;
  touchedCells: number;
  updates: number;
  updatesPerMs: number;
};

type BenchmarkHandle = {
  reset: () => Promise<void>;
  run: (sequence: readonly string[]) => Promise<BenchmarkResult>;
};

type EngineId = "zustand" | "bolt";

type CellProps = {
  id: string;
  onRender: () => void;
};

const CELL_OPTIONS = [128, 512, 1024, 2048] as const;
const UPDATE_OPTIONS = [1_000, 5_000, 10_000, 25_000] as const;
const DEFAULT_CELL_COUNT = 512;
const DEFAULT_SEED = 11;
const DEFAULT_UPDATE_COUNT = 10_000;

const zustandContext = createContext<StoreApi<ZustandStressState> | null>(null);

const {
  Provider: BoltStressProvider,
  useSet: useBoltStressSet,
  useStore: useBoltStressStore,
} = createBolt<StressState>();

function createStressState(ids: readonly string[]): StressState {
  const cells: Record<string, number> = {};

  for (const id of ids) {
    cells[id] = 0;
  }

  return { cells };
}

function createCellIds(count: number) {
  return Array.from({ length: count }, (_, index) => `cell-${index}`);
}

function createMutationSequence(
  ids: readonly string[],
  updateCount: number,
  seed: number,
) {
  let value = seed || DEFAULT_SEED;
  const sequence: string[] = [];

  for (let index = 0; index < updateCount; index += 1) {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    sequence.push(ids[value % ids.length]);
  }

  return sequence;
}

function createZustandStressStore(initialState: StressState) {
  return createStore<ZustandStressState>((set) => ({
    state: initialState,
    reset: (state) => set({ state }),
    setCell: (id, updater) => {
      set(({ state }) => ({
        state: {
          cells: {
            ...state.cells,
            [id]: updater(state.cells[id] ?? 0),
          },
        },
      }));
    },
  }));
}

function ZustandStressProvider({
  children,
  state,
}: PropsWithChildren<{ state: StressState }>) {
  const storeRef = useRef<StoreApi<ZustandStressState>>(undefined);

  if (!storeRef.current) {
    storeRef.current = createZustandStressStore(state);
  }

  return createElement(
    zustandContext.Provider,
    { value: storeRef.current },
    children,
  );
}

function useZustandStress<T>(selector: (state: ZustandStressState) => T) {
  const store = useContext(zustandContext);

  if (!store) {
    throw new Error("useZustandStress must be used inside ZustandStressProvider");
  }

  return useStore(store, selector);
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function buildResult(
  sequence: readonly string[],
  dispatchMs: number,
  totalMs: number,
  cellRenders: number,
): BenchmarkResult {
  const updates = sequence.length;

  return {
    cellRenders,
    dispatchMs,
    renderRatio: updates === 0 ? 0 : cellRenders / updates,
    totalMs,
    touchedCells: new Set(sequence).size,
    updates,
    updatesPerMs: dispatchMs === 0 ? 0 : updates / dispatchMs,
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
  zustandResult: BenchmarkResult,
  boltResult: BenchmarkResult,
) {
  const winner = boltResult.totalMs <= zustandResult.totalMs ? "Bolt" : "Zustand";
  const faster = Math.min(zustandResult.totalMs, boltResult.totalMs);
  const slower = Math.max(zustandResult.totalMs, boltResult.totalMs);
  const delta = slower === 0 ? 0 : ((slower - faster) / slower) * 100;

  return `${winner} lower total-to-paint by ${delta.toFixed(1)}%`;
}

export function StressTestRoute() {
  const [cellCount, setCellCount] = useState<number>(DEFAULT_CELL_COUNT);
  const [updateCount, setUpdateCount] = useState<number>(DEFAULT_UPDATE_COUNT);
  const [seed, setSeed] = useState<number>(DEFAULT_SEED);
  const [isRunning, setIsRunning] = useState(false);
  const [summary, setSummary] = useState("No benchmark run yet");
  const ids = useMemo(() => createCellIds(cellCount), [cellCount]);
  const initialState = useMemo(() => createStressState(ids), [ids]);
  const zustandRef = useRef<BenchmarkHandle>(null);
  const boltRef = useRef<BenchmarkHandle>(null);
  const runCountRef = useRef(0);

  const resetPanels = useCallback(async () => {
    setIsRunning(true);
    await Promise.all([zustandRef.current?.reset(), boltRef.current?.reset()]);
    setSummary("Stores reset");
    setIsRunning(false);
  }, []);

  const runBoth = useCallback(async () => {
    const boltHandle = boltRef.current;
    const zustandHandle = zustandRef.current;

    if (!boltHandle || !zustandHandle || isRunning) {
      return;
    }

    const handles: Record<EngineId, BenchmarkHandle> = {
      bolt: boltHandle,
      zustand: zustandHandle,
    };

    setIsRunning(true);

    const sequence = createMutationSequence(ids, updateCount, seed);
    const order: EngineId[] =
      runCountRef.current % 2 === 0 ? ["zustand", "bolt"] : ["bolt", "zustand"];
    runCountRef.current += 1;

    await Promise.all([handles.zustand.reset(), handles.bolt.reset()]);
    await waitForPaint();
    setSummary(`Running ${order.join(" then ")}`);

    const results = {} as Record<EngineId, BenchmarkResult>;

    for (const engine of order) {
      setSummary(`Running ${engine}`);
      results[engine] = await handles[engine].run(sequence);
      await waitForPaint();
    }

    setSummary(resultSummary(results.zustand, results.bolt));
    setIsRunning(false);
  }, [ids, isRunning, seed, updateCount]);

  return (
    <main className="min-h-dvh bg-paper px-5 py-7 text-ink sm:px-8 lg:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-5 border-b border-ink/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-2xl flex-col gap-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
              React · Store stress test
            </span>
            <h1 className="font-serif text-3xl font-medium leading-none text-ink sm:text-4xl">
              Zustand vs Bolt
            </h1>
            <p className="max-w-xl text-sm leading-6 text-ink-soft">
              Same mounted grid, same deterministic mutation sequence, same
              leaf-level subscriptions.
            </p>
          </div>

          <a
            href="/"
            className="w-fit rounded-md border border-ink/15 px-3 py-2 font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ink-soft transition hover:border-ink/40 hover:text-ink"
          >
            Fruit counter
          </a>
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
              Updates
            </span>
            <select
              className="h-10 rounded-md border border-ink/10 bg-white px-3 font-mono text-sm text-ink"
              disabled={isRunning}
              onChange={(event) => setUpdateCount(Number(event.target.value))}
              value={updateCount}
            >
              {UPDATE_OPTIONS.map((option) => (
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
              onClick={runBoth}
              type="button"
            >
              {isRunning ? "Running" : "Run both"}
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
          key={`${cellCount}-${seed}`}
        >
          <ZustandStressProvider state={initialState}>
            <ZustandBenchmarkPanel ids={ids} ref={zustandRef} />
          </ZustandStressProvider>

          <BoltStressProvider state={initialState}>
            <BoltBenchmarkPanel ids={ids} ref={boltRef} />
          </BoltStressProvider>
        </section>
      </div>
    </main>
  );
}

const ZustandBenchmarkPanel = forwardRef<BenchmarkHandle, { ids: string[] }>(
  function ZustandBenchmarkPanel({ ids }, ref) {
    const setCell = useZustandStress((store) => store.setCell);
    const resetStore = useZustandStress((store) => store.reset);
    const [phase, setPhase] = useState("idle");
    const [result, setResult] = useState<BenchmarkResult | null>(null);
    const cellRenderCount = useRef(0);

    const onCellRender = useCallback(() => {
      cellRenderCount.current += 1;
    }, []);

    const reset = useCallback(async () => {
      resetStore(createStressState(ids));
      cellRenderCount.current = 0;
      setResult(null);
      setPhase("idle");
      await waitForPaint();
    }, [ids, resetStore]);

    const run = useCallback(
      async (sequence: readonly string[]) => {
        setPhase("running");
        await waitForPaint();
        cellRenderCount.current = 0;

        const startedAt = performance.now();

        for (const id of sequence) {
          setCell(id, (previous) => previous + 1);
        }

        const dispatchMs = performance.now() - startedAt;
        await waitForPaint();

        const nextResult = buildResult(
          sequence,
          dispatchMs,
          performance.now() - startedAt,
          cellRenderCount.current,
        );

        setResult(nextResult);
        setPhase("done");
        return nextResult;
      },
      [setCell],
    );

    useImperativeHandle(ref, () => ({ reset, run }), [reset, run]);

    return (
      <BenchmarkPanel
        accentClassName="bg-[#2f7d62]"
        cellComponent={ZustandCell}
        engine="Zustand"
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
    const set = useBoltStressSet();
    const [phase, setPhase] = useState("idle");
    const [result, setResult] = useState<BenchmarkResult | null>(null);
    const cellRenderCount = useRef(0);

    const onCellRender = useCallback(() => {
      cellRenderCount.current += 1;
    }, []);

    const reset = useCallback(async () => {
      set("", createStressState(ids));
      cellRenderCount.current = 0;
      setResult(null);
      setPhase("idle");
      await waitForPaint();
    }, [ids, set]);

    const run = useCallback(
      async (sequence: readonly string[]) => {
        setPhase("running");
        await waitForPaint();
        cellRenderCount.current = 0;

        const startedAt = performance.now();

        for (const id of sequence) {
          set(["cells", id], (previous) => previous + 1);
        }

        const dispatchMs = performance.now() - startedAt;
        await waitForPaint();

        const nextResult = buildResult(
          sequence,
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
            value={result ? formatMs(result.dispatchMs) : "—"}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label="paint" value={result ? formatMs(result.totalMs) : "—"} />
          <Metric
            label="rate"
            value={result ? formatRate(result.updatesPerMs) : "—"}
          />
          <Metric
            label="cell renders"
            value={result ? formatNumber(result.cellRenders) : "—"}
          />
          <Metric
            label="updates"
            value={result ? formatNumber(result.updates) : "—"}
          />
          <Metric
            label="touched"
            value={result ? formatNumber(result.touchedCells) : "—"}
          />
          <Metric
            label="renders/update"
            value={result ? result.renderRatio.toFixed(2) : "—"}
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

const ZustandCell = memo(function ZustandCell({ id, onRender }: CellProps) {
  const count = useZustandStress((store) => store.state.cells[id] ?? 0);
  onRender();

  return <StressCell count={count} id={id} />;
});

const BoltCell = memo(function BoltCell({ id, onRender }: CellProps) {
  const count = useBoltStressStore(["cells", id]);
  onRender();

  return <StressCell count={count} id={id} />;
});

function StressCell({ count, id }: { count: number; id: string }) {
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
