import React from "react";
import { createRoot } from "react-dom/client";
import { t } from "@anicode/core";
import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error(t("Cannot find #root container", "找不到 #root 容器"));
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
