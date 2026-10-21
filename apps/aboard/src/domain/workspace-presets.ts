import { randomUUID } from "node:crypto";

/** An empty provider string is a plain shell tab; an unassigned pane defaults to one shell. */
export interface WorkspacePane { providers: string[] }
export interface WorkspacePreset {
  id: string;
  name: string;
  columns: number;
  rows: number;
  panes: WorkspacePane[];
  builtIn?: boolean;
}
export interface PresetStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}
export const PRESET_STORAGE_KEY = "aboard.workspacePresets";

function template(id: string, name: string, columns: number, rows: number, providers: string[][]): WorkspacePreset {
  return { id, name, columns, rows, panes: providers.map((providers) => ({ providers })), builtIn: true };
}
export const STARTER_PRESETS: readonly WorkspacePreset[] = [
  template("builtin.chatgpt-pair", "Codex pair (vertically stacked)", 1, 2, [["chatgpt"], ["chatgpt"]]),
  template("builtin.claude-pair", "Claude pair (vertically stacked)", 1, 2, [["claude"], ["claude"]]),
  template("builtin.claude-chatgpt", "Claude + Codex", 2, 1, [["claude"], ["chatgpt"]]),
  template("builtin.chatgpt-team", "Codex team", 4, 2, Array.from({ length: 8 }, () => ["chatgpt"])),
  template("builtin.mixed-team", "Mixed team", 2, 2, [["claude"], ["chatgpt"], ["claude"], ["chatgpt"]]),
  template("builtin.tabs", "Tabs only", 1, 1, [["claude", "chatgpt"]]),
];

export function validateWorkspacePreset(value: unknown, providerIds: readonly string[]): WorkspacePreset {
  if (!value || typeof value !== "object") throw new Error("Preset must be an object.");
  const preset = value as Record<string, unknown>;
  if (typeof preset.id !== "string" || !preset.id.trim() || typeof preset.name !== "string" || !preset.name.trim()) throw new Error("Preset needs an identifier and a display name.");
  const { columns, rows } = preset;
  if (typeof columns !== "number" || typeof rows !== "number" || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 9) throw new Error("Choose positive Columns and Rows containing at most nine panes.");
  if (!Array.isArray(preset.panes) || preset.panes.length !== columns * rows) throw new Error("Preset pane count must match Columns × Rows.");
  const panes = preset.panes.map((pane: unknown, index: number) => {
    if (!pane || typeof pane !== "object" || !Array.isArray((pane as WorkspacePane).providers)) throw new Error(`Pane ${index + 1} needs a provider assignment list.`);
    const providers = (pane as WorkspacePane).providers;
    for (const provider of providers) if (typeof provider !== "string" || (provider !== "" && !providerIds.includes(provider))) throw new Error(`Pane ${index + 1} uses unavailable provider: ${String(provider)}.`);
    return { providers: [...providers] };
  });
  return { id: preset.id, name: preset.name.trim(), columns, rows, panes, ...(preset.builtIn === true ? { builtIn: true } : {}) };
}

export function countPresetAgents(preset: WorkspacePreset): number { return preset.panes.reduce((count, pane) => count + pane.providers.filter(Boolean).length, 0); }

/** Resize the draft grid, dropping removed panes without changing the saved preset. */
export function resizeWorkspacePreset(preset: WorkspacePreset, columns: number, rows: number): WorkspacePreset {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 9) throw new Error("Choose positive Columns and Rows containing at most nine panes.");
  return { ...preset, columns, rows, panes: Array.from({ length: columns * rows }, (_, index) => ({ providers: [...(preset.panes[index]?.providers ?? [])] })) };
}

