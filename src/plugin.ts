/**
 * The bridge's Host half: a DSH bundle plugin that gives the Coopanion pet one local WebSocket,
 * tells it what DSH is doing, and submits the pet's words to the conversation that owns it.
 *
 * The pet is a second mouth for one conversation. It hears notices (a turn began, a reply landed,
 * a tool is waiting on approval) and it may speak (its words become a `user/message` on the owning
 * agent through `followup`). It is not an input channel for anyone else: the socket binds to the
 * Host's own loopback web server and refuses a connection whose Host header is not loopback.
 *
 * Loaded from `cordis.patch.yml` as one row; see README.md for install and protocol.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { PET_PATH, PROTOCOL_VERSION, PetHub } from './pet-hub.ts';
import { AgentRegistry, isActiveSessionEvent, noticeOf, type SessionEventLike } from './session-watch.ts';
import { argumentNames, assistantText, carriesBridgePrefix, reasonText, type HostFrame } from './protocol.ts';
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
  // Two destinations, so a Host whose data directory differs is still covered.
  for (const file of [
    `${process.env.APPDATA ?? ''}\\@deepseek-ai\\dsh-desktop\\logs\\coopanion-bridge.jsonl`,
    `${process.env.USERPROFILE ?? ''}\\.dsh\\logs\\coopanion-bridge.jsonl`,
  ]) {
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
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, tag, detail })}\n`;
    for (const file of [
      `${process.env.APPDATA ?? ''}\\@deepseek-ai\\dsh-desktop\\logs\\coopanion-bridge.jsonl`,
      `${process.env.USERPROFILE ?? ''}\\.dsh\\logs\\coopanion-bridge.jsonl`,
    ]) {
      try { appendFileSync(file, line); } catch { /* path unwritable on this host */ }
    }
  } catch { /* best-effort; never let debug break the bridge */ }
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

export default {
  name: PLUGIN_NAME,
  apply(root: DshContext): void {
    proveLoad();
    const agents = new AgentRegistry();
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

    root.inject(['webServer'], (scoped) => {
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
          debug('welcome-ok', facts);
          return facts;
        },
        say: async (text, from) => {
          const body = text.trim();
          if (!body) return 'empty message';
          if (carriesBridgePrefix(body)) return 'this line already carries the bridge\'s prefix, so a second one would be nested around it';
          if (!agents.forwarding) return 'auto-forward disabled — Coo must call the tool to deliver words';
          const agent = agents.owner;
          if (!agent) {
            debug('say-refused-no-owner', {
              liveCount: agents.liveSize,
              ownerSession: agents.ownerSession,
              isPinned: agents.isPinned,
              forwarding: agents.forwarding,
            });
            return 'no conversation is open on the DSH side';
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
        log,
      });
      hub = pet;

      /** 最近一次后台检查更新的结果；用于 /coopanion/status 和 WebSocket 通知。 */
      let lastCheck: CheckUpdateResult | null = null;
      /** 上一次已经通知过 pet 的版本号，避免同一个新版本反复通知。 */
      let lastNotifiedVersion: string | null = null;

      const disposeUpgrade = scoped.webServer!.registerUpgrade({ path: PET_PATH, handler: allowed(pet.upgrade) });

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
        handler: (_req, res) => {
          const facts = agents.facts();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({
            ok: true,
            v: PROTOCOL_VERSION,
            pluginVersion: currentVersion(),
            pet: pet.connected,
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
            // 告诉桌宠状态变了
            hub?.send({ t: 'notice', kind: 'forward-toggle', text: next ? '自动递送已开启' : '自动递送已关闭' });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, forwarding: next }));
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
      schedule();

      scoped.effect(() => () => {
        disposeUpgrade();
        pet.close();
        hub = null;
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      });
      log('info', `bridge listening on ${PET_PATH}`);
      debug('apply-done', { petPath: PET_PATH, hasWebServer: true });
    });

    root.effect(() => () => {
      pending.length = 0;
    });

    root.on('agent/created', ((payload: CreatedPayload) => {
      const agent = payload?.agent;
      const id = agent?.session?.id;
      if (!agent || !id) {
        debug('agent-created-skipped', {
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

/** Refuses a non-loopback Host, so a web page cannot reach the bridge through DNS rebinding. */
function allowed(next: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
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

