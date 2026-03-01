import { describe, expect, it } from "vitest";
import {
  ContextualOutputProvider,
  FilesystemProvider,
  HistoryProvider,
  RecentOutputProvider,
  RuntimeSnoopProvider,
  SuggestionEngine,
  type FilesystemCache,
  type SnoopCacheEntry,
} from "../suggestions";
import type { CommandSnapshot, RenderedLine } from "../types";

function makeLine(index: number, text: string): RenderedLine {
  return {
    index,
    spans: [
      {
        text,
        fg: { type: "Default" },
        bg: { type: "Default" },
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        strikethrough: false,
      },
    ],
  };
}

function makeSnapshot(command: string, cwd: string, lines: string[]): CommandSnapshot {
  return {
    id: `${command}-${cwd}`,
    command,
    lines: lines.map((line, idx) => makeLine(idx, line)),
    timestamp: 0,
    endTime: 1,
    cwd,
    failed: false,
  };
}

describe("FilesystemProvider", () => {
  const cwd = "/Users/andi";
  const cache: FilesystemCache = {
    cwd,
    dir: "/Users/andi/localDocs",
    entries: [
      { name: "Andi Terminal", isDir: true },
      { name: "AndiTools", isDir: true },
      { name: "other.txt", isDir: false },
    ],
  };

  it("filters space-containing suggestions when unquoted", () => {
    const provider = new FilesystemProvider(() => cache);
    const texts = provider
      .suggest({ prefix: "cd localDocs/And", cwd, cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toEqual(["cd localDocs/AndiTools/"]);
  });

  it("allows space-containing suggestions when typing inside quotes", () => {
    const provider = new FilesystemProvider(() => cache);
    const texts = provider
      .suggest({ prefix: "cd \"localDocs/And", cwd, cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toContain("cd \"localDocs/Andi Terminal/");
    expect(texts).toContain("cd \"localDocs/AndiTools/");
  });

  it("resolves fetch directories from mixed quoted/unquoted args", () => {
    const resolved = FilesystemProvider.directoryToFetch("cp foo \"bar baz/qu", "/tmp");
    expect(resolved).toBe("/tmp/bar baz");
  });
});

describe("RecentOutputProvider", () => {
  const cwd = "/repo";
  const lsSnapshot = makeSnapshot("ls -la", cwd, [
    "drwxr-xr-x  4 andi  staff   128 Feb 28 12:00 Andi Terminal",
    "drwxr-xr-x  3 andi  staff    96 Feb 28 12:00 AndiTools",
  ]);

  it("filters unquoted names containing spaces", () => {
    const provider = new RecentOutputProvider(() => [lsSnapshot]);
    const texts = provider
      .suggest({ prefix: "cd And", cwd, cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toEqual(["cd AndiTools"]);
  });

  it("allows names containing spaces inside quoted context", () => {
    const provider = new RecentOutputProvider(() => [lsSnapshot]);
    const texts = provider
      .suggest({ prefix: "cd \"And", cwd, cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toContain("cd \"Andi Terminal");
  });
});

describe("ContextualOutputProvider", () => {
  const cwd = "/repo";
  const lsSnapshot = makeSnapshot("ls -la", cwd, [
    "drwxr-xr-x  4 andi  staff   128 Feb 28 12:00 Andi Terminal",
    "drwxr-xr-x  3 andi  staff    96 Feb 28 12:00 AndiTools",
  ]);
  const fsCache: FilesystemCache = {
    cwd,
    dir: cwd,
    entries: [
      { name: "Andi Terminal", isDir: true },
      { name: "AndiTools", isDir: true },
    ],
  };

  it("applies syntax-safe filtering for file path prefixes", () => {
    const provider = new ContextualOutputProvider(() => [lsSnapshot], () => fsCache);
    const texts = provider
      .suggest({ prefix: "cd And", cwd, cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toEqual(["cd AndiTools"]);
  });

  it("keeps file path suggestions with spaces in quoted context", () => {
    const provider = new ContextualOutputProvider(() => [lsSnapshot], () => fsCache);
    const texts = provider
      .suggest({ prefix: "cd \"And", cwd, cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toContain("cd \"Andi Terminal");
  });
});

describe("RuntimeSnoopProvider", () => {
  it("parses quoted path context for runtime snooping", () => {
    const parsed = RuntimeSnoopProvider.directoryToSnoop("python \"src/ma", "/repo");
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      runtime: "python",
      dir: "/repo/src",
      cmdPrefix: "python \"",
      argDir: "src/",
      inQuotedContext: true,
    });
  });

  it("filters space-containing runtime file suggestions when unquoted", () => {
    const cache: SnoopCacheEntry = {
      result: {
        entryPoints: ["app main.py", "app.py"],
        files: ["app helper.py", "app.ts"],
        scripts: [],
      },
      dir: "/repo/src",
      runtime: "python",
      cmdPrefix: "python ",
      argDir: "src/",
    };

    const provider = new RuntimeSnoopProvider(() => cache);
    const texts = provider
      .suggest({ prefix: "python src/ap", cwd: "/repo", cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toContain("python src/app.py");
    expect(texts).toContain("python src/app.ts");
    expect(texts).not.toContain("python src/app main.py");
    expect(texts).not.toContain("python src/app helper.py");
  });

  it("allows space-containing runtime file suggestions inside quotes", () => {
    const cache: SnoopCacheEntry = {
      result: {
        entryPoints: ["app main.py", "app.py"],
        files: [],
        scripts: [],
      },
      dir: "/repo/src",
      runtime: "python",
      cmdPrefix: "python \"",
      argDir: "src/",
    };

    const provider = new RuntimeSnoopProvider(() => cache);
    const texts = provider
      .suggest({ prefix: "python \"src/ap", cwd: "/repo", cursorAtEnd: true })
      .map((c) => c.text);

    expect(texts).toContain("python \"src/app main.py");
    expect(texts).toContain("python \"src/app.py");
  });
});

describe("SuggestionEngine syntax safety", () => {
  it("filters unquoted cd history suggestions containing spaces", () => {
    const engine = new SuggestionEngine();
    engine.register(
      new HistoryProvider(
        () => ["cd localDocs/Andi Terminal/"],
        () => [],
      ),
    );

    const texts = engine
      .suggestAll({
        prefix: "cd localDocs/Andi",
        cwd: "/Users/andi",
        cursorAtEnd: true,
      })
      .map((candidate) => candidate.text);

    expect(texts).toEqual([]);
  });

  it("keeps quoted cd history suggestions in quoted context", () => {
    const engine = new SuggestionEngine();
    engine.register(
      new HistoryProvider(
        () => ["cd \"localDocs/Andi Terminal/"],
        () => [],
      ),
    );

    const texts = engine
      .suggestAll({
        prefix: "cd \"localDocs/Andi",
        cwd: "/Users/andi",
        cursorAtEnd: true,
      })
      .map((candidate) => candidate.text);

    expect(texts).toEqual(["cd \"localDocs/Andi Terminal/"]);
  });
});
