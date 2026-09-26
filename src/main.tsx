import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { IdentityProvider } from "./lib/identity";
import { BrowserRouter, HashRouter } from "react-router";
import App from "./App";
import "./index.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
// Static hosts without SPA rewrites (GitHub Pages) need hash routing.
const Router = import.meta.env.VITE_ROUTER === "hash" ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <IdentityProvider client={convex}>
        <App />
      </IdentityProvider>
    </Router>
  </StrictMode>,
);
