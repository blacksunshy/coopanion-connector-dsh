/**
 * The bridge's Host half: a DSH bundle plugin that gives the Coopanion pet one local WebSocket,
 * tells it what DSH is doing, and submits the pet's words to the conversation that owns it.
 *
 * The pet is a second mouth for one conversation. It hears notices (a turn began, a reply landed,
 * a tool is waiting on approval) and it may speak (its words become a `user/message` on the owning
 * agent through `followup`). It is not an input channel for anyone else: the socket binds to the
 * Host's own loopback web server and refuses a connection whose Host header is not loopback.
 *
 * DSH says nothing when a person merely switches tabs, so the owner pointer can only move on real
 * activity. The pet therefore asks for the live sessions (`list-sessions`) and names one itself
 * (`pick`), and it can hand the pointer back (`unpin`).
 *
 * Loaded from `cordis.patch.yml` as one row; see README.md for install and protocol.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { PET_PATH, PROTOCOL_VERSION, PetHub } from './pet-hub.ts';
import { AgentRegistry, isActiveSessionEvent, noticeOf, type SessionEventLike } from './session-watch.ts';
import { readForwardState, writeForwardState } from './forward-state.ts';
import { argumentNames, assistantText, carriesBridgePrefix, reasonText, type HostFrame } from './protocol.ts';
import { createConversation, type SessionCommandsLike, type WorkspaceLike } from './new-session.ts';
import { bridgeLogFiles } from './bridge-log.ts';
import { checkUpdate, currentVersion, performUpdate, type CheckUpdateResult } from './update.ts';

/** Kept for the Host's own checks; a person's message may quote the pet's name in either language. */
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/i;

interface DshContext {
  inject(services: string[], callback: (scoped: DshContext) => void): void;
  effect(callback: () => void | (() => void)): void;
  on(event: string, listener: (...args: never[]) => void): () => void;
  get(name: string): unknown;
  logger?: { info(text: string): void; warn(text: string): void };
  webServer?: {
    registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }): () => void;
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: DshResponse) => void | Promise<void> }): () => void;
  };
}

interface DshResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** `agent/created` payload. */
interface CreatedPayload {
  agent?: {
    session?: { id?: string; header?: { cwd?: string; parentSession?: string; origin?: string } };
    followup?(message: unknown): void;
    inject?(message: unknown): void;
  };
}

interface SessionEventPayload {
  session?: { id?: string };
  event?: SessionEventLike;
}

const PLUGIN_NAME = 'coopanion-connector-dsh';

/** 后台自动检查更新的间隔。GitHub API 对匿名客户端有 60 req/min 限制，30 min 足够。 */
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Host 启动后先等这么久再跑第一次检查，别跟 DSH 自己的启动抢网络。 */
const AUTO_CHECK_INITIAL_DELAY_MS = 30 * 1000;
/**
 * 后台自动检查是否默认开启。
 *
 * 默认 **false** — 用户没显式授权的情况下不要主动连 GitHub。手动 `POST /coopanion/check-update` 路由
 * 和 `/coopanion/update` 页面的"检查"按钮不受影响，仍然可用。
 * 设环境变量 AUTO_UPDATE_CHECK=1 可开启后台定时检查。
 */
const AUTO_CHECK_ENABLED = Boolean(process.env.AUTO_UPDATE_CHECK) || process.env.AUTO_UPDATE_CHECK === '1';

/**
 * Proof of load, appended once per activation.
 *
 * A bundle that fails to resolve or activate leaves no other trace: the profile still lists it and
 * the built file still imports by hand. This line is what tells those two apart, and which process
 * the Host actually runs the bridge in. It lives inside `apply` because a bundler drops a
 * top-level side effect from a module that only exports.
 */
function proveLoad(): void {
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    execPath: process.execPath,
    argv: process.argv.slice(0, 6),
    cwd: process.cwd(),
  })}\n`;
  // One line per platform destination, so a Host whose data directory differs is still covered.
  for (const file of bridgeLogFiles()) {
    try {
      appendFileSync(file, line);
    } catch {
      // a Host without that directory still runs; the proof is a convenience, not a requirement
    }
  }
}

/**
 * A structured debug line, appended to the same jsonl as `proveLoad`.
 *
 * Opt in with `DEBUG_BRIDGE=1` (any truthy value). All normal operations keep silent; this is
 * for diagnosing "no conversation is open" gaps on hosts whose event emission is unclear.
 * Each line carries a `tag` so the reader can grep for only the signal they care about.
 */
const DEBUG_BRIDGE = Boolean(process.env.DEBUG_BRIDGE) || process.env.DEBUG_BRIDGE === '1';
function debug(tag: string, detail?: unknown): void {
  if (!DEBUG_BRIDGE) return;
  writeBridgeLine(tag, detail);
}

/**
 * An always-on lifecycle line, written regardless of `DEBUG_BRIDGE`.
 *
 * These are the few milestones a person needs to answer "did the plugin load and register its
 * routes" without setting an env var and restarting the Host. Verbose event traces stay behind
 * `debug()`. Each line carries a `tag`, so `Select-String -Pattern '"tag"'` on the jsonl shows
 * only the signal.
 */
function logLine(tag: string, detail?: unknown): void {
  writeBridgeLine(tag, detail);
}

function writeBridgeLine(tag: string, detail?: unknown): void {
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, tag, detail })}\n`;
    for (const file of bridgeLogFiles()) {
      try { appendFileSync(file, line); } catch { /* path unwritable on this host */ }
    }
  } catch { /* best-effort; never let logging break the bridge */ }
}

