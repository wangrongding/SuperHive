import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DevStatusBanner } from "./dev-status-banner";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {import.meta.env.DEV ? <DevStatusBanner /> : null}
  </StrictMode>,
);
