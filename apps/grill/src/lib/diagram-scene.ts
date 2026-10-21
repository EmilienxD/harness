import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

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

/** Scoped to a questionnaire. Explicit IDs never depend on document order. */
export class DiagramSceneStore {
  constructor(readonly roundId: string) {}
  private records = new Map<string, DiagramRecord>();
  get(questionId: string, diagramId: string) {
    return this.records.get(JSON.stringify([this.roundId, questionId, diagramId]));
  }
  set(questionId: string, diagramId: string, record: DiagramRecord) {
    this.records.set(JSON.stringify([this.roundId, questionId, diagramId]), record);
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
