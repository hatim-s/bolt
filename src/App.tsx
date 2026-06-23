import {
  BoltRoute,
  ContextRoute,
  LegendRoute,
  StressTest2Route,
  StressTest3Route,
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

  if (
    window.location.pathname === "/stresstest-2" ||
    window.location.pathname === "/stress-test-2"
  ) {
    return <StressTest2Route />;
  }

  if (
    window.location.pathname === "/stresstest-3" ||
    window.location.pathname === "/stress-test-3"
  ) {
    return <StressTest3Route />;
  }

  if (window.location.pathname === "/bolt") {
    return <BoltRoute />;
  }

  if (window.location.pathname === "/zustand") {
    return <ZustandRoute />;
  }

  if (window.location.pathname === "/legend") {
    return <LegendRoute />;
  }

  return <ContextRoute />;
}
