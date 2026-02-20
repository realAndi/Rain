import type { CommandSnapshot } from "./types";
import type { DirEntry, ProjectCommands, SnoopResult } from "./ipc";

// --- Core interfaces ---

export interface SuggestionContext {
  prefix: string;
  cwd: string;
  cursorAtEnd: boolean;
}

export interface SuggestionCandidate {
  text: string;
  score: number;
  source: string;
}

export interface SuggestionProvider {
  name: string;
  suggest(ctx: SuggestionContext): SuggestionCandidate[];
}

// --- Scoring weights (easy to tune) ---

const W_RECENCY = 0.5;
const W_FREQUENCY = 0.2;
const W_CWD = 0.2;
const W_SUCCESS = 0.1;

// --- Per-directory frequency index ---

const DIR_FREQ_KEY = "rain-dir-freq";
const MAX_DIR_ENTRIES = 200;

type DirFreqIndex = Record<string, Record<string, number>>;

let dirFreqCache: DirFreqIndex | null = null;
let dirFreqCacheTime = 0;
const DIR_FREQ_CACHE_TTL = 2000;

function loadDirFreq(): DirFreqIndex {
  const now = Date.now();
  if (dirFreqCache && now - dirFreqCacheTime < DIR_FREQ_CACHE_TTL) {
    return dirFreqCache;
  }
  try {
    const raw = localStorage.getItem(DIR_FREQ_KEY);
    if (!raw) { dirFreqCache = {}; dirFreqCacheTime = now; return dirFreqCache; }
    dirFreqCache = JSON.parse(raw) as DirFreqIndex;
    dirFreqCacheTime = now;
    return dirFreqCache;
  } catch {
    dirFreqCache = {};
    dirFreqCacheTime = now;
    return dirFreqCache;
  }
}

function saveDirFreq(index: DirFreqIndex) {
  try {
    const dirs = Object.keys(index);
    if (dirs.length > MAX_DIR_ENTRIES) {
      const trimmed: DirFreqIndex = {};
      for (const dir of dirs.slice(-MAX_DIR_ENTRIES)) {
        trimmed[dir] = index[dir];
      }
      localStorage.setItem(DIR_FREQ_KEY, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(DIR_FREQ_KEY, JSON.stringify(index));
    }
  } catch {
    // ignore
  }
}

export function recordCommandInDir(command: string, cwd: string) {
  if (!command.trim()) return;
  const index = loadDirFreq();
  if (!index[cwd]) index[cwd] = {};
  index[cwd][command] = (index[cwd][command] ?? 0) + 1;
  saveDirFreq(index);
  dirFreqCache = null;
}

// --- Fuzzy matching utility ---

function fuzzyMatch(text: string, query: string): { match: boolean; score: number } {
  if (!query) return { match: true, score: 1 };
  const lower = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lower.startsWith(lowerQuery)) {
    return { match: true, score: 1.0 };
  }

  let qi = 0;
  let consecutiveBonus = 0;
  let totalBonus = 0;
  for (let i = 0; i < lower.length && qi < lowerQuery.length; i++) {
    if (lower[i] === lowerQuery[qi]) {
      qi++;
      consecutiveBonus++;
      totalBonus += consecutiveBonus;
    } else {
      consecutiveBonus = 0;
    }
  }

  if (qi < lowerQuery.length) return { match: false, score: 0 };

  const coverage = lowerQuery.length / lower.length;
  const bonusNorm = totalBonus / (lowerQuery.length * lowerQuery.length || 1);
  return { match: true, score: 0.3 + 0.3 * coverage + 0.1 * bonusNorm };
}

// --- HistoryProvider (improved with fuzzy, decay, subcommand, per-dir) ---

export class HistoryProvider implements SuggestionProvider {
  name = "history";

  private snapshotMetaCache: Map<string, { cwds: Set<string>; anyFailed: boolean }> | null = null;
  private lastSnapshotCount = -1;

