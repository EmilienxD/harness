import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { Disposable, WebviewView, WebviewViewProvider } from "vscode";
import { validateWorkspacePreset, type WorkspacePreset, type WorkspacePresetStore } from "../domain/workspace-presets.js";
import { validateCheckoutSelection, type CheckoutChoices, type CheckoutSelection } from "../platform/checkouts.js";

export const LAUNCH_VIEW_ID = "aboard.launch";

export interface LauncherRequest { preset: WorkspacePreset; destination: "current" | "new"; checkout?: CheckoutSelection }
export interface LaunchPanelOptions {
  store: WorkspacePresetStore;
  providers: readonly { id: string; displayName: string; icon: string }[];
  launch(request: LauncherRequest): Promise<void>;
  runAgent(warn: (message: string) => void): Promise<void>;
  checkoutChoices?(): Promise<CheckoutChoices>;
  currentPath?: string;
  validateBranch?(branch: string): Promise<string | undefined>;
}
export interface LaunchPanelHost { registerWebviewViewProvider(viewId: string, provider: WebviewViewProvider): Disposable }

export function registerLaunchPanel(host: LaunchPanelHost, options: LaunchPanelOptions): Disposable {
  const disposables: Disposable[] = [];
  let busy = false;
  const providerIds = options.providers.map((provider) => provider.id);
  async function state(view: WebviewView): Promise<void> {
    await view.webview.postMessage({ type: "state", providers: options.providers, presets: options.store.presets, preferredPreset: options.store.preferredPreset, busy, currentPath: options.currentPath, homeDirectory: homedir(), windowsPaths: process.platform === "win32", checkouts: await options.checkoutChoices?.() });
  }
  disposables.push(host.registerWebviewViewProvider(LAUNCH_VIEW_ID, {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      view.webview.html = launcherHtml(randomBytes(18).toString("base64"));
      disposables.push(view.webview.onDidReceiveMessage(async (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const message = raw as Record<string, unknown>;
        if (message.type === "ready" || message.type === "refresh") { await state(view); return; }
        if (message.type === "validateBranch" && typeof message.branch === "string") {
          const branch = message.branch.trim();
          let error: string | undefined;
          try { error = await options.validateBranch?.(branch); }
          catch (cause) { error = cause instanceof Error ? cause.message : "Unable to validate branch"; }
          await view.webview.postMessage({ type: "branchValidation", branch, requestId: message.requestId, error });
          return;
        }
        if (busy) return;
        busy = true;
        await view.webview.postMessage({ type: "busy", busy });
        try {
          const id = typeof message.id === "string" ? message.id : "";
          if (message.type === "save" || message.type === "saveAs") {
            const preset = message.type === "save"
              ? await options.store.save(validateWorkspacePreset(message.preset, providerIds))
              : await options.store.saveAs(validateWorkspacePreset(message.preset, providerIds));
            await view.webview.postMessage({ type: "saved", action: message.type, preset });
          }
          else if (message.type === "delete") await options.store.delete(id);
          else if (message.type === "preferred") await options.store.setPreferred(id);
          else if (message.type === "run") await options.runAgent((message) => { void view.webview.postMessage({ type: "error", message }); });
          else if (message.type === "launch") {
            if (message.destination !== "current" && message.destination !== "new") throw new Error("Choose Current window or New window.");
            const preset = validateWorkspacePreset(message.preset, providerIds);
            if (options.store.presets.some((item) => item.id === preset.id)) await options.store.setPreferred(preset.id);
            const selected = validateCheckoutSelection(message.checkout);
            const checkout: CheckoutSelection = selected.kind === "new" ? { kind: "new", branch: selected.branch } : selected;
            if (checkout.kind === "new") {
              const error = await options.validateBranch?.(checkout.branch);
              if (error) {
                await view.webview.postMessage({ type: "branchValidation", branch: checkout.branch, error });
                return;
              }
            }
            await options.launch({ preset, destination: message.destination, ...(message.checkout === undefined ? {} : { checkout }) });
          }
        } catch (error) {
          await view.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
        } finally {
          busy = false;
          await state(view);
        }
      }));
    },
  }));
  return { dispose() { for (const disposable of disposables) disposable.dispose(); } };
}

