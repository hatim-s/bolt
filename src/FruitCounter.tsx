import { useCallback, useRef, type ReactNode } from "react";
import { State } from "./types";

export type CounterBinding = {
  count: number;
  increment: () => void;
};

export type UseCounter = (id: keyof State) => CounterBinding;

const cards = [
  { id: "apples", title: "Apples" },
  { id: "bananas", title: "Bananas" },
  { id: "oranges", title: "Oranges" },
  { id: "mangoes", title: "Mangoes" },
] as const;

export const INITIAL_STATE = cards.reduce(
  (acc, card) => {
    acc[card.id] = 0;
    return acc;
  },
  {} as Record<keyof State, number>,
) as State;

type CardProps = {
  id: keyof State;
  title: string;
  useCounter: UseCounter;
};

function Card({ id, title, useCounter }: CardProps) {
  const { count, increment } = useCounter(id);
  const renderCount = useRenderCount();

  const onClick = useCallback(() => {
    increment();
  }, [increment]);

  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-xl border border-ink/10 bg-card px-5 py-6 text-left cursor-pointer transition hover:border-ink-faint hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
    >
      <Flash key={renderCount} />
      <div className="relative flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-xl font-medium tracking-tight text-ink">
            {title}
          </h2>
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ink-faint">
            #{id}
          </span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <span className="font-serif text-4xl font-medium leading-none tabular-nums text-ink">
            {count}
          </span>
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ink-soft">
            renders {renderCount}
          </span>
        </div>
      </div>
    </button>
  );
}

export function RenderCount({ state }: { state: State }) {
  const renderCount = useRenderCount();
  const totalClicks = Object.values(state).reduce((sum, count) => sum + count, 0);

  return (
    <div className="relative overflow-hidden rounded-lg px-3 py-2">
      <Flash key={renderCount} />
      <Metric value={renderCount} label="app renders" />
      <Metric value={totalClicks} label="app clicks" />
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="relative flex items-baseline gap-2">
      <span className="font-mono text-lg font-semibold tabular-nums text-ink">
        {value}
      </span>
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-ink-faint">
        {label}
      </span>
    </div>
  );
}

function Flash() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-flash animate-flash"
    />
  );
}

function useRenderCount() {
  const renderCount = useRef(0);
  renderCount.current += 1;
  return renderCount.current;
}

type FruitCounterProps = {
  renderCounter: ReactNode;
  useCounter: UseCounter;
};

export function FruitCounter({ renderCounter, useCounter }: FruitCounterProps) {
  return (
    <main className="min-h-dvh bg-paper px-6 py-10 sm:px-12 sm:py-14">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <header className="flex items-end justify-between gap-6 border-b border-ink/10 pb-6">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-ink-faint">
              React · Render Playground
            </span>
            <h1 className="font-serif text-3xl font-medium leading-none tracking-tight text-ink sm:text-4xl">
              Fruit counter
            </h1>
          </div>
          {renderCounter}
        </header>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cards.map((card) => (
            <Card
              key={card.id}
              id={card.id}
              title={card.title}
              useCounter={useCounter}
            />
          ))}
        </section>

        <p className="font-mono text-[0.7rem] leading-relaxed text-ink-faint">
          Tap a card to increment its count. Every re-render briefly flashes the
          affected card so you can see exactly what React updated.
        </p>
      </div>
    </main>
  );
}
