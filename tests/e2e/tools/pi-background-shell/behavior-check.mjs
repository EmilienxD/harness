import { install, JobPanel, clean, openJobPanel, getKeybindings, ScrollView, TuiAltScreen, VStack, visibleWidth } from "./behavior-runtime.mjs";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 6e3;
  while (!await check()) {
    if (Date.now() >= end) throw new Error("Behavior deadline exceeded");
    await pause(20);
  }
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "harness-bg-behavior-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const tools = new Map(), handlers = new Map(), commands = new Map(), renderers = new Map();
  const sent = [], deliveries = [];
  let failures = 0;
  const ctx = {
    cwd: root,
    mode: "rpc",
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "behavior-test", getSessionFile: () => void 0 }
  };
  install({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command2) => commands.set(name, command2),
    registerMessageRenderer: (name, renderer) => renderers.set(name, renderer),
    sendMessage: (message, options) => {
      if (failures-- > 0) throw new Error("Injected delivery failure");
      sent.push(message);
      deliveries.push(options);
    }
  });
  const call = async (tool, args) => tools.get(tool).execute("test", args, void 0, void 0, ctx);
  try {
    await handlers.get("session_start")({}, ctx);
    await run({ root, tools, handlers, commands, renderers, sent, deliveries, call, ctx, fail: (count) => {
      failures = count;
    } });
  } finally {
    await handlers.get("session_shutdown")();
    if (previous === void 0) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
const shell = process.platform === "win32" ? "powershell" : "bash";
const command = (delay) => shell === "powershell" ? `Start-Sleep -Milliseconds ${delay}; Write-Output 'final-output'` : `sleep ${delay / 1e3}; printf final-output`;
test("split tools require IDs and optional output preserves status", async () => {
  await fixture(async (f) => {
    assert.equal(f.tools.has("shell_job"), false);
    const statusTool = f.tools.get("get_background_shell_status");
    const cancelTool = f.tools.get("cancel_background_shell");
    assert.deepEqual(statusTool.parameters.required, ["id"]);
    assert.deepEqual(cancelTool.parameters.required, ["id"]);
    assert.equal(statusTool.parameters.properties.show_output.type, "boolean");
    assert.equal(statusTool.parameters.properties.action, undefined);
    assert.deepEqual(Object.keys(cancelTool.parameters.properties), ["id"]);
    for (const tool of [statusTool.name, cancelTool.name]) {
      await assert.rejects(f.call(tool, { id: "missing" }), /Unknown background command ID/);
    }
    const receipt = (await f.call(shell, { command: command(100), run_in_background: true })).details;
    assert.match(receipt.id, /^[0-9a-f]{6}$/);
    await until(() => f.sent.length === 1);
    for (const args of [{ id: receipt.id }, { id: receipt.id, show_output: false }, { id: receipt.id, show_output: true }]) {
      const value = await f.call(statusTool.name, args);
      assert.equal(value.details.state, "completed");
      assert.equal(value.details.exit_code, 0);
      assert.equal(value.structuredContent, value.details);
      if (args.show_output) assert.match(value.details.output, /final-output/);
      else assert.equal(Object.hasOwn(value.details, "output"), false);
    }
    const cancelled = (await f.call(cancelTool.name, { id: receipt.id })).details;
    assert.equal(cancelled.state, "completed");
    await f.handlers.get("session_tree")();
    await assert.rejects(f.call(statusTool.name, { id: receipt.id }), /Unknown background command ID/);
  });
});
test("user turns get only a live running count, excluding foreground and completed jobs", async () => {
  await fixture(async (f) => {
    const remind = (messageType = "user") => f.handlers.get("before_agent_start")({ messageType });
    assert.equal(remind(), undefined);
    await mkdir(join(f.root, "agent"), { recursive: true });
    await writeFile(join(f.root, "agent", "settings.json"), JSON.stringify({ backgroundShell: { foregroundTimeout: 5 } }));
    const foreground = f.call(shell, { command: command(300) });
    assert.equal(remind(), undefined);
    await foreground;
    const first = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
    const second = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
    assert.notEqual(first.id, second.id);
    const reminder = remind().message;
    assert.equal(reminder.customType, "harness-background-shell-reminder");
    assert.equal(reminder.display, false);
    assert.deepEqual(reminder.details, { running_count: 2 });
    assert.equal(remind("custom"), undefined);
    await f.call("cancel_background_shell", { id: first.id });
    assert.deepEqual(remind().message.details, { running_count: 1 });
    await f.call("cancel_background_shell", { id: second.id });
    assert.equal(remind(), undefined);
    await f.handlers.get("session_tree")();
    assert.equal(remind(), undefined);
  });
});
test("TUI running-count widget uses dim styling and clears after the last job stops", async () => {
  await fixture(async (f) => {
    const widgets = [], styles = [];
    f.ctx.mode = "tui";
    f.ctx.ui = {
      theme: { fg: (color, text) => {
        styles.push(color);
        return `\x1b[90m${text}\x1b[39m`;
      } },
      setWidget: (id, lines) => widgets.push({ id, lines }),
    };
    await f.handlers.get("session_start")({}, f.ctx);
    const first = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
    const second = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
    assert.deepEqual(styles, ["dim", "dim"]);
    assert.ok(widgets.at(-1).lines.every(line => line.startsWith("\x1b[90m") && line.endsWith("\x1b[39m")));
    await f.call("cancel_background_shell", { id: first.id });
    assert.deepEqual(styles, ["dim", "dim", "dim"]);
    await f.call("cancel_background_shell", { id: second.id });
    assert.equal(widgets.at(-1).id, "harness-background-shell");
    assert.equal(widgets.at(-1).lines, undefined);
  });
});
test("short IDs retry collisions and are not reused after foreground receipts disappear", async () => {
  await fixture(async (f) => {
    const original = crypto.randomUUID;
    const ids = ["abcdef", "abcdef", "123456", "abcdef", "123456", "789abc"];
    const random = mock.method(crypto, "randomUUID", () => {
      const prefix = ids.shift();
      return prefix ? `${prefix}00-0000-4000-8000-000000000000` : original();
    });
    syncBuiltinESMExports();
    try {
      // Foreground IDs are retained as reserved even though their logs/receipts are removed.
      await f.call(shell, { command: command(10) });
      const first = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
      const second = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
      assert.equal(first.id, "123456");
      assert.equal(second.id, "789abc");
      assert.notEqual(first.log_path, second.log_path);
      await f.call("cancel_background_shell", { id: first.id });
      await f.call("cancel_background_shell", { id: second.id });
    } finally {
      random.mock.restore();
      syncBuiltinESMExports();
    }
  });
});
test("submission without a receipt is not blindly retried; queued messages cannot be consumed", async () => {
  await fixture(async (f) => {
    const receipt = (await f.call(shell, { command: command(100), run_in_background: true })).details;
    await until(() => f.sent.length === 1);
    assert.deepEqual(f.deliveries[0], { deliverAs: "steer", triggerTurn: true });
    // Pi's void API does not expose async success/failure. No receipt is ambiguous.
    for (let i = 0; i < 4; i++) f.handlers.get("agent_settled")();
    await pause(650);
    assert.equal(f.sent.length, 1);
    const status = (await f.call("get_background_shell_status", { id: receipt.id })).details;
    assert.equal(status.notification_state, "submitted");
    assert.equal(status.state, "completed");
    assert.equal(f.sent.length, 1, "Reading status cannot retract Pi's existing queue entry");
    const message = { role: "custom", ...f.sent[0] };
    f.handlers.get("message_end")({ message: { ...message, details: { ...message.details, epoch: -1 } } });
    assert.equal((await f.call("get_background_shell_status", { id: receipt.id })).details.notification_state, "submitted");
    f.handlers.get("message_end")({ message });
    assert.equal((await f.call("get_background_shell_status", { id: receipt.id })).details.notification_state, "delivered");
    f.handlers.get("agent_settled")();
    assert.equal(f.sent.length, 1);
  });
});
test("synchronously rejected submissions are retried and submitted only once", async () => {
  await fixture(async (f) => {
    f.fail(100);
    await f.call(shell, { command: command(100), run_in_background: true, title: "Retry example" });
    await until(() => !f.handlers.get("before_agent_start")({ messageType: "user" }));
    for (let i = 0; i < 4; i++) f.handlers.get("agent_settled")();
    assert.equal(f.sent.length, 0);
    f.fail(0);
    f.handlers.get("agent_settled")();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].details.jobs[0].title, "Retry example");
    f.handlers.get("agent_settled")();
    assert.equal(f.sent.length, 1);
  });
});
test("timeout is a hard limit; the configured foreground limit alone decides handoff", async () => {
  await fixture(async (f) => {
    await mkdir(join(f.root, "agent"), { recursive: true });
    await writeFile(join(f.root, "agent", "settings.json"), JSON.stringify({ backgroundShell: { foregroundTimeout: 0.5 } }));
    const schema = f.tools.get(shell).parameters.properties;
    assert.ok(schema.timeout);
    assert.equal(schema.execution_timeout, undefined);
    await assert.rejects(f.call(shell, { command: command(5e3), timeout: 0.2 }), /deadline/);
    assert.equal(f.handlers.get("before_agent_start")({ messageType: "user" }), undefined);
    const moved = (await f.call(shell, { command: command(5e3), timeout: 1.5 })).details;
    assert.equal(moved.state, "running");
    assert.match(moved.notification, /0\.5 seconds/);
    await until(async () => (await f.call("get_background_shell_status", { id: moved.id })).details.state === "timed_out");
    const plain = (await f.call(shell, { command: command(900) })).details;
    assert.equal(plain.state, "running");
    await until(async () => (await f.call("get_background_shell_status", { id: plain.id })).details.state === "completed");
  });
});
test("completion keeps output for the agent but renders only exit status, even expanded", async () => {
  await fixture(async (f) => {
    await f.call(shell, { command: command(100), run_in_background: true, title: "Status example" });
    await until(() => f.sent.length === 1);
    const message = f.sent[0];
    assert.equal(message.display, true);
    const data = JSON.parse(message.content);
    assert.equal(data.type, "shell_job_completion");
    assert.match(data.jobs[0].output, /final-output/);
    const renderer = f.renderers.get(message.customType);
    const theme = { fg: (_, text) => text };
    for (const expanded of [false, true]) {
      assert.deepEqual(renderer(message, { expanded }, theme).render(200).map(line => line.trimEnd()), [
        "Background command `Status example` exited with status 0."
      ]);
      const jobs = [
        { ...message.details.jobs[0], title: "Failed\x1b[2J\njob", state: "failed", exit_code: 7 },
        { ...message.details.jobs[0], title: "Timed `out`", state: "timed_out", exit_code: null },
      ];
      assert.deepEqual(renderer({ ...message, details: { jobs } }, { expanded }, theme).render(200).map(line => line.trimEnd()), [
        "Background command `Failed job` exited with status 7.",
        "Background command `Timed 'out'` exited with status unknown.",
      ]);
    }
  });
});
test("reading a completed result consumes its undelivered notification", async () => {
  await fixture(async (f) => {
    f.fail(100);
    const receipt = (await f.call(shell, { command: command(100), run_in_background: true })).details;
    let final;
    for (let i = 0; i < 100; i++) {
      final = (await f.call("get_background_shell_status", { show_output: true, id: receipt.id })).details;
      if (final.state !== "running") break;
      await pause(30);
    }
    assert.equal(final.state, "completed");
    assert.equal(final.notification_state, "consumed");
    assert.match(final.output, /final-output/);
    f.fail(0);
    f.handlers.get("agent_settled")();
    await pause(150);
    assert.equal(f.sent.length, 0);
  });
});
test("tool cancellation returns the final state without an automatic duplicate", async () => {
  await fixture(async (f) => {
    const receipt = (await f.call(shell, { command: command(1e4), run_in_background: true })).details;
    const cancelled = (await f.call("cancel_background_shell", { id: receipt.id })).details;
    assert.equal(cancelled.state, "cancelled");
    await pause(200);
    assert.equal(f.sent.length, 0);
  });
});
test("cancellation reaps a descendant holding inherited output pipes", async () => {
  await fixture(async (f) => {
    await writeFile(join(f.root, "worker.cjs"), `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', "setTimeout(() => require('node:fs').writeFileSync('orphan.txt', 'alive'), 1800)"],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      fs.writeFileSync('child-started.txt', String(child.pid));
      console.log('parent started');
      setTimeout(() => {}, 10000);
    `);
    const quote = (s) => `'${s.replaceAll("'", "''")}'`;
    const receipt = (await f.call(shell, { command: `${shell === "powershell" ? "& " : ""}${quote(process.execPath)} worker.cjs`, run_in_background: true })).details;
    await until(() => existsSync(join(f.root, "child-started.txt")));
    const start = Date.now();
    const result = (await f.call("cancel_background_shell", { id: receipt.id })).details;
    assert.equal(result.state, "cancelled");
    assert.ok(Date.now() - start < 3e3, "Inherited pipes must not hang cancellation");
    await pause(2200);
    assert.equal(existsSync(join(f.root, "orphan.txt")), false);
    assert.equal(f.sent.length, 0);
  });
});
test("viewer sanitizes output, fits narrow terminals, and releases subscriptions", async () => {
  const jobs = [{
    id: "bg-example",
    title: "\u96EA\njob",
    command: "demo",
    state: "running",
    shell,
    elapsed_seconds: 1,
    exit_code: null,
    log_path: "unused",
    log_truncated: false,
    output: "\x1B[2Junsafe\0\n\u96EA"
  }];
  let unsubscribed = 0, stopped = 0, closed = 0;
  const panel = new JobPanel(
    {
      list: () => jobs,
      cancel: async () => {
        stopped++;
        jobs[0].state = "cancelled";
      },
      subscribe: () => () => {
        unsubscribed++;
      }
    },
    { terminal: { rows: 30 }, requestRender() {
    } },
    { fg: (_, text) => text, bold: (text) => text },
    { matches: (data, binding) => data === { "tui.select.cancel": "esc", "tui.select.confirm": "enter" }[binding] },
    () => {
      closed++;
    }
  );
  try {
    assert.equal(clean("\x1B[2Jx\0"), "x");
    panel.handleInput("enter");
    for (const width of [1, 12, 40, 80]) assert.ok(panel.render(width).every((line) => visibleWidth(line) <= width));
    panel.handleInput("x");
    await pause(10);
    assert.equal(stopped, 1);
    panel.handleInput("esc");
    panel.handleInput("esc");
    assert.equal(closed, 1);
    assert.equal(unsubscribed, 1);
    panel.dispose();
    assert.equal(unsubscribed, 1);
  } finally {
    panel.dispose();
  }
});
test("/ps hides input behind one separator, caps and scrolls output, and restores the editor", () => {
  let widget, listener;
  const previousEditor = () => {
  };
  let editorFactory = previousEditor;
  let inputSubscriptions = 0, outputSubscriptions = 0;
  const terminal = { rows: 40 };
  const job = {
    id: "bg-layout",
    title: "Layout test",
    command: "demo",
    state: "running",
    shell,
    elapsed_seconds: 1,
    exit_code: null,
    log_path: "unused",
    log_truncated: false,
    output: Array.from({ length: 80 }, (_, i) => `line-${i}: ` + "abcdefghij".repeat(6)).join("\n")
  };
  const close = openJobPanel({
    list: () => [job],
    cancel: async () => {
    },
    subscribe: () => {
      outputSubscriptions++;
      return () => {
        outputSubscriptions--;
      };
    }
  }, {
    getEditorComponent: () => editorFactory,
    theme: { fg: (_, text) => text, bold: (text) => text },
    setEditorComponent: (factory) => {
      editorFactory = factory;
      widget = factory === previousEditor ? void 0 : factory({ terminal, requestRender() {
      } }, { borderColor: (text) => text }, getKeybindings());
    },
    onTerminalInput: (handler) => {
      listener = handler;
      inputSubscriptions++;
      return () => {
        listener = void 0;
        inputSubscriptions--;
      };
    }
  });
  try {
    assert.notEqual(editorFactory, previousEditor);
    const hiddenEditor = widget;
    hiddenEditor.setText("unfinished draft");
    const editorLines = hiddenEditor.render(32);
    assert.equal(editorLines[0], "\u2500".repeat(32));
    assert.equal(editorLines[1], "Background shell", "Heading immediately follows the separator in the same editor component");
    assert.equal(hiddenEditor.getText(), "unfinished draft", "Hiding input preserves its text");
    assert.equal(listener("\r").consume, true);
    const bottom = widget.render(32).slice(1, -1);
    assert.ok(bottom.length <= 18, "40-row terminal allows at most 45% for the panel");
    assert.ok(bottom.some((line) => line.includes("line-79")), "Enter opens the selected command output");
    assert.ok(bottom.every((line) => visibleWidth(line) <= 32));
    assert.equal(widget.render(32).at(-1), "─".repeat(32), "A full-width bar closes the panel above the status line");
    assert.equal(bottom.at(-2), "", "One empty line separates the info from the keyboard help");
    assert.ok(bottom.at(-1).startsWith("↑/↓ scroll"));
    assert.equal(listener("\x1B[A").consume, true);
    assert.notDeepEqual(widget.render(32).slice(1, -1), bottom, "Up scrolls into earlier output");
    assert.equal(listener("	").consume, true);
    assert.equal(listener("\x1B[9;1:3u").consume, true);
    assert.equal(listener("typing in prompt").consume, true, "Tab cannot return typing to the hidden editor");
    assert.equal(listener("	").consume, true);
    assert.equal(listener("j").consume, true);
    terminal.rows = 12;
    assert.ok(widget.render(32).length <= 7, "Resizing recomputes the height cap");
    terminal.rows = 100;
    assert.ok(widget.render(32).length <= 22, "Tall terminals keep the absolute height cap");
    close();
    assert.equal(widget, void 0);
    assert.equal(editorFactory, previousEditor, "Closing restores the original editor factory");
    assert.equal(inputSubscriptions, 0);
    assert.equal(outputSubscriptions, 0);
    close();
  } finally {
    close();
  }
});
test("/ps starts with a scrolling command selector and Enter opens the chosen job", () => {
  const jobs = Array.from({ length: 25 }, (_, i) => ({
    id: `bg-job-${i}`,
    title: `Job ${i}`,
    command: `command-${i}`,
    state: "running",
    shell,
    elapsed_seconds: 1,
    exit_code: null,
    log_path: "unused",
    log_truncated: false,
    output: `OUTPUT-${i}`
  }));
  const panel = new JobPanel(
    { list: () => jobs, cancel: async () => {
    }, subscribe: () => () => {
    } },
    { terminal: { rows: 30 }, requestRender() {
    } },
    { fg: (_, text) => text, bold: (text) => text },
    { matches: (data, binding) => data === { "tui.select.cancel": "esc", "tui.select.confirm": "enter", "tui.select.down": "down", "tui.select.up": "up" }[binding] },
    () => {
    }
  );
  try {
    const initial = panel.render(100);
    assert.ok(initial.some((line) => line.includes("Job 0")));
    assert.ok(initial.some((line) => line.includes("Job 1")), "Multiple running commands appear in the selector");
    assert.ok(!initial.some((line) => line.includes("OUTPUT-")), "Opening the panel keeps the selector visible");
    for (let i = 0; i < 24; i++) panel.handleInput("down");
    assert.ok(panel.render(100).some((line) => line.includes("Job 24")), "Selection scrolls beyond the visible list");
    panel.handleInput("enter");
    assert.ok(panel.render(100).some((line) => line.includes("OUTPUT-24")));
    panel.handleInput("esc");
    assert.ok(panel.render(100).some((line) => line.includes("Job 24")), "Escape returns to the same selection");
    panel.handleInput("up");
    panel.handleInput("enter");
    assert.ok(panel.render(100).some((line) => line.includes("OUTPUT-23")), "Another command can be selected");
  } finally {
    panel.dispose();
  }
});
test("arrow press/release pairs move one row; release never navigates or closes the panel", () => {
  const jobs = Array.from({ length: 5 }, (_, i) => ({
    id: `bg-key-${i}`,
    title: `Key job ${i}`,
    command: `command-${i}`,
    state: "running",
    shell,
    elapsed_seconds: 1,
    exit_code: null,
    log_path: "unused",
    log_truncated: false,
    output: Array.from({ length: 30 }, (_2, n) => `output-${i}-${n}`).join("\n")
  }));
  let closed = false;
  const panel = new JobPanel(
    { list: () => jobs, cancel: async () => {
    }, subscribe: () => () => {
    } },
    { terminal: { rows: 30 }, requestRender() {
    } },
    { fg: (_, text) => text, bold: (text) => text },
    getKeybindings(),
    () => {
      closed = true;
    }
  );
  const selected = () => panel.render(100).find((line) => line.startsWith("\u276F"));
  try {
    panel.handleInput("\x1B[1;1:1B");
    panel.handleInput("\x1B[1;1:3B");
    assert.ok(selected()?.includes("Key job 1"));
    panel.handleInput("\x1B[1;1:1A");
    panel.handleInput("\x1B[1;1:3A");
    assert.ok(selected()?.includes("Key job 0"));
    panel.handleInput("\x1B[B");
    panel.handleInput("\x1B[B");
    assert.ok(selected()?.includes("Key job 2"), "Two actual presses still move two rows");
    panel.handleInput("\r");
    const bottom = panel.render(100);
    panel.handleInput("\x1B[1;1:1A");
    panel.handleInput("\x1B[1;1:3A");
    const scrolled = panel.render(100);
    const output = (lines) => lines.filter((line) => line.startsWith("output-"));
    assert.deepEqual(output(scrolled).slice(1), output(bottom).slice(0, -1), "Output scrolls exactly one line");
    panel.handleInput("\x1B[27;1:1u");
    panel.handleInput("\x1B[27;1:3u");
    assert.equal(closed, false, "Escape release must not close the selector after returning from output");
    assert.ok(selected()?.includes("Key job 2"));
  } finally {
    panel.dispose();
  }
});
test("all terminal states stay visible until /ps closes and disappear from the reopened selector", async () => {
  const jobs = ["running", "running", "completed", "failed", "timed_out", "cancelled", "running", "running", "running"].map((state, i) => ({
    id: `bg-retained-${i}`,
    title: `Retained job ${i}`,
    command: `command-${i}`,
    state,
    shell,
    elapsed_seconds: 1,
    exit_code: null,
    log_path: "unused",
    log_truncated: false,
    output: `output-${i}`
  }));
  const source = { list: () => jobs, cancel: async (id) => {
    jobs.find((job) => job.id === id).state = "cancelled";
  }, subscribe: () => () => {
  } };
  const create = () => new JobPanel(
    source,
    { terminal: { rows: 30 }, requestRender() {
    } },
    { fg: (_, text) => text, bold: (text) => text },
    getKeybindings(),
    () => {
    }
  );
  let panel = create();
  try {
    panel.handleInput("x");
    await pause(10);
    assert.equal(jobs[0].state, "cancelled");
    assert.ok(!panel.render(100).some((line) => line.includes("Retained job 2")), "A job that finished before /ps opened is not listed");
    for (const i of [2, 3, 4, 5]) {
      assert.ok(!panel.render(100).some((line) => line.includes(`Retained job ${i}`)), "Jobs already finished when /ps opens are not listed");
    }
    for (const [i, state] of [[1, "completed"], [6, "failed"], [7, "timed_out"]]) {
      jobs[i].state = state;
      assert.ok(panel.render(100).some((line) => line.includes(`Retained job ${i} · ${state}`)), "Jobs finishing while the menu is open remain inspectable");
    }
    assert.ok(panel.render(100).some((line) => line.includes("Retained job 0")), "Cancelling does not remove the row while the menu is open");
    panel.dispose();
    panel = create();
    const reopened = panel.render(100);
    assert.ok(!reopened.some((line) => line.includes("Retained job 0")));
    assert.ok(!reopened.some((line) => line.includes("Retained job 1")), "Completed jobs disappear on reopening");
    assert.ok(!reopened.some((line) => line.includes("Retained job 2")));
    for (const i of [3, 4, 5, 6, 7]) assert.ok(!reopened.some((line) => line.includes(`Retained job ${i}`)), "Every terminal state disappears on reopening");
    assert.ok(reopened.some((line) => line.includes("Retained job 8")), "Running jobs remain selectable");
    assert.equal(source.list().length, 9, "Filtering the selector preserves job records and logs");
  } finally {
    panel.dispose();
  }
});
test("native fullscreen routing sends Page Up/Down and shell wheel events to output, then restores chat paging", () => {
  let input = () => {
  };
  const terminal = {
    columns: 100,
    rows: 40,
    kittyProtocolActive: false,
    start: (handler) => {
      input = handler;
    },
    stop() {
    },
    write() {
    },
    hideCursor() {
    },
    showCursor() {
    },
    moveBy() {
    },
    clearLine() {
    },
    clearFromCursor() {
    },
    clearScreen() {
    },
    setTitle() {
    },
    setProgress() {
    },
    setProgramStatus() {
    }
  };
  const tui = new TuiAltScreen(terminal);
  const chat = new ScrollView({ render: () => Array.from({ length: 200 }, (_, i) => `chat-${i}`), invalidate() {
  } }, { primary: true, follow: "end" });
  let editor;
  const previous = () => ({ render: () => ["prompt"], invalidate() {
  } });
  let editorFactory = previous;
  const theme = { fg: (_, text) => text, bold: (text) => text };
  const setEditor = (factory) => {
    editorFactory = factory;
    editor = factory(tui, { borderColor: (text) => text }, getKeybindings());
    tui.setLayoutRoot(new VStack([{ component: chat, basis: 0, grow: 1, minSize: 1 }, { component: editor, basis: "auto", minSize: 3 }]));
  };
  setEditor(previous);
  tui.start();
  let close;
  try {
    close = openJobPanel({ list: () => [{
      id: "bg-fullscreen",
      title: "Fullscreen",
      command: "demo",
      shell,
      state: "running",
      elapsed_seconds: 1,
      exit_code: null,
      log_path: "unused",
      log_truncated: false,
      output: Array.from({ length: 200 }, (_, i) => `shell-${i}`).join("\n")
    }], cancel: async () => {
    }, subscribe: () => () => {
    } }, {
      theme,
      getEditorComponent: () => editorFactory,
      setEditorComponent: setEditor,
      onTerminalInput: (handler) => tui.addInputListener(handler)
    });
    input("\r");
    tui.renderNow(true);
    const bottom = editor.render(100);
    const chatTop = chat.scrollTop;
    input("\x1B[5~");
    tui.renderNow(true);
    assert.notDeepEqual(editor.render(100), bottom, "Page Up scrolls shell output through native input routing");
    assert.equal(chat.scrollTop, chatTop, "Page Up leaves the chat fixed");
    input("\x1B[6~");
    tui.renderNow(true);
    assert.deepEqual(editor.render(100), bottom, "Page Down returns to the output bottom");
    input("\x1B[<64;10;36M");
    tui.renderNow(true);
    assert.notDeepEqual(editor.render(100), bottom, "Wheel over shell output scrolls that output");
    assert.equal(chat.scrollTop, chatTop, "Shell wheel does not scroll the chat");
    input("\x1B[<65;10;36M");
    tui.renderNow(true);
    assert.deepEqual(editor.render(100), bottom);
    input("\x1B[<65;10;36M");
    tui.renderNow(true);
    assert.equal(chat.scrollTop, chatTop, "Wheel at the shell boundary does not spill into chat");
    close();
    tui.renderNow(true);
    const restoredTop = chat.scrollTop;
    input("\x1B[5~");
    tui.renderNow(true);
    assert.ok(chat.scrollTop < restoredTop, "Closing /ps restores native chat paging");
  } finally {
    close?.();
    tui.stop();
  }
});
test("x in shell output returns to the selector immediately and long commands wrap to three rows", async () => {
  const job = {
    id: "bg-command",
    title: "Long command",
    command: "word ".repeat(100),
    shell,
    state: "running",
    elapsed_seconds: 1,
    exit_code: null,
    log_path: "unused",
    log_truncated: false,
    output: "SHELL-OUTPUT"
  };
  let finish;
  let cancellations = 0;
  const panel = new JobPanel(
    { list: () => [job], cancel: async () => {
      cancellations++;
      await new Promise((resolve) => {
        finish = resolve;
      });
      job.state = "cancelled";
    }, subscribe: () => () => {
    } },
    { terminal: { rows: 40 }, requestRender() {
    } },
    { fg: (_, text) => text, bold: (text) => text },
    getKeybindings(),
    () => {
    }
  );
  try {
    panel.handleInput("\r");
    const output = panel.render(32);
    const start = output.findIndex((line) => line.startsWith(`${shell}:`));
    const end = output.indexOf("SHELL-OUTPUT");
    assert.equal(end - start, 3, "Command uses three wrapped rows before shell output");
    assert.ok(output[end - 1].endsWith("\u2026"), "Only the third command row carries truncation");
    assert.ok(output.every((line) => visibleWidth(line) <= 32));
    assert.ok(output.length <= 18, "Command wrapping respects the panel height cap");
    panel.handleInput("x");
    assert.equal(cancellations, 1);
    assert.ok(!panel.render(80).includes("SHELL-OUTPUT"), "Selector is shown before cancellation finishes");
    assert.ok(panel.render(80).some((line) => line.includes("Long command")));
    finish();
    await pause(10);
    assert.equal(job.state, "cancelled");
    panel.handleInput("\r");
    panel.handleInput("x");
    assert.ok(!panel.render(80).includes("SHELL-OUTPUT"), "x also returns from an already stopped shell");
    assert.equal(cancellations, 1);
  } finally {
    finish?.();
    panel.dispose();
  }
});
