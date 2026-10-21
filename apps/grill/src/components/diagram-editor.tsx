import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { sceneAppState, type DiagramRecord, type DiagramSceneStore } from "@/lib/diagram-scene";
import { summarizeDiagram } from "@/lib/diagram-feedback";
import "@excalidraw/excalidraw/index.css";
import "./diagram-editor.css";

export default function DiagramEditor({
  id,
  source,
  caption,
  questionId,
  store,
  hidden,
  readOnly,
}: {
  id: string;
  source: string;
  caption: string;
  questionId: string;
  store: DiagramSceneStore;
  hidden: boolean;
  readOnly: boolean;
}) {
  const [record, setRecord] = useState<DiagramRecord | undefined>(() => store.get(questionId, id));
  const recordRef = useRef(record);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const fitted = useRef(false);
  const shell = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (recordRef.current?.source === source || hidden) return;
    let live = true;
    setFailure("");
    void store
      .prepare(questionId, id, source, !readOnly)
      .then((converted) => {
        if (!live) return;
        recordRef.current = converted;
        setRecord(converted);
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : "Conversion failed.");
      });
    return () => {
      live = false;
    };
  }, [source, hidden, attempt, store, questionId, id, readOnly]);
  useEffect(() => {
    if (hidden || readOnly) {
      setEditing(false);
      setFullscreen(false);
    }
  }, [hidden, readOnly]);
  useEffect(() => {
    if (!fullscreen) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    shell.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.body.style.overflow = previous;
      returnFocus.current?.focus();
    };
  }, [fullscreen]);
  useEffect(() => {
    if (readOnly) return;
    const flush = () => {
      void store.flush().catch(() => {});
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visibility);
      flush();
    };
  }, [store, readOnly]);
  useEffect(() => {
    if (hidden && !readOnly) void store.flush().catch(() => {});
  }, [hidden, readOnly, store]);
  const capture = () => {
    const current = recordRef.current;
    if (!api.current || !current || readOnly) return;
    current.scene = {
      elements: api.current.getSceneElementsIncludingDeleted(),
      appState: sceneAppState(api.current.getAppState()),
      files: api.current.getFiles(),
    };
    store.changed(questionId, id);
  };
  const resize = (next: boolean) => {
    capture();
    api.current = null;
    if (next) returnFocus.current = document.activeElement as HTMLElement;
    setFullscreen(next);
  };
  const content = (
    <div
      ref={shell}
      className={`diagram-shell ${fullscreen ? "is-fullscreen" : ""}`}
      data-diagram-editor={id}
      data-diagram-shortcuts="true"
      role={fullscreen ? "dialog" : "group"}
      aria-modal={fullscreen || undefined}
      aria-label={caption}
      onKeyDown={(event) => {
        if (event.key === "Escape" && fullscreen && !(event.target instanceof HTMLTextAreaElement)) {
          event.preventDefault();
          resize(false);
        }
        if (event.key === "Tab" && fullscreen) {
          const items = Array.from(
            shell.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input, textarea, [tabindex="0"], a[href]',
            ) || [],
          ).filter((item) => item.getClientRects().length);
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="diagram-toolbar">
        <span>{readOnly ? "Read only" : editing ? "Editing diagram" : "Viewing diagram"}</span>
        {!readOnly && (
          <button
            type="button"
            disabled={!record || !!failure}
            onClick={() => {
              capture();
              setEditing(!editing);
            }}
          >
            {editing ? "Done editing" : "Edit diagram"}
          </button>
        )}
        <button type="button" onClick={() => resize(!fullscreen)}>
          {fullscreen ? "Close fullscreen" : "Fullscreen"}
        </button>
      </div>
      <EditorFeedback store={store} questionId={questionId} id={id} />
      {failure ? (
        <div className="diagram-error" role="alert">
          <p>This diagram could not be loaded or prepared. {failure}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry diagram
          </button>
          <details>
            <summary>Mermaid source</summary>
            <pre>{source}</pre>
          </details>
        </div>
      ) : !record ? (
        <p className="diagram-status" role="status">
          Preparing diagram...
        </p>
      ) : (
        <>
          {record.imageFallback && (
            <p className="diagram-status">
              This diagram is an image. You can draw over it; its nodes cannot be edited individually.
            </p>
          )}
          <div className={`diagram-canvas ${editing && !readOnly ? "is-editing" : "is-viewing"}`}>
            {!hidden && (
              <Excalidraw
                key={fullscreen ? "fullscreen" : "inline"}
                initialData={{ ...recordRef.current!.scene, scrollToContent: true }}
                viewModeEnabled={!editing || readOnly}
                handleKeyboardGlobally={false}
                autoFocus={false}
                onChange={(elements, state, files) => {
                  if (!fitted.current && api.current && state.width > 0 && state.height > 0) {
                    fitted.current = true;
                    const instance = api.current;
                    requestAnimationFrame(() => {
                      if (api.current === instance)
                        instance.scrollToContent(instance.getSceneElements(), { fitToContent: true });
                    });
                  }
                  if (readOnly || !recordRef.current) return;
                  recordRef.current.scene = { elements, appState: sceneAppState(state), files };
                  store.changed(questionId, id);
                }}
                excalidrawAPI={(instance) => {
                  api.current = instance;
                  fitted.current = false;
                }}
                UIOptions={{
                  canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: false },
                  tools: { image: false },
                }}
              />
            )}
            {(!editing || readOnly) && <div className="diagram-scroll-surface" aria-hidden="true" />}
          </div>
        </>
      )}
    </div>
  );
  return fullscreen
    ? createPortal(
        <dialog
          className="diagram-dialog"
          ref={dialog}
          aria-label={caption}
          onCancel={(event) => {
            event.preventDefault();
            resize(false);
          }}
        >
          {content}
        </dialog>,
        document.body,
      )
    : content;
}

function EditorFeedback({ store, questionId, id }: { store: DiagramSceneStore; questionId: string; id: string }) {
  const [, refresh] = useState(0);
  useEffect(() => store.subscribe(() => refresh((value) => value + 1)), [store]);
  const record = store.get(questionId, id);
  return (
    <>
      {store.error && (
        <div role="alert">
          Diagram changes could not be saved or exported. {store.error}{" "}
          <button type="button" onClick={() => void store.flush(true).catch(() => {})}>
            Retry diagram save
          </button>
        </div>
      )}
      {record && (
        <div className="diagram-feedback" aria-label="Diagram feedback">
          <strong>Diagram feedback</strong>
          <p style={{ whiteSpace: "pre-line" }}>{summarizeDiagram(record.baseline, record.scene)}</p>
        </div>
      )}
    </>
  );
}
