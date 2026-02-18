import { render } from "solid-js/web";
import App from "./App";
import { initTheme } from "./stores/theme";
import { loadConfigFromDisk } from "./stores/config";
import "./styles/base.css";

const root = document.getElementById("root");
if (root) {
  initTheme();
  loadConfigFromDisk().catch((error) => {
    console.warn("[Rain] Failed to bootstrap config from disk:", error);
  });
  render(() => <App />, root);
}
