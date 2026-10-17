// Pi Calm - shared presentation state for the standalone Calm extension.
//
// Adapted from the Firstmate project's Calm implementation.
// Copyright (c) 2026 Kun Chen. MIT License - see the package's LICENSE.
//
// This module owns only the in-memory presentation flags. Presentation filtering
// must never delete or alter semantic, session, or export data, so the export
// path forces stock rendering for the duration of an /export or /share command.

let active = false;
let stockExportRendering = false;
export type CalmToolCall = {
  rowId: string;
  callId: string;
  summary: string;
  status: "running" | "success" | "error";
  completedAt?: number;
};
let latestToolCall: CalmToolCall | undefined;
let toolSpinner = "⠴";

export function getCalmToolSpinner(): string {
  return toolSpinner;
}

export function setCalmToolSpinner(frame: string): void {
  toolSpinner = frame;
}

export function getCalmToolCall(): CalmToolCall | undefined {
  return latestToolCall;
}

export function setCalmToolCall(call: CalmToolCall | undefined): void {
  latestToolCall = call;
}

/** True while Calm presentation filtering is enabled. */
export function calmPresentationIsActive(): boolean {
  return active;
}

export function setCalmPresentation(next: boolean): void {
  active = next;
}

/** True while an /export or /share render is in flight and stock output is required. */
export function calmStockExportRenderingIsActive(): boolean {
  return stockExportRendering;
}

export function setCalmStockExportRendering(next: boolean): void {
  stockExportRendering = next;
}

/**
 * True while Calm should hide the supported transcript chrome: collapsed
 * thinking labels, known Pi built-in tool shells, and opted-in Web Toolkit
 * shells. Genuine user prompts, assistant text, unrelated custom tools, and every other transcript row
 * class are never filtered by this flag.
 */
export function calmHidesTranscriptChrome(): boolean {
  return active && !stockExportRendering;
}
