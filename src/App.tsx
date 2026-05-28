import { useCallback, useRef } from "react";
import { Provider, useProvider } from "./context/Provider";
import { State } from "./types";

const cards = [
  { id: "apples", title: "Apples" },
  { id: "bananas", title: "Bananas" },
  { id: "oranges", title: "Oranges" },
  { id: "mangoes", title: "Mangoes" },
] as const;

function Card({
  id,
  title,
}: {
  id: keyof State;
  title: string;
}) {
  const { state, setState } = useProvider()
  const count = state[id];

  const renderCount = useRef(0);
  renderCount.current += 1;

  const onClick = useCallback(() => {
    setState(prev => ({ ...prev, [id]: count + 1 }));
  }, [id, count, setState]);

  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-xl border border-ink/10 bg-card px-5 py-6 text-left cursor-pointer transition hover:border-ink-faint hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
    >
      <span
        key={renderCount.current}
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-flash animate-flash"
      />
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
            renders {renderCount.current}
          </span>
        </div>
      </div>
    </button>
  );
}

function AppRenderCount() {
  const { state } = useProvider();
  const totalClicks = Object.values(state).reduce((acc, count) => acc + count, 0);

  const renderCount = useRef(0);
  renderCount.current += 1;

  return <div className="relative overflow-hidden rounded-lg px-3 py-2">
    <span
      key={renderCount.current}
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-flash animate-flash"
    />
    <div className="relative flex items-baseline gap-2">
      <span className="font-mono text-lg font-semibold tabular-nums text-ink">
        {renderCount.current}
      </span>
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-ink-faint">
        app renders
      </span>
    </div>
    <div className="relative flex items-baseline gap-2">
      <span className="font-mono text-lg font-semibold tabular-nums text-ink">
        {totalClicks}
      </span>
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-ink-faint">
        app clicks
      </span>
    </div>
  </div>
}

const INITIAL_STATE = cards.reduce(
  (acc, card) => {
    acc[card.id] = 0;
    return acc;
  },
  {} as Record<string, number>,
) as State;

export default function App() {
  // const [state, setState] = useState(
  //   cards.reduce(
  //     (acc, card) => {
  //       acc[card.id] = 0;
  //       return acc;
  //     },
  //     {} as Record<string, number>,
  //   ),
  // );

  const renderCount = useRef(0);
  renderCount.current += 1;

  // const onClick = useCallback((id: string) => {
  //   setState((prev) => ({ ...prev, [id]: prev[id] + 1 }));
  // }, []);

  return (
    <Provider state={INITIAL_STATE}>
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
            <AppRenderCount />
          </header>

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <Card
                key={card.id}
                id={card.id}
                title={card.title}
              />
            ))}
          </section>

          <p className="font-mono text-[0.7rem] leading-relaxed text-ink-faint">
            Tap a card to increment its count. Every re-render briefly flashes the
            affected card so you can see exactly what React updated.
          </p>
        </div>
      </main>
    </Provider>
  );
}
