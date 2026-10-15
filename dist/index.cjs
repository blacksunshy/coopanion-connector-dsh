"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  AgentRegistry: () => AgentRegistry,
  PET_PATH: () => PET_PATH,
  PROTOCOL_VERSION: () => PROTOCOL_VERSION,
  PetHub: () => PetHub,
  assistantText: () => assistantText,
  default: () => plugin_default,
  noticeOf: () => noticeOf,
  parsePetFrame: () => parsePetFrame,
  reasonText: () => reasonText
});
module.exports = __toCommonJS(index_exports);

// src/plugin.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");

// src/pet-hub.ts
var import_ws = require("ws");

// src/protocol.ts
function parsePetFrame(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value;
  switch (frame.t) {
    case "hello":
      if (typeof frame.v !== "number" || typeof frame.name !== "string") return null;
      return { t: "hello", v: frame.v, name: frame.name.slice(0, 64) };
    case "say": {
      if (typeof frame.id !== "string" || typeof frame.text !== "string") return null;
      const from = typeof frame.from === "string" && frame.from.trim() ? frame.from : "the pet";
      return { t: "say", id: frame.id.slice(0, 64), text: frame.text, from: from.slice(0, 64) };
    }
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}
var SAY_MAX = 4e3;
var REPLY_MAX = 2e3;
var BRIDGE_PREFIX = /^[\p{L}\p{N}_\- ]{1,64}（通过桌宠）说：/u;
function carriesBridgePrefix(text) {
  return BRIDGE_PREFIX.test(text.trim());
}
function assistantText(message) {
  if (typeof message !== "object" || message === null) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text.trim());
  }
  if (parts.length === 0) return null;
  const text = parts.join("\n\n");
  return text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}\u2026` : text;
}
function argumentNames(args) {
  if (typeof args !== "string") return "";
  let value;
  try {
    value = JSON.parse(args);
  } catch {
    return "";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  return Object.keys(value).slice(0, 8).join(", ");
}
function reasonText(reason2) {
  if (typeof reason2 === "string") return reason2;
  if (typeof reason2 !== "object" || reason2 === null) return "completed";
  const r = reason2;
  const kind = typeof r.kind === "string" ? r.kind : "completed";
  if (typeof r.message === "string" && r.message) return `${kind}: ${r.message}`;
  if (typeof r.reason === "string" && r.reason) return `${kind}: ${r.reason}`;
  if (typeof r.reason === "object" && r.reason !== null && typeof r.reason.reason === "string") {
    return `${kind}: ${r.reason.reason}`;
  }
  return kind;
}

// src/pet-hub.ts
var PET_PATH = "/coopanion/pet";
var PROTOCOL_VERSION = 1;
var IDLE_PING_MS = 3e4;
var PetHub = class {
  constructor(opts) {
    this.opts = opts;
    this.ownsServer = opts.server === void 0;
    this.wss = opts.server ?? new import_ws.WebSocketServer({ noServer: true });
    this.timer = setInterval(() => this.ping(), IDLE_PING_MS);
    this.timer.unref?.();
  }
  opts;
  wss;
  ownsServer;
  connection = null;
  timer;
  get connected() {
    return this.connection !== null && this.connection.readyState === this.connection.OPEN;
  }
  /** The upgrade route `webServer.registerUpgrade` takes. */
  upgrade = (req, socket, head) => {
    if (!this.opts.welcome()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  };
  /** A notice to the pet; false when nobody is listening. */
  send(frame) {
    if (!this.connected) return false;
    this.connection.send(JSON.stringify(frame));
    return true;
  }
  close() {
    clearInterval(this.timer);
    try {
      this.connection?.close(1001, "host closing");
    } catch {
    }
    this.connection = null;
    for (const client of this.wss.clients) client.terminate();
    if (this.ownsServer) this.wss.close();
  }
  accept(ws) {
    this.connection?.close(4e3, "replaced");
    this.connection = ws;
    let greeted = false;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parsePetFrame(data.toString());
      if (!frame) return;
      if (!greeted && frame.t !== "hello") {
        ws.close(4001, "hello first");
        return;
      }
      switch (frame.t) {
        case "hello": {
          if (frame.v !== PROTOCOL_VERSION) {
            this.opts.log("warn", `pet speaks protocol ${frame.v}, this Host speaks ${PROTOCOL_VERSION}`);
            ws.close(4002, "protocol mismatch");
            return;
          }
          greeted = true;
          const welcome = this.opts.welcome();
          if (!welcome) {
            ws.close(4003, "no session");
            return;
          }
          this.opts.log("info", `Coopanion pet "${frame.name}" connected`);
          ws.send(JSON.stringify({ t: "ready", v: PROTOCOL_VERSION, ...welcome }));
          return;
        }
        case "say": {
          const text = frame.text.slice(0, SAY_MAX);
          void this.opts.say(text, frame.from).then((refusal) => {
            const ack = refusal === null ? { t: "accepted", id: frame.id } : { t: "refused", id: frame.id, reason: refusal };
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ack));
          });
          return;
        }
        case "ping":
          return;
      }
    });
    ws.on("close", () => {
      if (this.connection === ws) this.connection = null;
    });
    ws.on("error", (err) => this.opts.log("warn", `pet socket error: ${err.message}`));
  }
  ping() {
    if (!this.connected) return;
    try {
      this.connection.ping();
    } catch {
    }
  }
};

// src/session-watch.ts
var AgentRegistry = class {
  live = /* @__PURE__ */ new Map();
  ownerId = null;
  /** Keyed by session id, which is what `agent/created` and `session/disposed` agree on. */
  add(id, agent) {
    this.live.set(id, agent);
    this.ownerId = id;
  }
  remove(id) {
    this.live.delete(id);
    if (this.ownerId === id) this.ownerId = [...this.live.keys()].at(-1) ?? null;
  }
  get owner() {
    return this.ownerId === null ? null : this.live.get(this.ownerId) ?? null;
  }
  get ownerSession() {
    return this.ownerId;
  }
  /** What the pet is told on connect; null when no conversation is open yet. */
  facts() {
    const agent = this.owner;
    if (!agent) return null;
    if (agent.session.parent) return null;
    return {
      session: String(agent.session.id ?? ""),
      cwd: String(agent.session.cwd ?? ""),
      model: this.modelOf(agent)
    };
  }
  modelOf(agent) {
    const model = agent.model;
    if (typeof model === "string") return model;
    const source = agent.source;
    return typeof source?.model === "string" ? source.model : "";
  }
};
function noticeOf(sessionId, event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "turn/start":
      return number(data.turn) === null ? null : { to: sessionId, frame: { t: "turn-start", turn: number(data.turn) } };
    case "turn/end":
      return number(data.turn) === null ? null : { to: sessionId, frame: { t: "turn-end", turn: number(data.turn), reason: reason(data.reason) } };
    default:
      return null;
  }
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function reason(value) {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "completed";
  const kind = value.kind;
  return typeof kind === "string" ? kind : "completed";
}

// src/plugin.ts
var LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/i;
var PLUGIN_NAME = "coopanion-connector-dsh";
function proveLoad() {
  const line = `${JSON.stringify({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    pid: process.pid,
    execPath: process.execPath,
    argv: process.argv.slice(0, 6),
    cwd: process.cwd()
  })}