  constructor(
    private getHistory: () => string[],
    private getSnapshots: () => CommandSnapshot[],
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    const history = this.getHistory();
    if (history.length === 0) return [];

    const snapshotMeta = this.getSnapshotMeta();
    const dirFreq = loadDirFreq();
    const dirCmds = dirFreq[ctx.cwd];
    const maxDirFreq = dirCmds ? Math.max(...Object.values(dirCmds)) : 0;

    const freq = new Map<string, number>();
    const matchMap = new Map<string, { lastIndex: number; matchScore: number }>();
    const prefixParts = ctx.prefix.split(/\s+/);

    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (entry === ctx.prefix) continue;

      let matchScore: number;
      if (entry.startsWith(ctx.prefix)) {
        matchScore = 1.0;
      } else {
        const fuzzy = fuzzyMatch(entry, ctx.prefix);
        if (!fuzzy.match) continue;
        matchScore = fuzzy.score * 0.6;
      }

      freq.set(entry, (freq.get(entry) ?? 0) + 1);

      const existing = matchMap.get(entry);
      if (existing) {
        existing.lastIndex = i;
        if (matchScore > existing.matchScore) existing.matchScore = matchScore;
      } else {
        matchMap.set(entry, { lastIndex: i, matchScore });
      }
    }

    if (matchMap.size === 0) return [];

    const maxFreq = Math.max(...Array.from(freq.values()));
    const maxIndex = history.length - 1;

    const results: SuggestionCandidate[] = [];
    for (const [text, { lastIndex, matchScore }] of matchMap) {
      const normalizedAge = maxIndex > 0 ? (maxIndex - lastIndex) / maxIndex : 0;
      const recency = Math.exp(-3 * normalizedAge);

      const rawFreq = freq.get(text) ?? 0;
      const frequency = maxFreq > 0 ? rawFreq / maxFreq : 0;

      const meta = snapshotMeta.get(text);
      const cwdMatch = meta?.cwds.has(ctx.cwd) ? 1 : 0;
      const success = meta ? (meta.anyFailed ? 0 : 1) : 1;

      let dirBoost = 0;
      if (dirCmds && dirCmds[text] && maxDirFreq > 0) {
        dirBoost = dirCmds[text] / maxDirFreq;
      }

      let subcommandBoost = 0;
      if (prefixParts.length >= 2) {
        const entryParts = text.split(/\s+/);
        if (entryParts.length >= 2 && entryParts[0] === prefixParts[0] && entryParts[1] === prefixParts[1]) {
          subcommandBoost = 0.15;
        }
      }

      const score =
        (W_RECENCY * recency +
          W_FREQUENCY * frequency +
          W_CWD * (cwdMatch * 0.5 + dirBoost * 0.5) +
          W_SUCCESS * success +
          subcommandBoost) *
        matchScore;

      results.push({ text, score, source: this.name });
    }

    return results;
  }

  private getSnapshotMeta(): Map<string, { cwds: Set<string>; anyFailed: boolean }> {
    const snapshots = this.getSnapshots();
    if (this.snapshotMetaCache && snapshots.length === this.lastSnapshotCount) {
      return this.snapshotMetaCache;
    }
    this.lastSnapshotCount = snapshots.length;
    const meta = new Map<string, { cwds: Set<string>; anyFailed: boolean }>();
    for (const snap of snapshots) {
      if (!snap.command) continue;
      let entry = meta.get(snap.command);
      if (!entry) {
        entry = { cwds: new Set(), anyFailed: false };
        meta.set(snap.command, entry);
      }
      if (snap.cwd) entry.cwds.add(snap.cwd);
      if (snap.failed) entry.anyFailed = true;
    }
    this.snapshotMetaCache = meta;
    return meta;
  }
}

// --- RecentOutputProvider (preserved for backward compatibility) ---

const LS_COMMAND_RE = /^ls(\s|$)/;
const PERMISSIONS_RE = /^[dlcbps-][rwxsStT-]{8,9}/;

export class RecentOutputProvider implements SuggestionProvider {
  name = "recent-output";

  constructor(
    private getSnapshots: () => CommandSnapshot[],
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    if (!ctx.prefix.startsWith("cd ")) return [];

    const arg = ctx.prefix.slice(3);
    const names = this.extractNamesFromRecentLs(ctx.cwd);
    if (names.length === 0) return [];

    const candidates: SuggestionCandidate[] = [];
    for (const name of names) {
      if (!name.startsWith(arg) || name === arg) continue;
      candidates.push({
        text: `cd ${name}`,
        score: 0.8,
        source: this.name,
      });
    }
    return candidates;
  }

