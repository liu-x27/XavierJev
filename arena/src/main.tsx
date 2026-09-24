import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled rather than fetched, so the arena looks the same offline and never
// has to reach a font CDN.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/space-grotesk";
import "./styles/base.css";
import "./styles/themes.css";
import "./styles/page.css";
import "./styles/arena.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
