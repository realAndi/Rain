// Terminal capture utilities: export terminal content as text or save to file.

import type { RenderedLine, CommandSnapshot } from "./types";
import { saveTextToFile } from "./ipc";

export function linesToPlainText(lines: RenderedLine[]): string {
  return lines
    .map((line) => line.spans.map((s) => s.text).join(""))
    .join("\n");
}

export function snapshotToText(snapshot: CommandSnapshot): string {
  const header = snapshot.command
    ? `$ ${snapshot.command}`
    : "(no command)";
  const time = new Date(snapshot.timestamp).toLocaleString();
  const output = linesToPlainText(snapshot.lines);
  return `${header}\n# ${time}  cwd: ${snapshot.cwd}\n${output}`;
}

export function snapshotsToText(snapshots: CommandSnapshot[]): string {
  return snapshots.map(snapshotToText).join("\n\n---\n\n");
}

export function visibleLinesToText(
  visibleLines: Record<number, RenderedLine>,
  baseGlobal: number,
  rows: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = visibleLines[baseGlobal + i];
    if (line) {
      lines.push(line.spans.map((s) => s.text).join(""));
    } else {
      lines.push("");
    }
  }
  return lines.join("\n");
}

export async function exportTerminalToFile(content: string): Promise<boolean> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return saveTextToFile(content, `rain-export-${timestamp}.txt`);
}
