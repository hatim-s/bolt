import { ContextRoute, ZustandRoute } from "./routes";

export default function App() {
  return window.location.pathname === "/zustand" ? (
    <ZustandRoute />
  ) : (
    <ContextRoute />
  );
}