  private extractNamesFromRecentLs(cwd: string): string[] {
    const snapshots = this.getSnapshots();
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const snap = snapshots[i];
      if (!LS_COMMAND_RE.test(snap.command) || snap.failed) continue;
      if (snap.cwd !== cwd) continue;
      return this.parseOutputNames(snap);
    }
    return [];
  }

  private parseOutputNames(snap: CommandSnapshot): string[] {
    const names: string[] = [];
    for (const line of snap.lines) {
      const text = line.spans.map((s) => s.text).join("");
      const trimmed = text.trim();
      if (!trimmed) continue;

      const tokens = trimmed.split(/\s+/);
      if (tokens.length >= 8 && PERMISSIONS_RE.test(tokens[0])) {
        const name = tokens.slice(8).join(" ");
        if (name && name !== "." && name !== "..") names.push(name);
      } else {
        for (const tok of tokens) {
          if (tok && tok !== "." && tok !== "..") names.push(tok);
        }
      }
    }
    return names;
  }
}

// --- ContextualOutputProvider (Priority 2) ---

interface OutputPattern {
  commandMatch: RegExp;
  triggerPrefixes: string[];
  extractNames: (snap: CommandSnapshot) => string[];
}

function extractLineTexts(snap: CommandSnapshot): string[] {
  return snap.lines.map((l) => l.spans.map((s) => s.text).join(""));
}

const OUTPUT_PATTERNS: OutputPattern[] = [
  {
    commandMatch: /^git\s+branch(\s|$)/,
    triggerPrefixes: ["git checkout ", "git switch ", "git merge ", "git rebase "],
    extractNames(snap) {
      const names: string[] = [];
      for (const text of extractLineTexts(snap)) {
        let trimmed = text.trim();
        if (!trimmed) continue;
        // Strip leading * (current branch indicator)
        if (trimmed.startsWith("* ")) trimmed = trimmed.slice(2).trim();
        // Strip remotes/origin/ prefix
        trimmed = trimmed.replace(/^remotes\/origin\//, "");
        // Skip HEAD pointer lines
        if (trimmed.includes("->")) continue;
        if (trimmed) names.push(trimmed);
      }
      return [...new Set(names)];
    },
  },
  {
    commandMatch: /^docker\s+ps(\s|$)/,
    triggerPrefixes: ["docker stop ", "docker exec ", "docker logs ", "docker restart ", "docker rm "],
    extractNames(snap) {
      const lines = extractLineTexts(snap);
      if (lines.length < 2) return [];
      const names: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const cols = trimmed.split(/\s{2,}/);
        const containerId = cols.length >= 1 ? cols[0].trim().split(/\s+/)[0] : "";
        if (containerId) names.push(containerId);
        if (cols.length >= 2) {
          const last = cols[cols.length - 1].trim();
          if (last && last !== containerId) names.push(last);
        }
      }
      return names;
    },
  },
  {
    commandMatch: /^docker\s+images(\s|$)/,
    triggerPrefixes: ["docker run ", "docker rmi "],
    extractNames(snap) {
      const lines = extractLineTexts(snap);
      if (lines.length < 2) return [];
      const names: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const cols = trimmed.split(/\s{2,}/);
        if (cols.length >= 2) {
          const repo = cols[0].trim();
          const tag = cols[1].trim();
          if (repo === "<none>") continue;
          names.push(tag && tag !== "<none>" ? `${repo}:${tag}` : repo);
        }
      }
      return names;
    },
  },
  {
    commandMatch: /^kubectl\s+get\s+pods?(\s|$)/,
    triggerPrefixes: ["kubectl describe pod ", "kubectl logs ", "kubectl delete pod ", "kubectl exec "],
    extractNames(snap) {
      const lines = extractLineTexts(snap);
      if (lines.length < 2) return [];
      const names: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const podName = trimmed.split(/\s+/)[0];
        if (podName) names.push(podName);
      }
      return names;
    },
  },
  {
    commandMatch: /^npm\s+run\s*$/,
    triggerPrefixes: ["npm run "],
    extractNames(snap) {
      const lines = extractLineTexts(snap);
      const names: string[] = [];
      // npm run output shows scripts as "  scriptname" or "Lifecycle scripts:" headers
      for (const text of lines) {
        const trimmed = text.trim();
        if (!trimmed) continue;
        if (trimmed.endsWith(":") || trimmed.startsWith("Lifecycle")) continue;
        // Script names are the first word of indented lines
        const match = text.match(/^\s{2}(\S+)/);
        if (match) names.push(match[1]);
      }
      return names;
    },
  },
  {
    // Only match bare ls with optional flags (e.g. ls, ls -la, ls -l -a).
    // Reject ls with a path argument (e.g. ls /tmp, ls src/) since the output
    // reflects a different directory than the CWD.
    commandMatch: /^ls(\s+-\S+)*\s*$/,
    triggerPrefixes: ["cd ", "cat ", "vim ", "nvim ", "code ", "open ", "rm ", "cp ", "mv ", "less ", "nano ", "head ", "tail ", "chmod ", "chown "],
    extractNames(snap) {
      const names: string[] = [];
      for (const line of snap.lines) {
        const text = line.spans.map((s) => s.text).join("");
        const trimmed = text.trim();
        if (!trimmed) continue;
        const tokens = trimmed.split(/\s+/);
        if (tokens.length >= 8 && PERMISSIONS_RE.test(tokens[0])) {
          const name = tokens.slice(8).join(" ");
          if (name && name !== "." && name !== "..") names.push(name);
        } else {
          for (const tok of tokens) {
            if (tok && tok !== "." && tok !== "..") names.push(tok);
          }
        }
      }
      return names;
    },
  },
];

