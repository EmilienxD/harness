import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DiagramTarget } from "@/lib/diagram-discovery";
import type DiagramEditor from "./diagram-editor";
import type { DiagramSceneStore } from "@/lib/diagram-scene";

type Editor = typeof DiagramEditor;
type Props = Parameters<Editor>[0];
class DiagramBoundary extends Component<{ children: ReactNode }, { failed: boolean; attempt: number }> {
  override state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <div role="alert">
          This diagram's editor stopped working.{" "}
          <button
            type="button"
            onClick={() => this.setState(({ attempt }) => ({ failed: false, attempt: attempt + 1 }))}
          >
            Retry diagram
          </button>
        </div>
      );
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}

function DiagramMount(props: Props) {
  const [Editor, setEditor] = useState<ComponentType<Props> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (props.hidden) return;
    let live = true;
    setFailed(false);
    void import("./diagram-editor")
      .then((module) => {
        if (live) setEditor(() => module.default);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [props.hidden, attempt]);
  if (Editor)
    return (
      <DiagramBoundary>
        <Editor {...props} />
      </DiagramBoundary>
    );
  return failed ? (
    <div role="alert">
      The diagram editor could not load.{" "}
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>
        Retry diagram
      </button>
    </div>
  ) : (
    <p role="status">Loading diagram editor...</p>
  );
}

export function AuthoredDiagrams({
  targets,
  questionId,
  store,
  hidden,
  readOnly,
}: {
  targets: DiagramTarget[];
  questionId: string;
  store: DiagramSceneStore;
  hidden: boolean;
  readOnly: boolean;
}) {
  return targets.map(({ host, ...diagram }) =>
    createPortal(
      <DiagramMount {...diagram} questionId={questionId} store={store} hidden={hidden} readOnly={readOnly} />,
      host,
      diagram.id,
    ),
  );
}
