import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { isNative } from "./config";

if (!isNative() && "serviceWorker" in navigator) {
  const update = registerSW({ onNeedRefresh() { if (confirm("A new version of the app is available. Reload now?")) void update(true); } });
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