/**
 * Best-effort read of the address the Host's web server listens on.
 *
 * The desktop Host picks a new port on every launch, so a person configuring the pet cannot
 * know it in advance. DSH does not hand the plugin a typed `address()`, so this probes the
 * common shapes a web-server wrapper exposes and returns the first `host:port` it finds, or
 * `null` when none is reachable (the first request then fills it in from its `Host` header).
 */
function probeListeningAddress(webServer: unknown): string | null {
  const ws = webServer as {
    address?: () => unknown;
    server?: { address?: () => unknown };
    httpServer?: { address?: () => unknown };
  };
  const candidates = [
    () => ws.address?.call(ws),
    () => ws.server?.address?.call(ws.server),
    () => ws.httpServer?.address?.call(ws.httpServer),
  ];
  for (const get of candidates) {
    try {
      const addr = get();
      if (addr && typeof addr === 'object') {
        const a = addr as { address?: string; port?: number };
        if (a.port) return `${a.address && a.address !== '::' ? a.address : '127.0.0.1'}:${a.port}`;
      }
    } catch { /* try the next shape */ }
  }
  return null;
}

/** JSON.stringify that tolerates circular refs — replaces them with `[Circular]`. */
function safeStringify(value: unknown, space: number = 0): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k: string, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[Circular]';
        seen.add(v as object);
      }
      return v;
    }, space);
  } catch {
    return String(value);
  }
}

/** The module whose `createUserMessage` builds the exact user-role message `followup` accepts. */
const LLM_MODULE = '@deepseek-ai/dsh-llm';

/**
 * The factory that knows DSH's own user-message shape, resolved from the Host's module table.
 *
 * `followup` validates what it is handed, so a hand-rolled message is the last resort: the Host's
 * own factory is preferred, then the shape learned from a real `user/message` event.
 */
let factory: ((options: { content: unknown; source: unknown }) => unknown) | null | undefined;

async function resolveFactory(): Promise<((options: { content: unknown; source: unknown }) => unknown) | null> {
  if (factory !== undefined) return factory;
  try {
    const mod = (await import(LLM_MODULE)) as { createUserMessage?: unknown };
    factory = typeof mod.createUserMessage === 'function'
      ? (mod.createUserMessage as (options: { content: unknown; source: unknown }) => unknown)
      : null;
  } catch {
    factory = null;
  }
  return factory;
}

/**
 * A message that enters the session log must carry an identity of its own.
 *
 * DSH validates every stored event before it replays a session, and a `user/message` without a
 * non-empty `id` makes the whole session unloadable — one such line costs the entire history. The
 * other half of the same rule is that a reused id merges two messages into one. So each shape below
 * leaves with a fresh id, and a factory that already stamped one keeps it.
 */
function withOwnId(message: unknown): unknown {
  const id = (message as { id?: unknown } | null)?.id;
  if (typeof id === 'string' && id !== '') return message;
  return { ...(message as object), id: randomUUID() };
}

/**
 * The shapes this plugin can hand `followup`, best first: DSH's own factory, the shape of a real
 * message this session already logged, and finally the documented user-role shape.
 *
 * @param factoryOverride - the Host's own factory, or null when the module is not resolvable.
 */
