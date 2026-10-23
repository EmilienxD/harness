import { diagramChanged, meaningfulScene } from "./diagram-feedback.ts";
import { createClientOnlyFn } from "@tanstack/react-start";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

// Dynamic imports alone still let the production bundler share browser code with React.
const loadDiagramConversion = createClientOnlyFn(() => import("./diagram-conversion"));

/** Serializable scene boundary for conversion, editing, future storage and snapshot export. */
export type DiagramScene = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};
export type DiagramRecord = {
  source: string;
  scene: DiagramScene;
  baseline: DiagramScene;
  imageFallback: boolean;
};

type SceneRow = DiagramRecord & { question_id: string; diagram_id: string; revision: string };
type Transport = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Separately persisted scenes; writes are serialized and explicit flushes propagate failures. */
export class DiagramSceneStore {
  readonly roundId: string;
  private transport: Transport | undefined;
  constructor(roundId: string, transport?: Transport) {
    this.roundId = roundId;
    this.transport = transport;
  }
  private records = new Map<string, DiagramRecord>();
  private identities = new Map<string, [string, string]>();
  private revisions = new Map<string, string>();
  private saved = new Map<string, string>();
  private exported = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue = Promise.resolve();
  private loading: Promise<void> | undefined;
  private preparations = new Map<string, Promise<DiagramRecord>>();
  private observed = new Map<string, string>();
  private listeners = new Set<() => void>();
  private preparationErrors = new Map<string, string>();
  preparationError(questionId: string, diagramId: string) {
    return this.preparationErrors.get(this.key(questionId, diagramId));
  }
  error = "";
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private preserveDrafts() {
    if (typeof localStorage === "undefined") return;
    const drafts = [...this.records]
      .filter(([key, record]) => this.saved.get(key) !== meaningfulScene(record.scene))
      .map(([key, record]) => ({
        key,
        record,
        identity: this.identities.get(key),
        revision: this.revisions.get(key) ?? null,
      }));
    try {
      if (drafts.length) localStorage.setItem(`grill-diagram-draft:${this.roundId}`, JSON.stringify(drafts));
      else localStorage.removeItem(`grill-diagram-draft:${this.roundId}`);
    } catch {
      /* The server remains the durable authority if browser storage is full. */
    }
  }
  private emit() {
    this.listeners.forEach((listener) => listener());
  }
  private key(questionId: string, diagramId: string) {
    return JSON.stringify([this.roundId, questionId, diagramId]);
  }
  async load() {
    if (!this.transport) return;
    this.loading ??= this.transport<{ scenes: SceneRow[] }>(`rounds/${this.roundId}/scenes`)
      .then(({ scenes }) => {
        for (const row of scenes) {
          const key = this.key(row.question_id, row.diagram_id);
          this.records.set(key, {
            source: row.source,
            scene: row.scene,
            baseline: row.baseline,
            imageFallback: row.imageFallback,
          });
          this.identities.set(key, [row.question_id, row.diagram_id]);
          this.revisions.set(key, row.revision);
          this.saved.set(key, meaningfulScene(row.scene));
        }
        if (typeof localStorage !== "undefined") {
          const raw = localStorage.getItem(`grill-diagram-draft:${this.roundId}`);
          if (raw) {
            const drafts = JSON.parse(raw) as Array<{
              key: string;
              record: DiagramRecord;
              identity: [string, string];
              revision: string | null;
            }>;
            for (const draft of drafts) {
              const restored = this.records.get(draft.key);
              if (
                (this.revisions.get(draft.key) ?? null) !== draft.revision &&
                (!restored || meaningfulScene(restored.scene) !== meaningfulScene(draft.record.scene))
              )
                throw new Error(
                  "A recovered diagram draft conflicts with a newer saved drawing. The browser draft is preserved.",
                );
              if (restored && restored.source !== draft.record.source)
                throw new Error("A recovered diagram draft has different source. The browser draft is preserved.");
              this.records.set(draft.key, { ...draft.record, baseline: restored?.baseline ?? draft.record.baseline });
              this.identities.set(draft.key, draft.identity);
            }
          }
        }
        this.emit();
      })
      .catch((cause) => {
        this.loading = undefined;
        throw cause;
      });
    return this.loading;
  }
  async prepare(questionId: string, diagramId: string, source: string, persist = true): Promise<DiagramRecord> {
    const key = this.key(questionId, diagramId);
    const pending = this.preparations.get(key);
    if (pending) return pending;
    const work = (async () => {
      await this.load();
      const restored = this.get(questionId, diagramId);
      if (restored) {
        if (restored.source !== source)
          throw new Error(`Diagram ${questionId}/${diagramId} has different saved source. Its drawing is preserved.`);
        return restored;
      }
      const { convertDiagram } = await loadDiagramConversion();
      const record = await convertDiagram(source);
      this.set(questionId, diagramId, record, persist);
      return record;
    })();
    this.preparations.set(key, work);
    try {
      const record = await work;
      this.preparationErrors.delete(key);
      this.emit();
      return record;
    } catch (cause) {
      this.preparationErrors.set(key, cause instanceof Error ? cause.message : "Diagram preparation failed.");
      this.emit();
      throw cause;
    } finally {
      this.preparations.delete(key);
    }
  }
  get(questionId: string, diagramId: string) {
    return this.records.get(this.key(questionId, diagramId));
  }
  set(questionId: string, diagramId: string, record: DiagramRecord, persist = true) {
    const key = this.key(questionId, diagramId);
    this.records.set(key, record);
    this.identities.set(key, [questionId, diagramId]);
    if (persist) this.changed(questionId, diagramId);
  }
  changed(questionId: string, diagramId: string) {
    const key = this.key(questionId, diagramId);
    if (!this.transport) return;
    const semantic = meaningfulScene(this.records.get(key)!.scene);
    if (this.observed.get(key) === semantic) return;
    this.observed.set(key, semantic);
    this.preserveDrafts();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        void this.flush().catch(() => {});
      }, 800),
    );
    this.emit();
  }
  async flush(exportImages = false) {
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        await this.load();
        for (const [key, record] of this.records) {
          clearTimeout(this.timers.get(key));
          const [questionId, diagramId] = this.identities.get(key)!;
          const path = `rounds/${this.roundId}/scenes/${questionId}/${diagramId}`;
          const captured = copyScene(record.scene);
          const semantic = meaningfulScene(captured);
          if (this.transport && this.saved.get(key) !== semantic) {
            const body = JSON.stringify({
              ...record,
              scene: captured,
              expected_revision: this.revisions.get(key) ?? null,
            });
            if (new TextEncoder().encode(body).length > 4_000_000)
              throw new Error(
                "This diagram exceeds the 4 MB save limit. Simplify the drawing and retry; your draft is preserved.",
              );
            const result = await this.transport<{ revision: string; baseline: DiagramScene }>(path, {
              method: "PUT",
              body,
            });
            this.revisions.set(key, result.revision);
            record.baseline = result.baseline;
            this.saved.set(key, semantic);
          }
          if (
            this.transport &&
            exportImages &&
            diagramChanged(record.baseline, captured) &&
            this.exported.get(key) !== this.revisions.get(key)
          ) {
            const { exportDiagramPng } = await loadDiagramConversion();
            const png = await exportDiagramPng(captured);
            if (png.size > 2_900_000)
              throw new Error(
                "The diagram image exceeds the 2.9 MB export limit. Simplify the drawing and retry; your draft is preserved.",
              );
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error("Diagram image could not be read."));
              reader.onload = () => resolve(String(reader.result).split(",")[1]!);
              reader.readAsDataURL(png);
            });
            await this.transport(`${path}/image`, {
              method: "POST",
              body: JSON.stringify({ revision: this.revisions.get(key), png: data }),
            });
            this.exported.set(key, this.revisions.get(key)!);
          }
        }
        this.preserveDrafts();
        if (
          exportImages &&
          [...this.records].some(([key, record]) => this.saved.get(key) !== meaningfulScene(record.scene))
        )
          throw new Error("The diagram changed during review preparation. Retry review to include the latest drawing.");
        this.error = "";
        this.emit();
      })
      .catch((cause) => {
        this.error = cause instanceof Error ? cause.message : "Diagram save failed.";
        this.emit();
        throw cause;
      });
    this.queue = work;
    return work;
  }
}

/** Keep viewport and meaningful canvas/export settings, excluding selections and live collaborators. */
export function sceneAppState(state: Partial<AppState>): Partial<AppState> {
  const {
    scrollX,
    scrollY,
    zoom,
    viewBackgroundColor,
    gridSize,
    gridStep,
    gridModeEnabled,
    exportBackground,
    exportScale,
    exportWithDarkMode,
  } = state;
  return {
    scrollX,
    scrollY,
    zoom,
    viewBackgroundColor,
    gridSize,
    gridStep,
    gridModeEnabled,
    exportBackground,
    exportScale,
    exportWithDarkMode,
  } as Partial<AppState>;
}

export function copyScene(scene: DiagramScene): DiagramScene {
  return structuredClone(scene);
}
