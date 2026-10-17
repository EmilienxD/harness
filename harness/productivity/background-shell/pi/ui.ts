import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, isKeyRelease, truncateToWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

export interface ViewJob {
  id: string; title: string; command: string; state: string; shell: string;
  elapsed_seconds: number; exit_code: number | null; log_path: string;
  log_truncated: boolean; output?: string;
}
export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}
export function jobLabel(job: Pick<ViewJob, "id" | "title" | "state" | "elapsed_seconds" | "exit_code">): string {
  return `${clean(job.title).replace(/\s+/g, " ")} · ${job.state} · ${job.elapsed_seconds}s${job.exit_code === null ? "" : ` · exit ${job.exit_code}`} · ${job.id.slice(0, 11)}`;
}
interface Source {
  list(): ViewJob[];
  cancel(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}
export function openJobPanel(source: Source, ui: ExtensionUIContext): () => void {
  let closed = false;
  const bindings = getKeybindings();
  const savedBindings = bindings.getUserBindings();
  const pageActions = ["tui.altScreen.pageUp", "tui.altScreen.pageDown"];
  bindings.setUserBindings({ ...savedBindings, ...Object.fromEntries(pageActions.map(action => [action, []])) });
  const previousEditor = ui.getEditorComponent();
  const separatorEditor: Parameters<ExtensionUIContext["setEditorComponent"]>[0] =
    (tui, theme, keys) => {
      panel = new JobPanel(source, tui, ui.theme, keys, close);
      const editor = new SeparatorEditor(tui, theme, keys);
      editor.panel = panel;
      return editor;
    };
  let off: (() => void) | undefined;
  let panel: JobPanel | undefined;
  const dispose = () => {
    if (closed) return;
    closed = true;
    off?.(); off = undefined;
    panel?.dispose();
    const restored = { ...bindings.getUserBindings() };
    for (const action of pageActions) {
      if (Object.hasOwn(savedBindings, action)) restored[action] = savedBindings[action]!;
      else delete restored[action];
    }
    bindings.setUserBindings(restored);
    if (ui.getEditorComponent() === separatorEditor) ui.setEditorComponent(previousEditor);
  };
  const close = () => {
    if (closed) return;
    dispose();
  };
  ui.setEditorComponent(separatorEditor);
  off = ui.onTerminalInput(data => {
    if (closed) return;
    if (!isKeyRelease(data)) panel?.handleInput(data);
    return { consume: true };
  });
  return close;
}
export class SeparatorEditor extends CustomEditor {
  panel?: JobPanel;
  render(width: number): string[] {
    return [this.borderColor("─".repeat(Math.max(0, width))), ...(this.panel?.render(width) ?? [])];
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !this.panel) return;
    this.panel.scroll(event.wheelDelta ?? 0);
    return { handled: true, render: true };
  }
}
export class JobPanel implements Component {
  private hiddenCancelled = new Set<string>();
  private selected?: string;
  private index = 0;
  private detail = false;
  private offset = 0;
  private fullLog?: string;
  private busy = false;
  private note = "";
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private viewportRows = 1;
  constructor(private source: Source, private tui: TUI, private theme: Theme,
    private keys: Pick<KeybindingsManager, "matches">, private done: (value: void) => void) {
    for (const job of source.list()) if (job.state === "cancelled") this.hiddenCancelled.add(job.id);
    const jobs = this.visibleJobs();
    this.index = Math.max(0, jobs.findIndex(job => job.state === "running"));
    this.selected = jobs[this.index]?.id;
    this.unsubscribe = source.subscribe(() => this.requestRender());
    this.ticker = setInterval(() => this.requestRender(), 1000);
  }
  private requestRender() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; if (!this.closed) this.tui.requestRender(); }, 50);
  }
  private selection() {
    const jobs = this.visibleJobs();
    const stable = jobs.findIndex(job => job.id === this.selected);
    this.index = stable >= 0 ? stable : Math.min(this.index, Math.max(0, jobs.length - 1));
    this.selected = jobs[this.index]?.id;
    return { jobs, job: jobs[this.index] };
  }
  private visibleJobs() { return this.source.list().filter(job => !this.hiddenCancelled.has(job.id)); }
  private maxHeight() { return Math.min(20, Math.max(3, Math.floor(this.tui.terminal.rows * 0.45))); }
  private height() { return this.viewportRows; }
  scroll(lines: number) {
    if (this.detail) this.offset = Math.max(0, this.offset - lines);
    else {
      const { jobs } = this.selection();
      this.index = Math.max(0, Math.min(jobs.length - 1, this.index + lines));
      this.selected = jobs[this.index]?.id;
    }
    this.requestRender();
  }
  handleInput(data: string) {
    if (this.closed || isKeyRelease(data)) return;
    const { jobs, job } = this.selection();
    if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "app.interrupt")) {
      if (this.detail) { this.detail = false; this.fullLog = undefined; this.offset = 0; }
      else { this.dispose(); this.done(); return; }
    } else if (data === "x" && job && !this.busy) {
      this.detail = false; this.fullLog = undefined; this.offset = 0; this.note = "";
      if (job.state === "running") {
        this.busy = true; this.note = "Stopping job…";
        void this.source.cancel(job.id).then(() => { this.note = "Job stopped."; }, () => { this.note = "Could not stop job; inspect its status."; })
          .finally(() => { this.busy = false; this.requestRender(); });
      }
    } else if (this.detail && data === "l" && job && !this.busy) {
      this.busy = true; const id = job.id; this.note = "Loading retained log…";
      void readFile(job.log_path, "utf8").then(text => {
        if (!this.closed && this.detail && this.selected === id) { this.fullLog = clean(text); this.offset = 0; this.note = "Retained log snapshot. Press f to return to live output."; }
      }, () => { this.note = "Log is unavailable."; }).finally(() => { this.busy = false; this.requestRender(); });
    } else if (this.detail && data === "f") {
      this.fullLog = undefined; this.offset = 0; this.note = "Following live output.";
    } else if (!this.detail && this.keys.matches(data, "tui.select.confirm") && job) {
      this.detail = true; this.offset = 0; this.note = "";
    } else if (data === "k" || this.keys.matches(data, "tui.select.up")) {
      if (this.detail) this.offset += 1;
      else if (jobs.length) { this.index = (this.index + jobs.length - 1) % jobs.length; this.selected = jobs[this.index]?.id; }
    } else if (data === "j" || this.keys.matches(data, "tui.select.down")) {
      if (this.detail) this.offset = Math.max(0, this.offset - 1);
      else if (jobs.length) { this.index = (this.index + 1) % jobs.length; this.selected = jobs[this.index]?.id; }
    } else if (this.keys.matches(data, "tui.editor.pageUp")) this.scroll(-this.height());
    else if (this.keys.matches(data, "tui.editor.pageDown")) this.scroll(this.height());
    this.requestRender();
  }
  render(width: number): string[] {
    const { jobs, job } = this.selection();
    const heading = this.theme.fg("accent", this.theme.bold("Background shell"));
    let lines = [heading];
    const limit = this.maxHeight();
    const footer = this.theme.fg("dim", this.detail ? "↑/↓ scroll · PgUp/PgDn · l log · f follow · x stop · Esc back" : "↑/↓ select · Enter inspect · x stop · Esc close");
    const noteRows = this.note && limit > 5 ? 1 : 0;
    if (this.detail && job) {
      const text = this.fullLog ?? clean(job.output ?? "");
      const output = wrapTextWithAnsi(text, Math.max(1, width));
      if (limit > 4) lines.push(jobLabel(job));
      if (limit > 6) {
        const commandLines = wrapTextWithAnsi(`${job.shell}: ${clean(job.command).replace(/\s+/g, " ")}`, Math.max(1, width));
        const count = Math.min(3, limit - lines.length - 2 - noteRows);
        const visible = commandLines.slice(0, count);
        if (commandLines.length > count && visible.length) {
          visible[visible.length - 1] = truncateToWidth(visible[visible.length - 1]!, Math.max(0, width - 1), "") + "…";
        }
        lines.push(...visible);
      }
      const available = Math.max(1, limit - lines.length - 1 - noteRows);
      this.viewportRows = available;
      this.offset = Math.min(this.offset, Math.max(0, output.length - available));
      const end = Math.max(0, output.length - this.offset);
      lines.push(...output.slice(Math.max(0, end - available), end));
    } else {
      const available = Math.max(1, limit - 2 - noteRows);
      this.viewportRows = available;
      const start = Math.max(0, Math.min(this.index - Math.floor(available / 2), jobs.length - available));
      lines.push(...jobs.slice(start, start + available).map((item, i) =>
        (i + start === this.index ? "❯ " : "  ") + jobLabel(item)));
      if (!jobs.length) lines.push("No background jobs in this session.");
    }
    if (noteRows) lines.push(this.theme.fg("muted", this.note));
    lines.push(footer);
    return lines.slice(0, limit).map(line => truncateToWidth(line, Math.max(1, width)));
  }
  invalidate() {}
  dispose() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); clearInterval(this.ticker); this.unsubscribe();
  }
}