export function buildUserMessage(
  text: string,
  template: unknown,
  factoryOverride: ((options: { content: unknown; source: unknown }) => unknown) | null = factory ?? null,
): unknown {
  if (factoryOverride) {
    try {
      return withOwnId(factoryOverride({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    } catch {
      // fall through to the shapes below
    }
  }
  if (template && typeof template === 'object') {
    const base = template as { content?: unknown; source?: unknown };
    // The template lends its shape, never its identity: copying the id logs two messages as one.
    return { ...base, id: randomUUID(), content: [{ type: 'text', text }] };
  }
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/**
 * Pick up conversations that were already open when this Host started.
 *
 * On desktop builds DSH does not always re-emit `agent/created` for sessions the person opened
 * before the plugin loaded — leaving the registry empty and the pet stuck on "no conversation is
 * open" until the person speaks again. The Session Controller is the same object the settings
 * window uses, so it is the most likely place an enumeration lives; this probes the method names
 * such objects typically carry and registers every agent it can actually submit a message to.
 *
 * Best-effort by design: DSH's internal API is not typed here, so every access is guarded and an
 * unknown shape is a no-op. The result is logged so a missing enumeration is visible in the bridge
 * log rather than silently producing an empty registry.
 */
async function rescanExistingSessions(
  scoped: DshContext,
  agents: AgentRegistry,
  log: (tag: string, detail?: unknown) => void,
): Promise<void> {
  type AnyObj = Record<string, unknown>;
  try {
    const controller = scoped.get('sessionController') as AnyObj | undefined;
    const registry = scoped.get('workspaceRegistry') as { list?: () => Array<{ sessionIds?: string[] }> } | undefined;

    // 1. Collect candidate session ids from the workspace registry.
    const ids = new Set<string>();
    try {
      for (const workspace of registry?.list?.() ?? []) {
        for (const id of workspace.sessionIds ?? []) if (id) ids.add(id);
      }
    } catch { /* registry shape unknown */ }

    // 2. Try to obtain an agent object per id from whatever the controller exposes.
    const getters = ['get', 'agent', 'getAgent', 'session', 'getSession'] as const;
    let obtained = 0;
    for (const id of ids) {
      let agent: unknown = undefined;
      for (const name of getters) {
        const fn = (controller as AnyObj | undefined)?.[name] as ((id: string) => unknown) | undefined;
        if (typeof fn !== 'function') continue;
        try { agent = fn.call(controller, id); } catch { continue; }
        if (agent) break;
      }
      // Also accept `controller.agents` / `.sessions` as a Map/array of agent-like objects.
      if (!agent) {
        for (const coll of ['agents', 'sessions', 'live'] as const) {
          const c = (controller as AnyObj | undefined)?.[coll];
          if (c instanceof Map) { agent = c.get(id); break; }
          if (Array.isArray(c)) {
            agent = c.find((x) => (x as { session?: { id?: string } })?.session?.id === id);
            break;
          }
        }
      }
      const a = agent as { followup?: unknown; session?: { id?: string; header?: { cwd?: string } } } | undefined;
      if (a && typeof a.followup === 'function' && a.session?.id) {
        agents.add(String(a.session.id), a as never);
        obtained++;
      }
    }

    // 3. If the controller exposes a flat list of agents directly, register those too.
    for (const coll of ['agents', 'sessions', 'list', 'listSessions'] as const) {
      const c = (controller as AnyObj | undefined)?.[coll];
      const items: unknown[] = c instanceof Map ? [...c.values()] : Array.isArray(c) ? c : [];
      for (const item of items) {
        const a = item as { followup?: unknown; session?: { id?: string } } | undefined;
        if (a && typeof a.followup === 'function' && a.session?.id) {
          const sid = String(a.session.id);
          if (!ids.has(sid)) { ids.add(sid); obtained++; }
          agents.add(sid, a as never);
        }
      }
    }

    log('rescan-existing', { sessionIds: ids.size, registered: obtained });
  } catch (err) {
    log('rescan-existing-failed', { error: (err as Error).message });
  }
}

export default {
  name: PLUGIN_NAME,
  apply(root: DshContext): void {
    proveLoad();
    // `root.webServer` is a cordis service accessor: reading it without an inject throws and the
    // whole apply() dies before the try below, taking every registered route with it (issue #9).
    // `get()` is the safe read — undefined when the Host runs no web console.
    logLine('apply-started', { hasWebServer: Boolean(root.get('webServer')) });
    const agents = new AgentRegistry();
    // DSH's archive set, read at each ownership decision: an archived Session stays live but every
    // model step proposed for it is rejected, so speaking into one would end as `blocked`.
    agents.setArchivedCheck((id) => {
      const registry = root.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined;
      return registry?.archivedSessionIds?.includes(id) ?? false;
    });
    /** The directory of the newest conversation seen, so a pet-made session lands in the same project. */
    let knownCwd: string | null = null;
    /** The Host's listening `host:port`, captured once from the first request when available. */
    let capturedHost: string | null = null;
    // 恢复上次的转发开关；没有状态文件时用 AgentRegistry 的默认值（true，即默认开）
    {
      const persisted = readForwardState();
      if (persisted !== null) agents.toggleForward(persisted);
    }
    let hub: PetHub | null = null;
    const pending: HostFrame[] = [];
    /** The last `user/message` DSH appended, used as the template for the pet's own submissions. */
    let userTemplate: unknown = null;

    const log = (level: 'info' | 'warn', text: string): void => {
      try {
        if (level === 'warn') root.logger?.warn(`[${PLUGIN_NAME}] ${text}`);
        else root.logger?.info(`[${PLUGIN_NAME}] ${text}`);
      } catch {
        // a Host without a logger still runs; the notice is not worth failing over
      }
    };

    /** Notices sent while no pet is listening are dropped: a stale turn is worse than a missed one. */
    const notify = (frame: HostFrame): void => {
      hub?.send(frame);
    };

    /**
     * The projects a `new` may target, with how many conversations each one has open.
     *
     * Membership is read the way DSH records it (`sessionIds`), with the directory as a fallback
     * for conversations that live in a workspace's path without being listed under it. Archived
     * sessions are already gone from `listSessions`, so a workspace with everything archived shows
     * zero open and the pet knows it has to create one.
     */
    const workspaceRows = (): Array<{ id: string; path: string; sessions: number; owner: boolean }> => {
      const registry = root.get('workspaceRegistry') as { list?(): WorkspaceLike[] } | undefined;
      const workspaces = registry?.list?.() ?? [];
      const live = agents.listSessions();
      const ownerSession = agents.ownerSession;
      const key = (path: string): string => {
        const trimmed = path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
        return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
      };
      return workspaces.map((workspace) => {
        const ids = new Set(workspace.sessionIds);
        const open = live.filter((session) => ids.has(session.id)
          || (workspace.path !== '' && session.cwd !== '' && key(session.cwd) === key(workspace.path)));
        return {
          id: workspace.id,
          path: workspace.path,
          sessions: open.length,
          owner: open.some((session) => session.id === ownerSession),
        };
      });
    };

    // `webServer` is provided by the Host's web console; a Host that runs without one (some
    // desktop entry paths) would make `inject` throw. Catch it so the bridge log records the
    // missing service instead of leaving only the prove-load line behind.
    try {
    root.inject(['webServer'], (scoped) => {
      try {
      const pet = new PetHub({
        welcome: () => {
          const facts = agents.facts();
          if (!facts) {
            debug('welcome-null', {
              liveCount: agents.liveSize,
              ownerSession: agents.ownerSession,
              isPinned: agents.isPinned,
            });
            return null;
          }
          knownCwd = facts.cwd || knownCwd;
          debug('welcome-ok', facts);
          return facts;
        },
        say: async (text, from) => {
          const body = text.trim();
          if (!body) return 'empty message';
          if (carriesBridgePrefix(body)) return 'this line already carries the bridge\'s prefix, so a second one would be nested around it';
          if (!agents.forwarding) return 'auto-forward disabled — open the forward toggle at /coopanion/forward (POST {on:true}) or flip it in the pet panel';
          const agent = agents.owner;
          if (!agent) {
            debug('say-refused-no-owner', {
              liveCount: agents.liveSize,
              ownerSession: agents.ownerSession,
              isPinned: agents.isPinned,
              forwarding: agents.forwarding,
            });
            return 'no conversation is open on the DSH side; a new one can be started with dsh_new_session';
          }
          if (typeof agent.followup !== 'function') return 'this DSH build cannot accept a message here';
          try {
            await resolveFactory();
            agent.followup(buildUserMessage(`${from}（通过桌宠）说：${body}`, userTemplate));
            // 告诉桌宠它的话已经递到 DSH 了——让 Coo 知道这件事"真的发生了"。
            hub?.send({ t: 'notice', kind: 'forwarded', text: `已递送到 DSH（会话 ${agents.ownerSession ?? '?'}）：${body.slice(0, 80)}${body.length > 80 ? '…' : ''}` });
            return null;
          } catch (err) {
            hub?.send({ t: 'notice', kind: 'forward-failed', text: `递送失败：${(err as Error).message}` });
            return `DSH refused the message: ${(err as Error).message}`;
          }
        },
        pick: (session) => (agents.setOwner(String(session)) ? null : 'no such open conversation'),
        listSessions: () => ({ sessions: agents.listSessions(), pinned: agents.isPinned }),
        unpin: () => {
          agents.clearPin();
          return null;
        },
        createSession: async (workspace) => {
          // The Session Controller is the same in-process path the settings window's Remote call
          // takes, so a session made here is a first-class one: published in DSH's sidebar and
          // announced as `agent/created`, which is what moves the owner onto it.
          const controller = scoped.get('sessionController') as SessionCommandsLike | undefined;
          const registry = scoped.get('workspaceRegistry') as { list?(): WorkspaceLike[] } | undefined;
          const workspaces = registry?.list?.() ?? [];
          const facts = agents.facts();
          if (facts?.cwd) knownCwd = facts.cwd;
          debug('create-session', {
            hasController: Boolean(controller?.commands?.create),
            workspaces: workspaces.map((entry) => entry.id),
            requested: workspace ?? null,
            ownerSession: agents.ownerSession,
            knownCwd,
          });
          const before = agents.ownerSession;
          const outcome = await createConversation(controller, workspaces, before, knownCwd, workspace ?? null);
          if ('reason' in outcome) {
            // `create` publishes the Session before it attaches it to a Workspace, so an attach
            // failure leaves a live conversation behind. The pet is bound to it either way; telling
            // it the creation failed would send it looking for a session that already exists.
            const after = agents.ownerSession;
            if (after !== null && after !== before) {
              log('warn', `created ${after} but DSH could not attach it: ${outcome.reason}`);
              return { session: after };
            }
          }
          return outcome;
        },
        listWorkspaces: () => workspaceRows(),
        log,
      });
      hub = pet;

      /** 最近一次后台检查更新的结果；用于 /coopanion/status 和 WebSocket 通知。 */
      let lastCheck: CheckUpdateResult | null = null;
      /** 上一次已经通知过 pet 的版本号，避免同一个新版本反复通知。 */
      let lastNotifiedVersion: string | null = null;

      /**
       * Claim the pet's upgrade route, and keep it claimed.
       *
       * A DSH desktop hot reload can leave the previous instance holding the path: the duplicate
       * registration throws and both instances then drop it, after which the pet's upgrade dies as
       * a silently destroyed socket. So take over a route this instance does not own, and re-claim
       * it if it disappears later.
       */
      // The Host's `registerUpgrade` stores `{ ...route, handler: wrapped }` — a copy, so comparing
      // object identity always says "not mine" and the heal loop re-claims every 5s (two warn lines
      // each time; ~35k lines a day, issue #8). A marker copied along with the row tells the truth.
      const UPGRADE_OWNER = `coopanion-${Math.random().toString(36).slice(2)}`;
      const upgradeRoute = { path: PET_PATH, handler: allowed(pet.upgrade), owner: UPGRADE_OWNER };
      const upgradeTable = (): Map<string, unknown> | null => {
        const table = (scoped.webServer as { upgrades?: unknown }).upgrades;
        return table instanceof Map ? table : null;
      };
      const ownsRow = (row: unknown): boolean => (row as { owner?: string } | undefined)?.owner === UPGRADE_OWNER;
      const holdsUpgrade = (): boolean => {
        const table = upgradeTable();
        return table === null ? true : ownsRow(table.get(PET_PATH));
      };
      const claimUpgrade = (): (() => void) | null => {
        const table = upgradeTable();
        if (table !== null && table.has(PET_PATH) && !ownsRow(table.get(PET_PATH))) {
          try {
            table.delete(PET_PATH);
            log('warn', `took over a stale upgrade route ${PET_PATH}`);
          } catch {
            // a table that refuses deletion still lets registerUpgrade report the conflict
          }
        }
        try {
          return scoped.webServer!.registerUpgrade(upgradeRoute);
        } catch (err) {
          log('warn', `upgrade route ${PET_PATH} not claimed: ${(err as Error).message}`);
          return null;
        }
      };
      let disposeUpgrade = claimUpgrade();
      const healRoutes = setInterval(() => {
        if (holdsUpgrade()) return;
        log('warn', `upgrade route ${PET_PATH} went missing, re-claiming`);
        disposeUpgrade = claimUpgrade();
      }, 5000);
      healRoutes.unref?.();

      /** GET — 自更新页面 HTML 界面；POST — 兼容路由，走 performUpdate。 */
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/update',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const cur = currentVersion();
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(buildUpdatePage(cur));
            return;
          }
          if (req.method === 'POST') {
            await handleDoUpdate(res);
            return;
          }
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'use GET for the UI or POST for the update' }));
        },
      });
      /** POST — 实际执行自更新；UI 和脚本都调这个。 */
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/do-update',
        handler: async (_req, res) => { await handleDoUpdate(res); },
      });

      /** 抽出来避免两条 POST 路由重复同样的写头 + performUpdate。 */
      async function handleDoUpdate(res: DshResponse): Promise<void> {
        const result = await performUpdate();
        res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result));
        if (result.ok) {
          log('info', `self-updated ${result.from} -> ${result.to}; restart DSH to load new dist/index.cjs`);
          // 更新完了，版本同步掉
          lastNotifiedVersion = result.to ?? null;
        } else {
          log('warn', `self-update failed: ${result.error}`);
        }
      }

      // A read-only view for the pet page and for hand-checking the bridge without a socket.
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/status',
        handler: (req, res) => {
          // The Host's listening port changes every desktop launch; capture it from the first
          // request's Host header when the web-server wrapper does not expose an address().
          if (capturedHost === null) {
            capturedHost = typeof req.headers.host === 'string' ? req.headers.host : null;
            if (capturedHost) logLine('listening-address', { host: capturedHost, source: 'request-host' });
          }
          const facts = agents.facts();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({
            ok: true,
            v: PROTOCOL_VERSION,
            pluginVersion: currentVersion(),
            pet: pet.connected,
            bound: pet.boundState,
            route: holdsUpgrade(),
            pid: process.pid,
            session: facts?.session ?? null,
            forwarding: agents.forwarding,
            updateInfo: lastCheck ? {
              hasUpdate: lastCheck.hasUpdate,
              current: lastCheck.current,
              latest: lastCheck.latest,
              releaseUrl: lastCheck.releaseUrl,
              releaseName: lastCheck.releaseName,
              checkedAt: new Date().toISOString(),
            } : null,
            updateUrl: '/coopanion/update',
          }));
        },
      });
      /**
       * Toggle auto-forward on/off. When the pet is connected it also gets a notice so it knows
       * the gate has moved — honest epistemology: state changes announce themselves.
       */
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/forward',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'use POST' }));
            return;
          }
          let target: boolean | undefined;
          try {
            if (req.headers['content-length']) {
              // Best-effort — a plain fetch() without JSON body still gives us undefined here.
            }
          } catch { /* ignore */ }
          // Default behaviour: if the caller sent no body, just flip. {on: true/false} wins.
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              if (body) {
                const parsed = JSON.parse(body) as { on?: unknown };
                if (typeof parsed.on === 'boolean') target = parsed.on;
              }
            } catch { /* malformed body → flip */ }
            const next = agents.toggleForward(target);
            writeForwardState(next);
            // 告诉桌宠状态变了
            hub?.send({ t: 'notice', kind: 'forward-toggle', text: next ? '自动递送已开启' : '自动递送已关闭' });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, forwarding: next }));
          });
        },
      });
      /**
       * List every live session so the pet can offer an explicit picker. DSH stays silent when a
       * person merely switches tabs (no session/event, no agent/created for already-open ones),
       * so passive auto-follow cannot see silent navigation — the picker replaces mind-reading.
       */
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/sessions',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({
            ok: true,
            sessions: agents.listSessions(),
            pinned: agents.isPinned,
          }));
        },
      });
      /**
       * Explicitly move the owner to a session. Body `{id, pin?}`: pin defaults to true — an
       * explicit human choice outranks auto-follow until they pick another one (or unpin via
       * `{id, pin:false}`, which moves without pinning). Refuses sessions that are not live or
       * are subagents; the pet shows the refusal instead of guessing.
       */
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/owner',
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'use POST' }));
            return;
          }
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            let id: unknown;
            let pin = true;
            try {
              const parsed = JSON.parse(body) as { id?: unknown; pin?: unknown };
              id = parsed.id;
              if (typeof parsed.pin === 'boolean') pin = parsed.pin;
            } catch { /* malformed → id stays undefined */ }
            if (typeof id !== 'string' || !id) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'body must be {"id":"<session-id>","pin":true|false}' }));
              return;
            }
            const moved = pin ? agents.setOwner(id) : agents.forceOwner(id);
            if (!moved) {
              res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({
                ok: false,
                error: 'session is not live, is a subagent, or is already the owner',
                id,
                pinned: agents.isPinned,
                owner: agents.ownerSession,
              }));
              return;
            }
            const facts = agents.facts();
            // 告诉桌宠 owner 变了，它的面板立刻跟上
            if (facts && hub && hub.connected) hub.notifyBound(facts);
            debug('owner-switched', { id, pin, owner: agents.ownerSession });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, session: facts?.session ?? id, pinned: agents.isPinned }));
          });
        },
      });
      // Check if a newer release is available on GitHub. Caches result for status + auto-notice.
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/check-update',
        handler: async (_req, res) => {
          const result = await checkUpdate();
          lastCheck = result;
          // 通知连接着的桌宠：有新版本啦
          if (result.ok && result.hasUpdate && result.latest !== lastNotifiedVersion) {
            if (hub?.connected) {
              hub.send({
                t: 'notice',
                kind: 'update-available',
                text: `Coopanion Connector 有新版本 v${result.latest}，当前 v${result.current}。访问 /coopanion/update 查看。`,
              });
            }
            lastNotifiedVersion = result.latest;
          }
          res.writeHead(result.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(result));
        },
      });

      // 后台定时检查：Host 起来 30s 后第一次跑，之后每 30 min 一次。
      // 默认关闭，设 AUTO_UPDATE_CHECK=1 才启动 — 用户没显式授权的情况下不主动连 GitHub。
      let autoTimer: NodeJS.Timeout | null = null;
      const schedule = (): void => {
        autoTimer = setTimeout(async () => {
          try {
            const result = await checkUpdate();
            lastCheck = result;
            if (result.ok && result.hasUpdate && result.latest !== lastNotifiedVersion) {
              if (hub?.connected) {
                hub.send({
                  t: 'notice',
                  kind: 'update-available',
                  text: `Coopanion Connector 有新版本 v${result.latest}，当前 v${result.current}。访问 /coopanion/update 查看更新介绍并更新。`,
                });
              }
              lastNotifiedVersion = result.latest;
            }
          } catch (err) {
            log('warn', `background update check failed: ${(err as Error).message}`);
          } finally {
            autoTimer = setTimeout(schedule, AUTO_CHECK_INTERVAL_MS);
            autoTimer.unref?.();
          }
        }, AUTO_CHECK_INITIAL_DELAY_MS);
        autoTimer.unref?.();
      };
      if (AUTO_CHECK_ENABLED) schedule();

      scoped.effect(() => () => {
        clearInterval(healRoutes);
        disposeUpgrade?.();
        pet.close();
        hub = null;
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      });
      log('info', `bridge listening on ${PET_PATH}`);
      const listening = probeListeningAddress(scoped.webServer);
      logLine('routes-registered', { petPath: PET_PATH, address: listening });
      debug('apply-done', { petPath: PET_PATH, hasWebServer: true });
      // Conversations opened before the plugin loaded may never re-emit `agent/created` on
      // desktop hosts, which leaves the registry empty and the pet stuck on "no conversation".
      // Probe the Session Controller for whatever enumeration DSH exposes and register the ones
      // we can actually speak into. This is best-effort: an unknown shape is a no-op.
      void rescanExistingSessions(scoped, agents, logLine);
      } catch (err) {
        // Log but do not rethrow: a partial route registration is better than taking the whole
        // plugin (and the Host's activation) down. The `webserver-init-failed` line is the trace.
        logLine('webserver-init-failed', { error: (err as Error).message });
      }
    });
    } catch (err) {
      logLine('webserver-missing', { error: (err as Error).message });
    }

    root.effect(() => () => {
      pending.length = 0;
    });

    root.on('agent/created', ((payload: CreatedPayload) => {
      const agent = payload?.agent;
      const id = agent?.session?.id;
      if (!agent || !id) {
        // Always-on: this is the single most diagnostic line for the "no conversation is open"
        // bug. If the desktop Host fires `agent/created` with a shape our CreatedPayload does
        // not match, the raw payload here tells us exactly what to adapt to.
        logLine('agent-created-skipped', {
          hasAgent: Boolean(agent),
          sessionId: agent?.session?.id ?? null,
          sessionKeys: agent ? Object.keys(agent as object) : null,
          rawPayload: safeStringify(payload),
        });
        return;
      }
      debug('agent-created', {
        id: String(id),
        isSubagent: agent.session?.header?.parentSession || agent.session?.header?.origin === 'subagent',
        hasFollowup: typeof agent.followup === 'function',
        hasInject: typeof agent.inject === 'function',
      });
      // 子代理判断已在 AgentRegistry.add 内部处理（isSubagent），这里不再重复
      knownCwd = agent.session?.header?.cwd ?? knownCwd;
      agents.add(String(id), agent as never);
      // If the pet is waiting (connected but no session yet), give it a late `ready` now.
      const facts = agents.facts();
      if (facts && hub && hub.connected) hub.notifyBound(facts);
    }) as never);

    root.on('session/disposed', ((session: { id?: string }) => {
      const id = session?.id;
      debug('session-disposed', { id: String(id ?? ''), wasOwner: Boolean(id && agents.ownerSession === id) });
      const wasOwner = id && agents.ownerSession === id;
      if (id) agents.remove(String(id));
      // If the disposed session was the owner, the pet may need re-binding or unbinding.
      if (wasOwner && hub && hub.connected) {
        const facts = agents.facts();
        if (facts) hub.notifyBound(facts);    // a new owner is available
        else hub.notifyUnbound();              // no owner left
      }
    }) as never);

    root.on('session/event', ((session: { id?: string }, event: SessionEventLike) => {
      const id = String(session?.id ?? '');
      if (!id) return;
      const data = (event?.data ?? {}) as Record<string, unknown>;
      // 缓存 model：DSH 每次请求都会发 request/header，里面含 config.model
      if (event?.type === 'request/header') {
        const model = (data.header as { config?: { model?: unknown } })?.config?.model;
        if (typeof model === 'string' && model) agents.rememberModel(id, model);
        // 即便这个 session 不是 owner，也缓存一下，切过来时能直接读到
        return;
      }
      debug('session-event', { type: event?.type, id, ownerSession: agents.ownerSession, liveCount: agents.liveSize });
      // Auto-follow：当一个已经存在的会话开始活跃（用户说话 / 模型回复 / 工具调用 / 审批），
      // 而桌宠还在跟着另一个会话时，把 owner 切过来，让桌宠的 status 和转发目标都对齐到
      // 用户当前在 DSH 里真正操作的那个会话。forceOwner 内部会把 pinned 清掉——用户在别的
      // 会话说话这个行为，比之前的 pin（无论显式还是桌宠同步来的）表达更强的当前意图。
      if (agents.ownerSession !== id && isActiveSessionEvent(event)) {
        const agent = agents.liveGet(id);
        debug('auto-follow-check', { id, agentKnown: Boolean(agent), isSubagent: agent ? agents.isSubagent(agent) : null, pinned: agents.isPinned });
        if (agent && !agents.isSubagent(agent)) {
          if (agents.forceOwner(id)) {
            debug('auto-follow-moved', { newOwner: id });
            const facts = agents.facts();
            if (facts && hub?.connected) hub.notifyBound(facts);
          }
        }
      }
      if (agents.ownerSession !== id) return;
      if (event?.type === 'user/message') {
        userTemplate = data.message ?? data;
        return;
      }
      if (event?.type === 'assistant/message') {
        const text = assistantText(data.message);
        if (text) notify({ t: 'reply', turn: Number(data.turn) || 0, text });
        return;
      }
      if (event?.type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : 'tool';
        notify({ t: 'tool', name, detail: argumentNames(data.arguments) });
        return;
      }
      if (event?.type === 'approval/asked') {
        notify({
          t: 'approval',
          name: typeof data.toolName === 'string' ? data.toolName : 'tool',
          reason: typeof data.reason === 'string' ? data.reason : '',
        });
        return;
      }
      const notice = noticeOf(id, event);
      if (!notice) return;
      const frame = notice.frame as { t: string; turn?: number; reason?: unknown };
      if (frame.t === 'turn-end') notify({ t: 'turn-end', turn: frame.turn ?? 0, reason: reasonText(frame.reason) });
      else notify(frame as HostFrame);
    }) as never);
  },
};

