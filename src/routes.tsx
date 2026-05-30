import { useCallback } from "react";
import { Provider, useProvider } from "./context/Provider";
import {
  FruitCounter,
  INITIAL_STATE,
  RenderCount,
  type UseCounter,
} from "./FruitCounter";
import { State } from "./types";
import { createBolt } from "bolt";
import { useZustandProvider, ZustandProvider } from "./zustand/store";

export { StressTestRoute } from "./StressTest";

const {
  Provider: BoltProvider,
  useSet: useBoltSet,
  useStore: useBoltStore,
} = createBolt<State>();

function ContextRenderCount() {
  const { state } = useProvider();
  return <RenderCount state={state} />;
}

function ZustandRenderCount() {
  const state = useZustandProvider((store) => store.state);
  return <RenderCount state={state} />;
}

const useContextCounter: UseCounter = (id: keyof State) => {
  const { state, setState } = useProvider();

  const increment = useCallback(() => {
    setState((prev) => ({ ...prev, [id]: prev[id] + 1 }));
  }, [id, setState]);

  return { count: state[id], increment };
};

const useZustandCounter: UseCounter = (id: keyof State) => {
  const count = useZustandProvider((store) => store.state[id]);
  const setState = useZustandProvider((store) => store.setState);

  const increment = useCallback(() => {
    setState((prev) => ({ ...prev, [id]: prev[id] + 1 }));
  }, [id, setState]);

  return { count, increment };
};

function BoltRenderCount() {
  const state = useBoltStore();
  return <RenderCount state={state} />;
}

const useBoltCounter: UseCounter = (id: keyof State) => {
  const count = useBoltStore(id);
  const setState = useBoltSet();

  const increment = useCallback(() => {
    setState(id, (previous) => previous + 1);
  }, [id, setState]);

  return { count, increment };
};

export function ContextRoute() {
  return (
    <Provider state={INITIAL_STATE}>
      <FruitCounter
        renderCounter={<ContextRenderCount />}
        useCounter={useContextCounter}
      />
    </Provider>
  );
}

export function ZustandRoute() {
  return (
    <ZustandProvider state={INITIAL_STATE}>
      <FruitCounter
        renderCounter={<ZustandRenderCount />}
        useCounter={useZustandCounter}
      />
    </ZustandProvider>
  );
}

export function BoltRoute() {
  return (
    <BoltProvider state={INITIAL_STATE}>
      <FruitCounter
        renderCounter={<BoltRenderCount />}
        useCounter={useBoltCounter}
      />
    </BoltProvider>
  );
}
