import { createSignal } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";

const [appVersion, setAppVersion] = createSignal<string | undefined>(undefined);

// Fetch once and cache for the lifetime of the app
getVersion().then(setAppVersion).catch(() => {});

export { appVersion };
