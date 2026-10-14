import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const RECEIPT = "harness-grill-cloud-v1";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const text = (content: any): string => typeof content === "string" ? content : (content ?? []).filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
type Delivery = { delivery_id: string; provider: string; session_id: string; prompt: string; round_id: string };
type Intent = { id: string; hash: string; round: string; attemptedBy?: string };
type Journal = { instance: string; file: string; intents: Intent[] };
type Config = { origin: string; code: string; directory: string; workspace: { name: string; path: string } };

/** One owner per native session, including across reloads. The journal contains no answers or credentials. */
export class GrillRelay {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private owner = randomUUID();
  private lock: string;
  private path: string;
  private journal: Journal;
  private session: string;
  private file: string;
  private reported = false;

  constructor(private pi: any, private ctx: any, private config: Config) {
    this.session = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Cloud answers require a saved Pi session");
    this.file = resolve(file);
    mkdirSync(config.directory, { recursive: true });
    this.path = join(config.directory, `${digest(this.session)}.json`);
    this.lock = `${this.path}.lock`;
    // Serialize dead-process reclamation too: two resumptions must not unlink each other's new lock.
    let fd: number;
    try { fd = openSync(this.lock, "wx"); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const reclaim = `${this.lock}.reclaim`;
      const reclaimFd = openSync(reclaim, "wx");
      try {
        const held = JSON.parse(readFileSync(this.lock, "utf8"));
        if (!Number.isSafeInteger(held.pid) || held.pid <= 0) throw new Error("Invalid Pi relay lock");
        try { process.kill(held.pid, 0); throw new Error("Another Pi process owns this interview relay"); }
        catch (heldError: any) { if (heldError.code !== "ESRCH") throw heldError; }
        unlinkSync(this.lock);
        fd = openSync(this.lock, "wx");
      } finally { closeSync(reclaimFd); unlinkSync(reclaim); }
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: this.owner })); }
    finally { closeSync(fd); }
    try {
      this.journal = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { instance: `pi:${randomUUID()}`, file: this.file, intents: [] };
      if (this.journal.file !== this.file || !Array.isArray(this.journal.intents)) throw new Error("Pi session file does not match its cloud relay journal");
      this.save();
    } catch (error) { this.release(); throw error; }
  }

  private save() {
    const temporary = `${this.path}.${this.owner}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.journal), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private release() {
    try { if (JSON.parse(readFileSync(this.lock, "utf8")).owner === this.owner) unlinkSync(this.lock); } catch { }
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.release();
  }

  wake() {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    void this.tick();
  }

  private activeRound(): string | undefined {
    const entries = this.ctx.sessionManager.getBranch();
    return entries.filter((entry: any) => entry.type === "custom" && entry.customType === RECEIPT && entry.data?.phase === "round" && entry.data.sessionId === this.session).at(-1)?.data.roundId;
  }

  private accepted(intent: Intent): any | undefined {
    // message_end extensions run BEFORE appendMessage. Read the exact disk file, not the callback.
    if (!existsSync(this.file)) return;
    const entries = readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (entries[0]?.type !== "session" || entries[0]?.id !== this.session) throw new Error("Pi persisted session identity mismatch");
    const marker = `[harness-grill-delivery:${intent.id}]`;
    return entries.find((entry: any) => entry.type === "message" && entry.message?.role === "user" && text(entry.message.content).startsWith(marker + "\n") && digest(text(entry.message.content)) === intent.hash);
  }

  private async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const round = this.activeRound();
      const accepted = this.journal.intents.flatMap((intent) => {
        const entry = this.accepted(intent);
        if (!entry) return [];
        if (!this.ctx.sessionManager.getEntries().some((item: any) => item.type === "custom" && item.customType === RECEIPT && item.data?.deliveryId === intent.id)) {
          this.pi.appendEntry(RECEIPT, { phase: "delivery", deliveryId: intent.id, userEntryId: entry.id, hash: intent.hash });
        }
        return [{ delivery_id: intent.id, status: "submitted-to-terminal" }];
      });
      const response = await fetch(`${this.config.origin}/api/v1/pi/sync`, {
        method: "POST", headers: { Authorization: `Bearer ${this.config.code}`, "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: this.journal.instance, workspace: this.config.workspace,
          sessions: round ? [{ provider: "pi", session_id: this.session, active_round_id: round, accepting: this.ctx.isIdle() }] : [],
          acknowledgements: accepted }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`Pi relay HTTP ${response.status}`);
      const result = await response.json() as { deliveries: Delivery[] };
      if (!Array.isArray(result.deliveries)) throw new Error("Pi relay protocol mismatch");
      if (this.stopped) return;
      this.journal.intents = this.journal.intents.filter((intent) => !accepted.some((ack) => ack.delivery_id === intent.id));
      this.save();
      for (const delivery of result.deliveries) {
        if (this.stopped || !this.ctx.isIdle()) break;
        if (delivery.provider !== "pi" || delivery.session_id !== this.session || delivery.round_id !== this.activeRound() || !/^[0-9a-f-]{36}$/.test(delivery.delivery_id) || typeof delivery.prompt !== "string" || !delivery.prompt.trim()) throw new Error("Pi relay delivery binding mismatch");
        const message = `[harness-grill-delivery:${delivery.delivery_id}]\n${delivery.prompt}`;
        let intent = this.journal.intents.find((item) => item.id === delivery.delivery_id);
        if (intent && intent.hash !== digest(message)) throw new Error("Pi delivery content changed");
        if (intent && (this.accepted(intent) || intent.attemptedBy === this.owner)) continue;
        // An in-memory user message awaiting disk persistence is already accepted; never queue it twice.
        if (this.ctx.sessionManager.getEntries().some((entry: any) => entry.type === "message" && entry.message?.role === "user" && digest(text(entry.message.content)) === digest(message))) continue;
        if (!intent) { intent = { id: delivery.delivery_id, hash: digest(message), round: delivery.round_id }; this.journal.intents.push(intent); }
        intent.attemptedBy = this.owner;
        this.save();
        this.pi.sendUserMessage(message, { deliverAs: "followUp", expandPromptTemplates: false });
        // Pi's asynchronous input preflight may not mark the session busy before this void call returns.
        break;
      }
      this.reported = false;
    } catch {
      if (!this.stopped && !this.reported) {
        this.reported = true;
        this.pi.sendMessage({ customType: "harness-grill-relay-status", content: "Cloud answer relay is disconnected. Answers remain on the board; reconnect or copy the reviewed prompt.", display: true }, { triggerTurn: false });
      }
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, 2_000);
    }
  }
}