// Prefixes whose argument is a local file/directory path
const FILE_PATH_PREFIXES = new Set([
  "cd ", "cat ", "vim ", "nvim ", "code ", "open ", "rm ", "cp ", "mv ",
  "less ", "nano ", "head ", "tail ", "chmod ", "chown ",
]);

export class ContextualOutputProvider implements SuggestionProvider {
  name = "contextual-output";

  constructor(
    private getSnapshots: () => CommandSnapshot[],
    private getFsCache?: () => FilesystemCache | null,
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    const snapshots = this.getSnapshots();
    if (snapshots.length === 0) return [];

    // Build a set of known filesystem entries for validation
    const fsNames = this.buildFsNameSet(ctx.cwd);

    const candidates: SuggestionCandidate[] = [];

    for (const pattern of OUTPUT_PATTERNS) {
      const triggerPrefix = pattern.triggerPrefixes.find((tp) => ctx.prefix.startsWith(tp));
      if (!triggerPrefix) continue;

      const arg = ctx.prefix.slice(triggerPrefix.length);
      const needsFsValidation = fsNames && FILE_PATH_PREFIXES.has(triggerPrefix);

      for (let i = snapshots.length - 1; i >= 0; i--) {
        const snap = snapshots[i];
        if (snap.failed) continue;
        if (snap.cwd !== ctx.cwd) continue;
        if (!pattern.commandMatch.test(snap.command)) continue;

        const names = pattern.extractNames(snap);
        for (const name of names) {
          if (!name.startsWith(arg) || name === arg) continue;
          // If we have filesystem data for this CWD, verify the name actually exists
          if (needsFsValidation && !fsNames!.has(name)) continue;
          candidates.push({
            text: `${triggerPrefix}${name}`,
            score: 0.85,
            source: this.name,
          });
        }
        break;
      }
    }

    return candidates;
  }

  private buildFsNameSet(cwd: string): Set<string> | null {
    if (!this.getFsCache) return null;
    const cache = this.getFsCache();
    if (!cache || cache.dir !== cwd) return null;
    return new Set(cache.entries.map((e) => e.name));
  }
}

// --- FilesystemProvider (Priority 1) ---

const FILE_ARG_COMMANDS = [
  "cd", "cat", "vim", "nvim", "code", "open", "rm", "cp", "mv",
  "mkdir", "less", "nano", "head", "tail", "chmod", "chown",
  "source", "bat", "touch", "stat", "file", "wc",
  "python", "python3", "node", "deno run", "bun", "bun run",
  "ruby", "php", "go run", "java",
];

const DIR_ONLY_COMMANDS = new Set(["cd"]);

export interface FilesystemCache {
  entries: DirEntry[];
  dir: string;
  cwd: string;
}

export class FilesystemProvider implements SuggestionProvider {
  name = "filesystem";

  constructor(
    private getCache: () => FilesystemCache | null,
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    const cache = this.getCache();
    if (!cache) return [];

    const cmdArg = this.parseCommandArg(ctx.prefix);
    if (!cmdArg) return [];

    const { command, arg } = cmdArg;
    const dirOnly = DIR_ONLY_COMMANDS.has(command);

    // Derive the filename filter from the arg (after the last /)
    const lastSlash = arg.lastIndexOf("/");
    const filter = lastSlash >= 0 ? arg.slice(lastSlash + 1) : arg;
    const argDir = lastSlash >= 0 ? arg.slice(0, lastSlash + 1) : "";

    // Verify cache matches the directory we're looking at
    const expectedDir = this.resolveDir(ctx.cwd, argDir);
    if (cache.dir !== expectedDir) return [];

    const candidates: SuggestionCandidate[] = [];
    for (const entry of cache.entries) {
      if (dirOnly && !entry.isDir) continue;
      if (!entry.name.startsWith(filter) || entry.name === filter) continue;

      const completedArg = argDir + entry.name + (entry.isDir ? "/" : "");
      candidates.push({
        text: `${command} ${completedArg}`,
        score: entry.isDir ? 0.78 : 0.72,
        source: this.name,
      });
    }

    return candidates;
  }

