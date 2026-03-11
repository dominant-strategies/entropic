import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Apply saved theme before first paint to avoid flash
try {
  const saved = localStorage.getItem("entropic.theme");
  if (saved === "dark") document.documentElement.classList.add("dark");
  else if (saved === "light") document.documentElement.classList.add("light");
} catch {}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
