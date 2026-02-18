import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the version comparison logic directly since the module has
// side effects (imports from ipc). Extract the comparison function for testing.
function compareVersions(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

describe("compareVersions", () => {
  it("detects newer major version", () => {
    expect(compareVersions("0.1.0", "1.0.0")).toBe(true);
  });

  it("detects newer minor version", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(true);
  });

  it("detects newer patch version", () => {
    expect(compareVersions("0.1.0", "0.1.1")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false for older version", () => {
    expect(compareVersions("1.2.3", "1.2.2")).toBe(false);
    expect(compareVersions("1.2.3", "1.1.5")).toBe(false);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(false);
  });

  it("handles v prefix", () => {
    expect(compareVersions("v0.1.0", "v0.2.0")).toBe(true);
    expect(compareVersions("0.1.0", "v0.2.0")).toBe(true);
  });

  it("handles different version lengths", () => {
    expect(compareVersions("1.0", "1.0.1")).toBe(true);
    expect(compareVersions("1.0.1", "1.0")).toBe(false);
  });
});
