// Terminal output triggers: regex patterns that fire callbacks when matched.

export interface OutputTrigger {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
  action: "notify" | "sound" | "badge";
}

const TRIGGERS_STORAGE_KEY = "rain-triggers";

let _triggers: OutputTrigger[] = [];
let _compiledPatterns: Map<string, RegExp> = new Map();
const NOTIFY_THROTTLE_MS = 3_000;
const NOTIFY_DEDUP_MS = 20_000;
const _lastNotifyByTrigger = new Map<
  string,
  { timestamp: number; sample: string }
>();

export function loadTriggers(): OutputTrigger[] {
  try {
    const raw = localStorage.getItem(TRIGGERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OutputTrigger[];
      if (Array.isArray(parsed)) {
        _triggers = parsed;
        recompilePatterns();
        return _triggers;
      }
    }
  } catch {
    // ignore
  }
  _triggers = defaultTriggers();
  recompilePatterns();
  return _triggers;
}

function defaultTriggers(): OutputTrigger[] {
  return [
    {
      id: "error",
      name: "Error detected",
      pattern: "\\b(error|ERROR|Error)\\b",
      enabled: false,
      action: "notify",
    },
    {
      id: "build-done",
      name: "Build completed",
      pattern: "\\b(compiled|built|bundled) successfully\\b",
      enabled: false,
      action: "notify",
    },
    {
      id: "test-fail",
      name: "Test failure",
      pattern: "\\b(FAIL|FAILED|failing)\\b",
      enabled: false,
      action: "notify",
    },
  ];
}

function recompilePatterns() {
  _compiledPatterns.clear();
  for (const trigger of _triggers) {
    if (!trigger.enabled) continue;
    try {
      _compiledPatterns.set(trigger.id, new RegExp(trigger.pattern, "i"));
    } catch {
      // Invalid regex, skip
    }
  }
}

export function saveTriggers(triggers: OutputTrigger[]): void {
  _triggers = triggers;
  recompilePatterns();
  try {
    localStorage.setItem(TRIGGERS_STORAGE_KEY, JSON.stringify(triggers));
  } catch {
    // ignore
  }
}

export function getTriggers(): OutputTrigger[] {
  if (_triggers.length === 0) return loadTriggers();
  return _triggers;
}

export function addTrigger(trigger: Omit<OutputTrigger, "id">): OutputTrigger {
  const id = `trigger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newTrigger: OutputTrigger = { id, ...trigger };
  _triggers = [..._triggers, newTrigger];
  saveTriggers(_triggers);
  return newTrigger;
}

export function updateTrigger(id: string, updates: Partial<OutputTrigger>): void {
  _triggers = _triggers.map((t) => (t.id === id ? { ...t, ...updates } : t));
  saveTriggers(_triggers);
}

export function deleteTrigger(id: string): void {
  _triggers = _triggers.filter((t) => t.id !== id);
  saveTriggers(_triggers);
}

export function checkOutput(text: string): OutputTrigger | null {
  for (const [id, regex] of _compiledPatterns) {
    if (regex.test(text)) {
      return _triggers.find((t) => t.id === id) ?? null;
    }
  }
  return null;
}

export function executeTriggerAction(trigger: OutputTrigger, matchedText: string): void {
  switch (trigger.action) {
    case "notify":
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      if (shouldSkipNotification(trigger, matchedText)) return;
      try {
        new Notification(trigger.name, {
          body: matchedText.substring(0, 100),
          silent: true,
        });
      } catch {
        // Notifications not available
      }
      break;
    case "sound":
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
        osc.onended = () => ctx.close();
      } catch {
        // AudioContext not available
      }
      break;
    case "badge":
      try {
        if ("setAppBadge" in navigator) {
          (navigator as any).setAppBadge().catch(() => {});
        }
      } catch {
        // Badge API not available
      }
      break;
  }
}

function shouldSkipNotification(trigger: OutputTrigger, matchedText: string): boolean {
  const now = Date.now();
  const sample = matchedText.trim().replace(/\s+/g, " ").slice(0, 140).toLowerCase();
  const last = _lastNotifyByTrigger.get(trigger.id);
  if (last) {
    const elapsed = now - last.timestamp;
    if (elapsed < NOTIFY_THROTTLE_MS) {
      return true;
    }
    if (last.sample === sample && elapsed < NOTIFY_DEDUP_MS) {
      return true;
    }
  }
  _lastNotifyByTrigger.set(trigger.id, { timestamp: now, sample });
  return false;
}

// Initialize
loadTriggers();
