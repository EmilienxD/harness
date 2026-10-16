import { InteractiveMode, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component } from "@earendil-works/pi-tui";

// Pi 1.2.0 has no public insertion point in the loaded-resources listing.
// Keep the private UI dependency here; never change tool definitions or execution.
type StartupHost = {
  session: AgentSession;
  loadedResourcesContainer: { children: Component[] };
  shouldShowStartupDetails(): boolean;
  getStartupExpansionState(): boolean;
};
type ListingOptions = { force?: boolean };
type State = {
  observe?: (session: AgentSession) => void;
  section?: (session: AgentSession, expanded: boolean) => Component;
};
const key = Symbol.for("harness:tool-inspector:startup:pi-1.2.0");

export function installStartupTools(
  observe: NonNullable<State["observe"]>,
  section: NonNullable<State["section"]>,
): (() => void) | undefined {
  const registry = globalThis as typeof globalThis & { [key: symbol]: State | undefined };
  const prototype = InteractiveMode.prototype as unknown as {
    showLoadedResources?: (this: StartupHost, options?: ListingOptions) => void;
  };
  if (typeof prototype.showLoadedResources !== "function") return undefined;
  let state = registry[key];
  if (!state) {
    state = registry[key] = {};
    const shared = state;
    const original = prototype.showLoadedResources;
    prototype.showLoadedResources = function (options) {
      shared.observe?.(this.session);
      original.call(this, options);
      if (!shared.section || !(options?.force || this.shouldShowStartupDetails())) return;
      const container = this.loadedResourcesContainer;
      if (!Array.isArray(container?.children)) return;
      const loader = this.session.resourceLoader;
      const hasContext = Boolean(loader.getSystemPromptSource()) ||
        loader.getAppendSystemPromptSources().length > 0 ||
        loader.getAgentsFiles().agentsFiles.length > 0;
      // The native Context section is [leading spacer, section, trailing spacer].
      // If absent, Tools becomes the first section. Do not bypass quietStartup.
      container.children.splice(hasContext ? 3 : 0, 0,
        shared.section(this.session, this.getStartupExpansionState()), new Spacer(1));
    };
  }
  state.observe = observe;
  state.section = section;
  return () => {
    if (state.observe === observe) {
      state.observe = undefined;
      state.section = undefined;
    }
  };
}

export function startupSection(
  text: (expanded: boolean) => string,
  initiallyExpanded: boolean,
): Component {
  let expanded = initiallyExpanded;
  return {
    render: (width) => new Text(text(expanded), 0, 0).render(width),
    invalidate() {},
    // Pi's Ctrl+O updates expandable components in the resource container.
    setExpanded(value: boolean) { expanded = value; },
  } as Component;
}
