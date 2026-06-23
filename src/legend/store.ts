import { observable, type Observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import {
  createContext,
  createElement,
  type PropsWithChildren,
  useContext,
  useRef,
} from "react";
import { State } from "../types";

const context = createContext<Observable<State> | null>(null);

export function LegendProvider({
  children,
  state,
}: PropsWithChildren<{ state: State }>) {
  const storeRef = useRef<Observable<State>>(undefined);

  if (!storeRef.current) {
    storeRef.current = observable(state);
  }

  return createElement(context.Provider, { value: storeRef.current }, children);
}

export function useLegendProvider<T>(selector: (state: Observable<State>) => T) {
  const store = useLegendApi();

  return useSelector(() => selector(store));
}

export function useLegendApi() {
  const store = useContext(context);

  if (!store) {
    throw new Error("Legend hooks must be used inside LegendProvider");
  }

  return store;
}
