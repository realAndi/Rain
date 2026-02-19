import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  saveTriggers,
  checkOutput,
  shouldSkipNotification,
  resetNotificationThrottles,
  NOTIFY_THROTTLE_MS,
  NOTIFY_DEDUP_MS,
  type OutputTrigger,
} from "../triggers";

describe("checkOutput", () => {
  beforeEach(() => {
    saveTriggers([
      { id: "err", name: "Error", pattern: "\\bERROR\\b", enabled: true, action: "notify" },
      { id: "warn", name: "Warning", pattern: "\\bWARN\\b", enabled: false, action: "notify" },
      { id: "done", name: "Done", pattern: "completed successfully", enabled: true, action: "sound" },
      { id: "bad-regex", name: "Bad", pattern: "[invalid(", enabled: true, action: "badge" },
    ]);
  });

  it("matches enabled triggers", () => {
    const result = checkOutput("something ERROR happened");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("err");
  });

  it("does not match disabled triggers", () => {
    const result = checkOutput("a WARN message");
    expect(result).toBeNull();
  });

  it("returns null when no triggers match", () => {
    expect(checkOutput("all is fine")).toBeNull();
  });

  it("matches case-insensitively", () => {
    const result = checkOutput("an error occurred");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("err");
  });

  it("handles multi-word patterns", () => {
    const result = checkOutput("build completed successfully!");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("done");
  });

  it("silently skips triggers with invalid regex", () => {
    const result = checkOutput("[invalid(");
    expect(result).toBeNull();
  });

  it("returns null with empty trigger list", () => {
    saveTriggers([]);
    expect(checkOutput("anything")).toBeNull();
  });
});

describe("shouldSkipNotification", () => {
  const trigger: OutputTrigger = {
    id: "test-trigger",
    name: "Test",
    pattern: "test",
    enabled: true,
    action: "notify",
  };

  beforeEach(() => {
    resetNotificationThrottles();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first notification", () => {
    expect(shouldSkipNotification(trigger, "test output")).toBe(false);
  });

  it("throttles rapid repeated calls", () => {
    shouldSkipNotification(trigger, "test output");
    vi.advanceTimersByTime(1000);
    expect(shouldSkipNotification(trigger, "different output")).toBe(true);
  });

  it("allows after throttle window expires", () => {
    shouldSkipNotification(trigger, "test output");
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS + 1);
    expect(shouldSkipNotification(trigger, "different output")).toBe(false);
  });

  it("deduplicates identical messages within dedup window", () => {
    shouldSkipNotification(trigger, "same message");
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS + 1);
    expect(shouldSkipNotification(trigger, "same message")).toBe(true);
  });

  it("allows identical messages after dedup window expires", () => {
    shouldSkipNotification(trigger, "same message");
    vi.advanceTimersByTime(NOTIFY_DEDUP_MS + 1);
    expect(shouldSkipNotification(trigger, "same message")).toBe(false);
  });

  it("allows different messages after throttle but within dedup window", () => {
    shouldSkipNotification(trigger, "message A");
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS + 1);
    expect(shouldSkipNotification(trigger, "message B")).toBe(false);
  });

  it("normalizes whitespace for dedup comparison", () => {
    shouldSkipNotification(trigger, "  spaced   out  ");
    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS + 1);
    expect(shouldSkipNotification(trigger, "spaced out")).toBe(true);
  });

  it("tracks different triggers independently", () => {
    const other: OutputTrigger = { ...trigger, id: "other-trigger" };
    shouldSkipNotification(trigger, "output");
    expect(shouldSkipNotification(other, "output")).toBe(false);
  });
});
