import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessGate } from "./access-gate";
import { DevStatusBanner } from "./dev-status-banner";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccessGate />
    {import.meta.env.DEV ? <DevStatusBanner /> : null}
  </StrictMode>,
);