  parseCommandArg(prefix: string): { command: string; arg: string } | null {
    for (const cmd of FILE_ARG_COMMANDS) {
      if (prefix.startsWith(cmd + " ")) {
        const rest = prefix.slice(cmd.length + 1);
        // Only complete the last argument (simplification)
        const parts = rest.split(/\s+/);
        return { command: cmd, arg: parts[parts.length - 1] };
      }
    }
    return null;
  }

  resolveDir(cwd: string, partial: string): string {
    if (!partial) return cwd;
    if (partial.startsWith("/")) return partial;
    const resolved = cwd.endsWith("/") ? cwd + partial : cwd + "/" + partial;
    return resolved.replace(/\/+$/, "") || "/";
  }

  /** Determine what directory to fetch for a given input prefix + cwd. Returns null if not applicable. */
  static directoryToFetch(prefix: string, cwd: string): string | null {
    for (const cmd of FILE_ARG_COMMANDS) {
      if (prefix.startsWith(cmd + " ")) {
        const rest = prefix.slice(cmd.length + 1);
        const parts = rest.split(/\s+/);
        const arg = parts[parts.length - 1];
        const lastSlash = arg.lastIndexOf("/");
        const dirPart = lastSlash >= 0 ? arg.slice(0, lastSlash + 1) : "";

        if (!dirPart) return cwd;
        if (dirPart.startsWith("/")) return dirPart.replace(/\/+$/, "") || "/";
        const full = cwd.endsWith("/") ? cwd + dirPart : cwd + "/" + dirPart;
        return full.replace(/\/+$/, "") || "/";
      }
    }
    return null;
  }
}

// --- ProjectAwareProvider ---

export class ProjectAwareProvider implements SuggestionProvider {
  name = "project";

  constructor(
    private getProjectCommands: () => ProjectCommands | null,
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    const project = this.getProjectCommands();
    if (!project || project.scripts.length === 0) return [];

    const candidates: SuggestionCandidate[] = [];
    const seen = new Set<string>();

    for (const script of project.scripts) {
      const fullCmd = script.runner
        ? `${script.runner} ${script.name}`
        : script.name;

      if (fullCmd === ctx.prefix) continue;
      if (!fullCmd.startsWith(ctx.prefix)) continue;
      if (seen.has(fullCmd)) continue;
      seen.add(fullCmd);

      candidates.push({
        text: fullCmd,
        score: 0.88,
        source: this.name,
      });
    }

    return candidates;
  }
}

// --- PathCommandProvider ---

export class PathCommandProvider implements SuggestionProvider {
  name = "path-commands";

  constructor(
    private getPathCommands: () => string[],
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    // Only activate for single-token input (user is typing a base command)
    if (ctx.prefix.includes(" ")) return [];

    const commands = this.getPathCommands();
    if (commands.length === 0) return [];

    const candidates: SuggestionCandidate[] = [];
    const lower = ctx.prefix.toLowerCase();

    for (const cmd of commands) {
      if (cmd === ctx.prefix) continue;
      if (!cmd.toLowerCase().startsWith(lower)) continue;
      candidates.push({
        text: cmd,
        score: 0.3,
        source: this.name,
      });
    }

    return candidates;
  }
}

// --- RuntimeSnoopProvider ---

const RUNTIME_COMMANDS: Record<string, string> = {
  "python":  "python",
  "python3": "python",
  "node":    "node",
  "deno run":"deno",
  "bun":     "bun",
  "bun run": "bun",
  "ruby":    "ruby",
  "php":     "php",
  "go run":  "go run",
  "java":    "java",
};

// Sorted longest-first so "deno run" matches before "deno" would (if added later)
const RUNTIME_PREFIXES = Object.keys(RUNTIME_COMMANDS).sort((a, b) => b.length - a.length);

export interface SnoopCacheEntry {
  result: SnoopResult;
  dir: string;
  runtime: string;
  /** The command prefix portion before the path argument (e.g. "python " or "go run ") */
  cmdPrefix: string;
  /** The directory portion of the arg as typed by the user (e.g. "src/" or "/abs/path/") */
  argDir: string;
}

