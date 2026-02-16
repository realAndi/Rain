import { render } from "solid-js/web";
import App from "./App";
import { initTheme } from "./stores/theme";
import "./styles/base.css";

// Initialize theme before rendering
initTheme();

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