/** Refuses a non-loopback Host, so a web page cannot reach the bridge through DNS rebinding.
 *
 * Also refuses any WebSocket upgrade that carries an `Origin` header — browsers always include
 * one when they open a WS, while native Node clients (the real pet) do not. This blocks CSWSH:
 * a malicious page cannot silently `new WebSocket("ws://127.0.0.1:<port>/coopanion/pet")` and
 * inject frames into the bridge. */
function allowed(next: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // 浏览器发 WebSocket 必带 Origin，原生 Node 客户端不带：拒绝带 Origin 的连接
    if (req.headers.origin) {
      socket.destroy();
      return;
    }
    if (!LOOPBACK.test(req.headers.host ?? '')) {
      socket.destroy();
      return;
    }
    next(req, socket, head);
  };
}

/** Every text block of a message, joined; used to read back what was submitted. */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Returns the self-contained HTML page the Host serves at GET /coopanion/update.
 * Injects the currently running version; all other dynamic state (latest release,
 * notes, update status) is fetched client-side from the same Host.
 */
function buildUpdatePage(current: string): string {
  // NOTE: backticks below need escaping if any future change adds ${…} inside the JS string;
  // the two ${current} are intentional — evaluated at render time.
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coopanion Connector · 自更新</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --text:#e2e8f0; --muted:#94a3b8; --accent:#0ea5e9; --accent-dim:#0284c7; --ok:#22c55e; --warn:#f59e0b; --err:#ef4444; --border:#334155; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column; }
  header { padding: 28px 24px 16px; border-bottom: 1px solid var(--border); }
  header h1 { margin:0 0 4px; font-size:20px; font-weight:600; }
  header .sub { color:var(--muted); font-size:13px; }
  main { flex:1; max-width:720px; margin:24px auto; padding: 0 24px; width:100%; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:20px; margin-bottom:16px; }
  .hidden { display:none; }
  h2 { margin:0 0 8px; font-size:16px; font-weight:600; }
  .version-line { font-size:14px; color:var(--muted); margin-bottom:4px; }
  .version-line strong { color:var(--text); }
  .releasename { font-size:13px; color:var(--muted); margin:2px 0 12px; }
  .notes-box { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; margin-top:8px; }
  .notes-box pre { margin:0; white-space:pre-wrap; font-family: ui-monospace,Menlo,monospace; font-size:13px; line-height:1.5; color:#cbd5e1; max-height:360px; overflow:auto; }
  .notes-box summary { cursor:pointer; color:var(--accent); font-size:13px; user-select:none; }
  .notes-box summary:hover { text-decoration:underline; }
  button { cursor:pointer; border:none; border-radius:8px; padding:10px 20px; font-size:14px; font-weight:500; transition: background .15s, transform .05s; }
  button.primary { background:var(--accent); color:white; }
  button.primary:hover { background:var(--accent-dim); }
  button.primary:active { transform: translateY(1px); }
  button.primary:disabled { opacity:.5; cursor:not-allowed; }
  button.ghost { background:transparent; border:1px solid var(--border); color:var(--text); }
  button.ghost:hover { background:rgba(255,255,255,.04); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .hint { color:var(--muted); font-size:12px; margin-top:10px; }
  .ok { border-color:rgba(34,197,94,.4); }
  .ok h2 { color:var(--ok); }
  .err h2 { color:var(--err); }
  .spinner { width:20px; height:20px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; margin-top:12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .mono { font-family: ui-monospace,Menlo,monospace; }
  .current-chip { display:inline-block; background:rgba(14,165,233,.15); color:var(--accent); padding:2px 8px; border-radius:6px; font-size:12px; font-weight:500; }
  footer { text-align:center; padding:16px; color:var(--muted); font-size:11px; border-top:1px solid var(--border); }
</style>
</head>
<body>
<header>
  <h1>🔄 Coopanion Connector 自更新</h1>
  <p class="sub">本地插件，自动从 GitHub Release 拉取新版本</p>
</header>
<main id="app">
  <section id="checking" class="card">正在检查更新…</section>
  <section id="uptodate" class="card ok hidden">
    <h2>已是最新版本 ✅</h2>
    <p class="version-line">当前 <span class="current-chip"></span>，GitHub Release 上暂无更新。</p>
    <p><a href="https://github.com/blacksunshy/coopanion-connector-dsh/releases" target="_blank" rel="noreferrer">查看所有 Release →</a></p>
  </section>
  <section id="available" class="card hidden">
    <h2>发现新版本 🎉</h2>
    <p class="version-line">当前 <strong>v<span id="curV">${current}</span></strong> → 最新 <strong>v<span id="latV"></span></strong></p>
    <p class="releasename" id="relName"></p>
    <div class="notes-box">
      <details open>
        <summary>📝 更新介绍</summary>
        <pre id="relNotes">加载中…</pre>
      </details>
    </div>
    <p><a id="relUrl" href="#" target="_blank" rel="noreferrer">在 GitHub Release 页面查看 →</a></p>
    <button id="updateBtn" class="primary">立即更新（下载并覆盖）</button>
    <p class="hint">更新完成后需要 <strong>重启 DSH</strong> 才能加载新版本。</p>
  </section>
  <section id="error" class="card err hidden">
    <h2>检查失败 ❌</h2>
    <p id="errMsg" class="mono"></p>
    <button class="ghost" onclick="check()">重试</button>
  </section>
  <section id="updating" class="card hidden">
    <h2>正在更新…</h2>
    <p>从 GitHub Release 下载源码包，覆盖本地 dist/ 和 package.json…</p>
    <div class="spinner"></div>
  </section>
  <section id="done" class="card ok hidden">
    <h2>更新完成 ✅</h2>
    <p><strong>v<span id="fromV"></span></strong> → <strong>v<span id="toV"></span></strong></p>
    <p><strong>请重启 DSH</strong> 让新版本生效。</p>
  </section>
</main>
<footer>Coopanion Connector 自更新 · Host 注入 v${current}</footer>
<script>
const $ = (id) => document.getElementById(id);
async function check() {
  show('checking');
  try {
    const r = await fetch('/coopanion/check-update', { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) {
      $('errMsg').textContent = d.error || '未知错误';
      show('error');
      return;
    }
    if (!d.hasUpdate) {
      $('uptodate').querySelector('.current-chip').textContent = 'v' + d.current;
      show('uptodate');
      return;
    }
    $('curV').textContent = d.current;
    $('latV').textContent = d.latest;
    $('relName').textContent = d.releaseName ? d.releaseName : '';
    $('relNotes').textContent = d.releaseNotes ? d.releaseNotes.trim() : '（该 Release 没有写更新说明）';
    $('relUrl').href = d.releaseUrl;
    show('available');
  } catch (e) {
    $('errMsg').textContent = String(e.message || e);
    show('error');
  }
}
async function doUpdate() {
  $('updateBtn').disabled = true;
  show('updating');
  try {
    const r = await fetch('/coopanion/do-update', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) {
      $('errMsg').textContent = d.error || '更新失败';
      show('error');
      return;
    }
    $('fromV').textContent = d.from || '';
    $('toV').textContent = d.to || '';
    show('done');
  } catch (e) {
    $('errMsg').textContent = String(e.message || e);
    show('error');
  }
}
function show(id) {
  ['checking','uptodate','available','error','updating','done'].forEach(s => $(s).classList.toggle('hidden', s !== id));
}
window.addEventListener('DOMContentLoaded', () => {
  $('updateBtn').addEventListener('click', doUpdate);
  check();
});
</script>
</body>
</html>`;
}