export class RuntimeSnoopProvider implements SuggestionProvider {
  name = "runtime-snoop";

  constructor(
    private getCache: () => SnoopCacheEntry | null,
  ) {}

  suggest(ctx: SuggestionContext): SuggestionCandidate[] {
    const cache = this.getCache();
    if (!cache) return [];

    const parsed = RuntimeSnoopProvider.directoryToSnoop(ctx.prefix, ctx.cwd);
    if (!parsed || parsed.dir !== cache.dir || parsed.runtime !== cache.runtime) return [];

    const { result, cmdPrefix, argDir } = cache;
    const argAfterDir = ctx.prefix.slice(cmdPrefix.length + argDir.length);
    const candidates: SuggestionCandidate[] = [];
    const seen = new Set<string>();

    // Entry points: highest priority
    for (const ep of result.entryPoints) {
      if (!ep.startsWith(argAfterDir) || ep === argAfterDir) continue;
      const full = `${cmdPrefix}${argDir}${ep}`;
      if (seen.has(full)) continue;
      seen.add(full);
      candidates.push({ text: full, score: 0.90, source: this.name });
    }

    // Project scripts from config (package.json scripts, pyproject entry points, etc.)
    for (const script of result.scripts) {
      const fullCmd = script.runner
        ? `${script.runner} ${script.name}`
        : script.name;
      if (seen.has(fullCmd) || fullCmd === ctx.prefix) continue;
      if (!fullCmd.startsWith(ctx.prefix)) continue;
      seen.add(fullCmd);
      candidates.push({ text: fullCmd, score: 0.88, source: this.name });
    }

    // Filtered files: lower priority but still relevant
    for (const file of result.files) {
      if (!file.startsWith(argAfterDir) || file === argAfterDir) continue;
      const full = `${cmdPrefix}${argDir}${file}`;
      if (seen.has(full)) continue;
      seen.add(full);
      candidates.push({ text: full, score: 0.75, source: this.name });
    }

    return candidates;
  }

  static directoryToSnoop(
    prefix: string,
    cwd: string,
  ): { runtime: string; dir: string; cmdPrefix: string; argDir: string } | null {
    for (const cmd of RUNTIME_PREFIXES) {
      const withSpace = cmd + " ";
      if (!prefix.startsWith(withSpace)) continue;

      const rest = prefix.slice(withSpace.length);
      // Need at least a directory separator to know we're navigating into a path
      if (!rest.includes("/")) return null;

      const parts = rest.split(/\s+/);
      const arg = parts[parts.length - 1];
      const lastSlash = arg.lastIndexOf("/");
      if (lastSlash < 0) return null;

      const dirPart = arg.slice(0, lastSlash + 1);
      let resolvedDir: string;
      if (dirPart.startsWith("/")) {
        resolvedDir = dirPart.replace(/\/+$/, "") || "/";
      } else {
        const full = cwd.endsWith("/") ? cwd + dirPart : cwd + "/" + dirPart;
        resolvedDir = full.replace(/\/+$/, "") || "/";
      }

      return {
        runtime: RUNTIME_COMMANDS[cmd],
        dir: resolvedDir,
        cmdPrefix: withSpace,
        argDir: dirPart,
      };
    }
    return null;
  }
}

// --- SuggestionEngine ---

export class SuggestionEngine {
  private providers: SuggestionProvider[] = [];

  register(provider: SuggestionProvider): void {
    this.providers.push(provider);
  }

  unregister(name: string): void {
    this.providers = this.providers.filter((p) => p.name !== name);
  }

  /** Return all candidates sorted by score descending. */
  suggestAll(ctx: SuggestionContext): SuggestionCandidate[] {
    if (!ctx.prefix || !ctx.prefix.trim()) return [];
    if (!ctx.cursorAtEnd) return [];

    const all: SuggestionCandidate[] = [];
    for (const provider of this.providers) {
      const candidates = provider.suggest(ctx);
      all.push(...candidates);
    }

    if (all.length === 0) return [];

    // Deduplicate by text, keeping highest score
    const deduped = new Map<string, SuggestionCandidate>();
    for (const c of all) {
      const existing = deduped.get(c.text);
      if (!existing || c.score > existing.score) {
        deduped.set(c.text, c);
      }
    }

    return Array.from(deduped.values()).sort((a, b) => b.score - a.score).slice(0, 10);
  }

  suggest(ctx: SuggestionContext): string | null {
    const all = this.suggestAll(ctx);
    return all.length > 0 ? all[0].text : null;
  }
}
