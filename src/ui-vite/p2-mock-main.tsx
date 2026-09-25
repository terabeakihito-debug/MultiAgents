import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import P2MockPage from "../app/p2-mock/page";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root mount point");
}

createRoot(root).render(
  <StrictMode>
    <P2MockPage />
  </StrictMode>,
);
