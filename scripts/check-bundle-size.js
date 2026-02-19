#!/usr/bin/env node

// Validates that the frontend bundle stays within size thresholds.
// Run after `vite build`: npm run build && node scripts/check-bundle-size.js

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST_DIR = "dist/assets";
const JS_LIMIT_KB = 350;
const CSS_LIMIT_KB = 80;

function getFilesByExtension(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => ({ name: f, size: statSync(join(dir, f)).size }));
  } catch {
    return [];
  }
}

const jsFiles = getFilesByExtension(DIST_DIR, ".js");
const cssFiles = getFilesByExtension(DIST_DIR, ".css");

if (jsFiles.length === 0) {
  console.error("No JS files found in dist/assets/. Did you run `vite build`?");
  process.exit(1);
}

let failed = false;

const totalJsKB = jsFiles.reduce((sum, f) => sum + f.size, 0) / 1024;
const totalCssKB = cssFiles.reduce((sum, f) => sum + f.size, 0) / 1024;

console.log("Bundle size report:");
for (const f of [...jsFiles, ...cssFiles]) {
  console.log(`  ${f.name}: ${(f.size / 1024).toFixed(1)} KB`);
}
console.log(`  Total JS:  ${totalJsKB.toFixed(1)} KB (limit: ${JS_LIMIT_KB} KB)`);
console.log(`  Total CSS: ${totalCssKB.toFixed(1)} KB (limit: ${CSS_LIMIT_KB} KB)`);

if (totalJsKB > JS_LIMIT_KB) {
  console.error(`\nJS bundle exceeds ${JS_LIMIT_KB} KB limit by ${(totalJsKB - JS_LIMIT_KB).toFixed(1)} KB`);
  failed = true;
}

if (totalCssKB > CSS_LIMIT_KB) {
  console.error(`\nCSS bundle exceeds ${CSS_LIMIT_KB} KB limit by ${(totalCssKB - CSS_LIMIT_KB).toFixed(1)} KB`);
  failed = true;
}

if (failed) {
  console.error("\nBundle size check FAILED. Review dependencies for bloat.");
  process.exit(1);
} else {
  console.log("\nBundle size check passed.");
}
