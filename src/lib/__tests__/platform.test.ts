import { describe, it, expect, beforeEach, vi } from "vitest";
import { shortenHomePath } from "../platform";

let platformModule: typeof import("../platform");

function loadPlatformWithUA(ua: string) {
  vi.stubGlobal("navigator", { userAgent: ua });
  // Reset the cached platform between tests
  vi.resetModules();
  return import("../platform");
}

describe("detectPlatform", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("detects macOS from user agent", async () => {
    platformModule = await loadPlatformWithUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    expect(platformModule.detectPlatform()).toBe("macos");
  });

  it("detects Windows from user agent", async () => {
    platformModule = await loadPlatformWithUA(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    expect(platformModule.detectPlatform()).toBe("windows");
  });

  it("detects Linux from user agent", async () => {
    platformModule = await loadPlatformWithUA(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    );
    expect(platformModule.detectPlatform()).toBe("linux");
  });

  it("returns unknown for unrecognized user agent", async () => {
    platformModule = await loadPlatformWithUA("SomeRandomBrowser/1.0");
    expect(platformModule.detectPlatform()).toBe("unknown");
  });

  it("caches the result on subsequent calls", async () => {
    platformModule = await loadPlatformWithUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(platformModule.detectPlatform()).toBe("macos");
    // Mutate the navigator to prove caching
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    expect(platformModule.detectPlatform()).toBe("macos");
  });
});

describe("platform helper booleans", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("isMacOS returns true only on macOS", async () => {
    platformModule = await loadPlatformWithUA("Macintosh");
    expect(platformModule.isMacOS()).toBe(true);
    expect(platformModule.isWindows()).toBe(false);
    expect(platformModule.isLinux()).toBe(false);
  });

  it("isWindows returns true only on Windows", async () => {
    platformModule = await loadPlatformWithUA("Windows NT 10.0");
    expect(platformModule.isMacOS()).toBe(false);
    expect(platformModule.isWindows()).toBe(true);
    expect(platformModule.isLinux()).toBe(false);
  });

  it("isLinux returns true only on Linux", async () => {
    platformModule = await loadPlatformWithUA("X11; Linux x86_64");
    expect(platformModule.isMacOS()).toBe(false);
    expect(platformModule.isWindows()).toBe(false);
    expect(platformModule.isLinux()).toBe(true);
  });
});

describe("modifierKey / modifierSymbol", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns Cmd and ⌘ on macOS", async () => {
    platformModule = await loadPlatformWithUA("Macintosh");
    expect(platformModule.modifierKey()).toBe("Cmd");
    expect(platformModule.modifierSymbol()).toBe("\u2318");
  });

  it("returns Ctrl and Ctrl+ on Windows", async () => {
    platformModule = await loadPlatformWithUA("Windows NT 10.0");
    expect(platformModule.modifierKey()).toBe("Ctrl");
    expect(platformModule.modifierSymbol()).toBe("Ctrl+");
  });

  it("returns Ctrl and Ctrl+ on Linux", async () => {
    platformModule = await loadPlatformWithUA("X11; Linux x86_64");
    expect(platformModule.modifierKey()).toBe("Ctrl");
    expect(platformModule.modifierSymbol()).toBe("Ctrl+");
  });
});

describe("shortenHomePath", () => {
  it("shortens macOS home paths", () => {
    expect(shortenHomePath("/Users/andi/projects")).toBe("~/projects");
    expect(shortenHomePath("/Users/john")).toBe("~");
    expect(shortenHomePath("/Users/john/")).toBe("~/");
  });

  it("shortens Linux home paths", () => {
    expect(shortenHomePath("/home/andi/projects")).toBe("~/projects");
    expect(shortenHomePath("/home/john")).toBe("~");
    expect(shortenHomePath("/home/john/.config/nvim")).toBe("~/.config/nvim");
  });

  it("shortens Windows home paths", () => {
    expect(shortenHomePath("C:\\Users\\andi\\Documents")).toBe("~\\Documents");
    expect(shortenHomePath("D:\\Users\\john")).toBe("~");
    expect(shortenHomePath("C:\\Users\\john\\Desktop\\file.txt")).toBe(
      "~\\Desktop\\file.txt",
    );
  });

  it("leaves non-home paths unchanged", () => {
    expect(shortenHomePath("/var/log/syslog")).toBe("/var/log/syslog");
    expect(shortenHomePath("/tmp")).toBe("/tmp");
    expect(shortenHomePath("C:\\Program Files\\App")).toBe(
      "C:\\Program Files\\App",
    );
  });

  it("leaves root paths unchanged", () => {
    expect(shortenHomePath("/")).toBe("/");
    expect(shortenHomePath("C:\\")).toBe("C:\\");
  });

  it("handles paths that contain Users as a subdirectory", () => {
    expect(shortenHomePath("/var/Users/fake")).toBe("/var/Users/fake");
  });
});
