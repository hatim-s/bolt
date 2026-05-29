import { BoltRoute, ContextRoute, ZustandRoute } from "./routes";

export default function App() {
  if (window.location.pathname === "/bolt") {
    return <BoltRoute />;
  }

  if (window.location.pathname === "/zustand") {
    return <ZustandRoute />;
  }

  return <ContextRoute />;
}
