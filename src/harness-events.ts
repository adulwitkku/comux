// Harness event bus (ADR-0023): typed notifications shared by the TUI and Dashboard surfaces.

import type { AgentStatusRow } from "./agent-roster.ts";

export type GrillKind = "confirm" | "choose";

export type HarnessEvent =
  | { type: "log"; text: string; ts: number }
  | { type: "status"; phase: string; ts: number }
  | {
      type: "grill";
      id: string;
      kind: GrillKind;
      question: string;
      options?: string[];
      ts: number;
    }
  | { type: "turn_done"; ts: number }
  | { type: "agent_status"; agents: AgentStatusRow[]; ts: number };

export type HarnessListener = (event: HarnessEvent) => void;

/** Fan-out bus for Harness events. Each surface subscribes independently. */
export class HarnessBus {
  private listeners = new Set<HarnessListener>();

  subscribe(fn: HarnessListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: HarnessEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  log(text: string): void {
    this.emit({ type: "log", text, ts: Date.now() });
  }

  status(phase: string): void {
    this.emit({ type: "status", phase, ts: Date.now() });
  }

  turnDone(): void {
    this.emit({ type: "turn_done", ts: Date.now() });
  }
}

/** Global bus for the active Harness session (one surface per workspace). */
export const harnessBus = new HarnessBus();
