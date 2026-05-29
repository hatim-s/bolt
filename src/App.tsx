import {
  BoltRoute,
  ContextRoute,
  StressTestRoute,
  ZustandRoute,
} from "./routes";

export default function App() {
  if (
    window.location.pathname === "/stresstest" ||
    window.location.pathname === "/stress-test"
  ) {
    return <StressTestRoute />;
  }

  if (window.location.pathname === "/bolt") {
    return <BoltRoute />;
  }

  if (window.location.pathname === "/zustand") {
    return <ZustandRoute />;
  }

  return <ContextRoute />;
}