function launcherHtml(nonce: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:8px 12px}button,select,input{font:inherit;border:1px solid var(--vscode-input-border,transparent);padding:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);max-width:100%;box-sizing:border-box}button{cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{filter:brightness(1.1)}button:focus-visible,input:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}button:disabled{opacity:.5;cursor:default}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}label{display:block;margin:10px 0 4px}select,#branch{width:100%}.row{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.launch-actions,.preset-actions{gap:6px}.launch-actions button,.preset-actions button{flex:0 0 auto;min-width:max-content;padding:6px 10px;white-space:nowrap}.dimensions{display:flex;gap:12px}.dimensions label{flex:1}.dimensions input{display:block;width:100%;margin-top:4px}#preview{display:grid;gap:4px;margin:12px 0}#preview button{min-height:55px;white-space:pre-line;border:1px solid var(--vscode-panel-border)}#preview button.selected{outline:2px solid var(--vscode-focusBorder)}#error,#branchError,#checkoutWarning{color:var(--vscode-editorWarning-foreground,#cca700);white-space:pre-wrap}.assignment{display:flex;gap:4px;margin:5px 0}.assignment select{flex:1;min-width:0}.assignment button{flex:none}.preset-combo{position:relative}.preset-entry{display:flex}.preset-entry input{flex:1;min-width:0;width:100%}.preset-entry button{flex:none}#presetOptions{position:absolute;left:0;right:0;z-index:10;max-height:260px;overflow-y:auto;background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border))}.preset-option{display:block;width:100%;text-align:left;border:0;white-space:normal;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground)}.preset-option:hover,.preset-option[aria-selected=true]{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}[hidden]{display:none!important}</style></head><body>
<div class="row launch-actions"><button id="run" class="primary">Run Agent</button><button id="launch" class="primary">Launch layout</button></div>
<label for="destination">Window</label><select id="destination"><option value="current">Current window</option><option value="new" selected>New window</option></select>
<label for="checkout">Checkout</label><select id="checkout"><option value="current">Current checkout</option></select>
<p id="checkoutSummary" role="status"></p>
<div id="newCheckout" hidden><label for="branch">Branch</label><input id="branch" autocomplete="off" placeholder="feature/my-change" aria-describedby="branchError"><p id="branchError" role="alert" hidden></p></div>
<p id="checkoutWarning" role="status" hidden>Agents will run in another checkout. This window’s Explorer will stay on the current checkout.</p>
<label for="preset">Preset</label><div id="presetCombo" class="preset-combo"><div class="preset-entry"><input id="preset" role="combobox" aria-expanded="false" aria-controls="presetOptions" aria-autocomplete="none" autocomplete="off" maxlength="160"><button id="presetToggle" type="button" aria-label="Choose preset" aria-controls="presetOptions" aria-expanded="false">&#9662;</button></div><div id="presetOptions" role="listbox" aria-label="Presets" hidden></div></div>
<div class="row preset-actions"><button id="save" class="primary">Save</button><button id="saveAs">Create</button><button id="delete">Delete</button><button id="reset">Reset</button></div>
<div class="dimensions"><label>Columns<input id="columns" type="number" min="1" max="9"></label><label>Rows<input id="rows" type="number" min="1" max="9"></label></div>
<div id="preview" aria-label="Initial pane arrangement"></div>
<div id="assignments" aria-label="Selected pane assignments"></div><div class="row"><button id="add">Add tab</button></div>
<p id="error" role="alert" hidden></p><p id="progress" role="status" hidden>Launching…</p>
<script nonce="${nonce}">${browserScript}</script></body></html>`;
}

const browserScript = String.raw`
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
let state, draft, selectedPane = 0, dirty = false, busy = false, menuOpen = false, activeOption = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const send = message => vscode.postMessage(message);
$('destination').value = 'new';
$('checkout').value = 'current';
let checkoutValue = 'current', branchRequestId = 0, validatedBranch = '', branchError = '', branchPending = false;
function displayPath(text) {
  if (!state?.homeDirectory) return text;
  const home = state.homeDirectory.replaceAll('\\', '/').split('/').map(part => part.replace(/[.*+?^$()|{}[\]\\]/g, '\\$&')).join('[\\\\/]');
  return text.replace(new RegExp(home + '(?=$|[\\\\/])', state.windowsPaths ? 'gi' : 'g'), '~');
}
function renderCheckout() {
  const choices = state?.checkouts;
  const selected = checkoutValue;
  const pathKey = path => state.windowsPaths ? path.replaceAll('\\', '/').toLowerCase() : path;
  const current = choices?.entries.find(entry => state.currentPath && pathKey(entry.path) === pathKey(state.currentPath));
  const checkoutName = entry => entry.path.replaceAll('\\', '/').replace(/\/$/, '').split('/').pop() + ' (' + (entry.branch || 'Detached HEAD') + ')';
  $('checkout').replaceChildren(option('current', current ? checkoutName(current) : 'Current checkout'), ...(choices?.nextPath ? [option('new', 'New worktree…')] : []), ...(choices?.entries || []).filter(entry => !current || entry !== current).map(entry => {
    const item = option('existing:' + entry.path, checkoutName(entry));
    item.disabled = !entry.available || !!entry.reserved;
    return item;
  }));
  $('checkout').value = selected;
  $('newCheckout').hidden = selected !== 'new';
  const entry = selected === 'current' ? current : choices?.entries.find(item => 'existing:' + item.path === selected);
  $('checkoutSummary').textContent = displayPath(selected === 'new' ? choices?.nextPath ? choices.nextPath : 'New worktree creation is unavailable. Refresh or choose another checkout.' : entry ? entry.path + (entry.dirty ? ' (modified)' : '') : selected !== 'current' ? 'This checkout is no longer available. Choose another checkout.' : choices?.error || '');
  $('checkoutWarning').hidden = $('destination').value !== 'current' || selected === 'current';
  $('branchError').textContent = displayPath(branchError);
  $('branchError').hidden = !branchError;
  $('branch').setAttribute('aria-invalid', String(!!branchError));
  return selected === 'current' || selected === 'new' && !!choices?.nextPath && !branchPending && !branchError && validatedBranch === $('branch').value.trim() || !!entry && entry.available && !entry.reserved;
}
function checkoutRequest() {
  if (checkoutValue === 'new') return {kind:'new', branch:$('branch').value};
  return checkoutValue === 'current' ? {kind:'current'} : {kind:'existing', path:checkoutValue.slice('existing:'.length)};
}
$('checkout').onchange = () => { checkoutValue = $('checkout').value; render(); };
$('destination').onchange = () => renderCheckout();
$('branch').oninput = () => {
  const branch = $('branch').value.trim();
  branchError = ''; validatedBranch = ''; branchPending = !!branch;
  const requestId = ++branchRequestId;
  if (branch) send({type:'validateBranch', branch, requestId});
  render();
};
const providerName = id => id === '' ? 'Empty terminal' : state.providers.find(provider => provider.id === id)?.displayName || id;
const assignedProviders = pane => pane.providers.length ? pane.providers : [''];
function option(value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
function error(message) { $('error').textContent = displayPath(message); $('error').hidden = !message; }
function presetMenu(open) {
  menuOpen = open;
  $('presetOptions').hidden = !open;
  $('preset').setAttribute('aria-expanded', String(open));
  $('presetToggle').setAttribute('aria-expanded', String(open));
  $('preset').setAttribute('aria-activedescendant', open ? 'preset-option-' + activeOption : '');
  $('presetOptions').replaceChildren(...state.presets.map((preset, index) => {
    const button = document.createElement('button'); button.id = 'preset-option-' + index; button.type = 'button'; button.className = 'preset-option'; button.textContent = preset.name; button.tabIndex = -1; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === activeOption)); button.disabled = busy;
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => { resetDraft(preset); send({type:'preferred',id:preset.id}); $('preset').focus(); };
    return button;
  }));
}
function resetDraft(preset) {
  draft = clone(preset); selectedPane = 0; dirty = false;
  error(''); presetMenu(false); render();
}
function render() {
  if (!state || !draft) return;
  $('preset').value = draft.name;
  $('columns').value = draft.columns; $('rows').value = draft.rows;
  $('preview').style.gridTemplateColumns = 'repeat(' + draft.columns + ', minmax(0, 1fr))';
  $('preview').replaceChildren(...draft.panes.map((pane, index) => {
    const providers = assignedProviders(pane); const button = document.createElement('button'); button.textContent = providers.length ? providers.map(providerName).join('\n') : 'Empty pane'; button.title = 'Pane ' + (index + 1); button.classList.toggle('selected', index === selectedPane); button.onclick = () => { selectedPane = index; render(); }; return button;
  }));
  const count = draft.panes.reduce((total, pane) => total + assignedProviders(pane).length, 0);
  const providers = draft.panes[selectedPane].providers;
  $('assignments').replaceChildren(...(providers.length ? providers : ['']).map((provider, index) => {
    const row = document.createElement('div'); row.className = 'assignment'; const select = document.createElement('select'); select.setAttribute('aria-label', 'Tab ' + (index + 1) + ' provider'); select.replaceChildren(option('', 'Empty'), ...state.providers.map(item => option(item.id, item.displayName))); select.value = provider; select.onchange = () => { draft.panes[selectedPane].providers[index] = select.value; dirty = true; render(); }; row.append(select);
    if (index > 0) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove tab ' + (index + 1));
      remove.onclick = () => { draft.panes[selectedPane].providers.splice(index, 1); dirty = true; render(); };
      row.append(remove);
    }
    return row;
  }));
  document.querySelectorAll('button,input,select').forEach(element => element.disabled = busy);
  const checkoutValid = renderCheckout();
  $('launch').disabled = !checkoutValid || busy || count === 0 || (checkoutValue === 'new' && !$('branch').value.trim());
  $('save').disabled = busy;
  $('saveAs').disabled = busy || !canSaveAs();
  $('progress').hidden = !busy;
}
function setGrid(columns, rows) {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 9) { error('Choose positive Columns and Rows containing at most nine panes.'); render(); return; }
  dirty = true;
  draft.panes = Array.from({length: columns * rows}, (_, index) => draft.panes[index] || {providers: []}); draft.columns = columns; draft.rows = rows; selectedPane = Math.min(selectedPane, draft.panes.length - 1); error(''); render();
}
const canSaveAs = () => !!draft.name.trim() && draft.name.trim() !== state.presets.find(preset => preset.id === draft.id)?.name;
function submit(type, extra = {}) { if (busy) return; error(''); busy = true; const preset = clone(draft); preset.panes.forEach(pane => { pane.providers = assignedProviders(pane); }); send({type, preset, ...extra}); render(); }
$('preset').oninput = () => { draft.name = $('preset').value; dirty = true; presetMenu(false); $('saveAs').disabled = busy || !canSaveAs(); };
$('presetToggle').onmousedown = event => event.preventDefault();
$('presetToggle').onclick = () => { activeOption = Math.max(0, state.presets.findIndex(preset => preset.id === draft.id)); presetMenu(!menuOpen); $('preset').focus(); };
$('preset').onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!menuOpen) activeOption = Math.max(0, state.presets.findIndex(preset => preset.id === draft.id));
    else activeOption = (activeOption + (event.key === 'ArrowDown' ? 1 : -1) + state.presets.length) % state.presets.length;
    presetMenu(true);
  } else if (event.key === 'Enter' && menuOpen) {
    event.preventDefault(); const preset = state.presets[activeOption]; if (preset) { resetDraft(preset); send({type:'preferred',id:preset.id}); }
  } else if (event.key === 'Tab') presetMenu(false);
};
document.addEventListener('click', event => { if (menuOpen && !$('presetCombo').contains(event.target)) presetMenu(false); });
$('columns').onchange = () => setGrid(Number($('columns').value), draft.rows);
$('rows').onchange = () => setGrid(draft.columns, Number($('rows').value));
$('add').onclick = () => { const pane = draft.panes[selectedPane]; const provider = pane.providers.at(-1) || state.providers[0]?.id; if (provider) { if (!pane.providers.length) pane.providers.push(''); pane.providers.push(provider); dirty = true; } render(); };
$('save').onclick = () => submit('save');
$('saveAs').onclick = () => { if (canSaveAs()) submit('saveAs'); };
$('delete').onclick = () => submit('delete',{id:draft.id});
$('reset').onclick = () => resetDraft(state.presets.find(preset => preset.id === draft.id) || state.preferredPreset);
$('run').onclick = () => { if (busy) return; error(''); busy = true; send({type:'run'}); render(); };
$('launch').onclick = () => submit('launch',{destination:$('destination').value,checkout:checkoutRequest()});
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'state') {
    const previous = state; state = message; busy = message.busy;
    if (!draft || (previous && previous.preferredPreset.id !== state.preferredPreset.id)) resetDraft(state.preferredPreset);
    else if (!dirty) { draft = clone(state.presets.find(preset => preset.id === draft.id) || state.preferredPreset); render(); }
    else render();
  } else if (message.type === 'branchValidation') {
    if (message.branch !== $('branch').value.trim() || (message.requestId !== undefined && message.requestId !== branchRequestId)) return;
    validatedBranch = message.branch; branchError = message.error || ''; branchPending = false; render();
  } else if (message.type === 'saved') {
    resetDraft(message.preset);
  } else if (message.type === 'busy') { busy = message.busy; presetMenu(false); render(); }
  else if (message.type === 'error') error(message.message);
});
send({type:'ready'});
window.addEventListener('focus', () => { if (!busy) send({type:'refresh'}); });
`;
