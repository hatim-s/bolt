import {
  createContext,
  createElement,
  type PropsWithChildren,
  useContext,
  useRef,
} from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { State } from "../types";

type ZustandState = {
  state: State;
  setState: (updater: State | ((state: State) => State)) => void;
};

const context = createContext<StoreApi<ZustandState> | null>(null);

export function createZustandStore(initialState: State) {
  return createStore<ZustandState>((set) => ({
    state: initialState,
    setState: (updater) => {
      set(({ state }) => ({
        state: typeof updater === "function" ? updater(state) : updater,
      }));
    },
  }));
}

export function ZustandProvider({
  state,
  children,
}: PropsWithChildren<{ state: State }>) {
  const storeRef = useRef<StoreApi<ZustandState>>(undefined);

  if (!storeRef.current) {
    storeRef.current = createZustandStore(state);
  }

  return createElement(context.Provider, { value: storeRef.current }, children);
}

export function useZustandProvider<T>(selector: (state: ZustandState) => T) {
  const store = useContext(context);

  if (!store) {
    throw new Error("useZustandProvider must be used inside ZustandProvider");
  }

  return useStore(store, selector);
}