export class WorkspacePresetStore {
  private personal: WorkspacePreset[] = [];
  private hidden = new Set<string>();
  private preferredId = "builtin.chatgpt-pair";
  constructor(private readonly storage: PresetStorage, private readonly providerIds: readonly string[], diagnostic: (message: string) => void = () => {}) {
    const saved = storage.get<unknown>(PRESET_STORAGE_KEY);
    if (saved === undefined) return;
    if (!saved || typeof saved !== "object" || (saved as { version?: unknown }).version !== 1) { diagnostic("Ignored saved workspace presets: unsupported or invalid storage version."); return; }
    const data = saved as Record<string, unknown>;
    if (Array.isArray(data.presets)) for (const [index, item] of data.presets.entries()) {
      try {
        const preset = validateWorkspacePreset(item, providerIds);
        if ((preset.id.startsWith("builtin.") && !STARTER_PRESETS.some((starter) => starter.id === preset.id)) || this.personal.some((other) => other.id === preset.id)) throw new Error("Duplicate or reserved identifier.");
        delete preset.builtIn;
        this.personal.push(preset);
      } catch (error) { diagnostic(`Ignored saved workspace preset ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    } else diagnostic("Ignored saved personal presets: expected a preset list.");
    if (Array.isArray(data.hiddenBuiltIns)) this.hidden = new Set(data.hiddenBuiltIns.filter((id): id is string => typeof id === "string"));
    if (typeof data.preferredId === "string") this.preferredId = data.preferredId;
  }
  get presets(): WorkspacePreset[] {
    return structuredClone([
      ...STARTER_PRESETS.filter((preset) => !this.hidden.has(preset.id)).map((preset) => this.personal.find((item) => item.id === preset.id) ?? preset),
      ...this.personal.filter((preset) => !preset.id.startsWith("builtin.")),
    ].filter((preset) => preset.panes.every((pane) => pane.providers.every((id) => (id === "" || this.providerIds.includes(id))))));
  }
  get preferredPreset(): WorkspacePreset {
    return this.presets.find((preset) => preset.id === this.preferredId) ?? this.presets[0] ?? { id: "empty", name: "Empty workspace", columns: 1, rows: 1, panes: [{ providers: [] }] };
  }
  async save(value: WorkspacePreset): Promise<WorkspacePreset> {
    this.refreshPersonal();
    const preset = validateWorkspacePreset(value, this.providerIds);
    if (preset.id === "new") preset.id = randomUUID();
    else this.require(preset.id);
    return this.savePreset(preset);
  }
  async saveAs(value: WorkspacePreset): Promise<WorkspacePreset> {
    this.refreshPersonal();
    const preset = validateWorkspacePreset(value, this.providerIds);
    if (this.require(preset.id).name === preset.name) throw new Error("Choose a different name to save a new preset.");
    preset.id = randomUUID();
    return this.savePreset(preset);
  }
  private async savePreset(preset: WorkspacePreset): Promise<WorkspacePreset> {
    delete preset.builtIn;
    const index = this.personal.findIndex((item) => item.id === preset.id);
    if (index < 0) this.personal.push(preset); else this.personal[index] = preset;
    this.preferredId = preset.id;
    await this.persist();
    return structuredClone(preset);
  }
  async delete(id: string): Promise<void> {
    this.refreshPersonal();
    const preset = this.require(id);
    if (preset.id.startsWith("builtin.")) this.hidden.add(id);
    this.personal = this.personal.filter((item) => item.id !== id);
    if (this.preferredId === id) this.preferredId = this.presets[0]?.id ?? "empty";
    await this.persist();
  }
  async setPreferred(id: string): Promise<void> { this.refreshPersonal(); this.require(id); this.preferredId = id; await this.persist(); }
  private refreshPersonal(): void {
    const current = new WorkspacePresetStore(this.storage, this.providerIds);
    this.personal = current.personal;
    this.hidden = current.hidden;
    this.preferredId = current.preferredId;
  }
  private require(id: string): WorkspacePreset {
    const preset = this.presets.find((item) => item.id === id);
    if (!preset) throw new Error("The selected preset is no longer available.");
    return preset;
  }
  private async persist(): Promise<void> {
    await this.storage.update(PRESET_STORAGE_KEY, { version: 1, presets: this.personal, hiddenBuiltIns: [...this.hidden], preferredId: this.preferredId });
  }
}
