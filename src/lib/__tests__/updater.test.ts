import { describe, it, expect, vi } from "vitest";

vi.mock("../ipc", () => ({
  getAppVersion: vi.fn().mockResolvedValue("0.1.0"),
}));

import { compareVersions } from "../updater";

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
