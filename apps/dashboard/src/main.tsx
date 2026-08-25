import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
// Self-hosted font, bundled from node_modules into the build output. No
// third-party network requests at runtime.
import "@fontsource-variable/heebo/index.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("YAAPS dashboard root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