`;
  for (const file of [
    `${process.env.APPDATA ?? ""}\\@deepseek-ai\\dsh-desktop\\logs\\coopanion-bridge.jsonl`,
    `${process.env.USERPROFILE ?? ""}\\.dsh\\logs\\coopanion-bridge.jsonl`
  ]) {
    try {
      (0, import_node_fs.appendFileSync)(file, line);
    } catch {
    }
  }
}
var LLM_MODULE = "@deepseek-ai/dsh-llm";
var factory;
async function resolveFactory() {
  if (factory !== void 0) return factory;
  try {
    const mod = await import(LLM_MODULE);
    factory = typeof mod.createUserMessage === "function" ? mod.createUserMessage : null;
  } catch {
    factory = null;
  }
  return factory;
}
function withOwnId(message) {
  const id = message?.id;
  if (typeof id === "string" && id !== "") return message;
  return { ...message, id: (0, import_node_crypto.randomUUID)() };
}
function buildUserMessage(text, template, factoryOverride = factory ?? null) {
  if (factoryOverride) {
    try {
      return withOwnId(factoryOverride({ content: [{ type: "text", text }], source: { kind: "user" } }));
    } catch {
    }
  }
  if (template && typeof template === "object") {
    const base = template;
    return { ...base, id: (0, import_node_crypto.randomUUID)(), content: [{ type: "text", text }] };
  }
  return { id: (0, import_node_crypto.randomUUID)(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}
var plugin_default = {
  name: PLUGIN_NAME,
  apply(root) {
    proveLoad();
    const agents = new AgentRegistry();
    let hub = null;
    const pending = [];
    let userTemplate = null;
    const log = (level, text) => {
      try {
        if (level === "warn") root.logger?.warn(`[${PLUGIN_NAME}] ${text}`);
        else root.logger?.info(`[${PLUGIN_NAME}] ${text}`);
      } catch {
      }
    };
    const notify = (frame) => {
      hub?.send(frame);
    };
    root.inject(["webServer"], (scoped) => {
      const pet = new PetHub({
        welcome: () => {
          const facts = agents.facts();
          if (!facts) return null;
          return facts;
        },
        say: async (text, from) => {
          const body = text.trim();
          if (!body) return "empty message";
          if (carriesBridgePrefix(body)) return "this line already carries the bridge's prefix, so a second one would be nested around it";
          const agent = agents.owner;
          if (!agent) return "no conversation is open on the DSH side";
          if (typeof agent.followup !== "function") return "this DSH build cannot accept a message here";
          try {
            await resolveFactory();
            agent.followup(buildUserMessage(`${from}\uFF08\u901A\u8FC7\u684C\u5BA0\uFF09\u8BF4\uFF1A${body}`, userTemplate));
            return null;
          } catch (err) {
            return `DSH refused the message: ${err.message}`;
          }
        },
        log
      });
      hub = pet;
      const dispose = scoped.webServer.registerUpgrade({ path: PET_PATH, handler: allowed(pet.upgrade) });
      scoped.effect(() => () => {
        dispose();
        pet.close();
        hub = null;
      });
      scoped.webServer.register({
        kind: "exact",
        path: "/coopanion/status",
        handler: (_req, res) => {
          const facts = agents.facts();
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION, pet: pet.connected, session: facts?.session ?? null }));
        }
      });
      log("info", `bridge listening on ${PET_PATH}`);
    });
    root.effect(() => () => {
      pending.length = 0;
    });
    root.on("agent/created", ((payload) => {
      const agent = payload?.agent;
      const id = agent?.session?.id;
      if (!agent || !id) return;
      if (agent.session?.parent) return;
      agents.add(String(id), agent);
    }));
    root.on("session/disposed", ((payload) => {
      const id = payload?.session?.id;
      if (id) agents.remove(String(id));
    }));
    root.on("session/event", ((session, event) => {
      const id = String(session?.id ?? "");
      if (!id || agents.ownerSession !== id) return;
      const data = event?.data ?? {};
      if (event?.type === "user/message") {
        userTemplate = data.message ?? data;
        return;
      }
      if (event?.type === "assistant/message") {
        const text = assistantText(data.message);
        if (text) notify({ t: "reply", turn: Number(data.turn) || 0, text });
        return;
      }
      if (event?.type === "tool/call") {
        const name = typeof data.name === "string" ? data.name : "tool";
        notify({ t: "tool", name, detail: argumentNames(data.arguments) });
        return;
      }
      if (event?.type === "approval/asked") {
        notify({
          t: "approval",
          name: typeof data.toolName === "string" ? data.toolName : "tool",
          reason: typeof data.reason === "string" ? data.reason : ""
        });
        return;
      }
      const notice = noticeOf(id, event);
      if (!notice) return;
      const frame = notice.frame;
      if (frame.t === "turn-end") notify({ t: "turn-end", turn: frame.turn ?? 0, reason: reasonText(frame.reason) });
      else notify(frame);
    }));
  }
};
function allowed(next) {
  return (req, socket, head) => {
    if (!LOOPBACK.test(req.headers.host ?? "")) {
      socket.destroy();
      return;
    }
    next(req, socket, head);
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AgentRegistry,
  PET_PATH,
  PROTOCOL_VERSION,
  PetHub,
  assistantText,
  noticeOf,
  parsePetFrame,
  reasonText
});
