import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
  useContext,
  useMemo,
  useState,
} from "react";
import { State } from "../types";

const context = createContext<{
  state: State;
  setState: Dispatch<SetStateAction<State>>;
}>({
  state: {
    apples: 0,
    bananas: 0,
    oranges: 0,
    mangoes: 0,
  },
  setState: () => {},
});

export function useProvider() {
  return useContext(context);
}

export function Provider({
  state: initialState,
  children,
}: PropsWithChildren<{ state: State }>) {
  const [state, setState] = useState(initialState);

  const value = useMemo(() => ({ state, setState }), [state]);

  return <context.Provider value={value}>{children}</context.Provider>;
}
