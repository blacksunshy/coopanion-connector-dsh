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
import { AgentRegistry, noticeOf, type SessionEventLike } from './session-watch.ts';
import { argumentNames, assistantText, carriesBridgePrefix, reasonText, type HostFrame } from './protocol.ts';

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
    session?: { id?: string; cwd?: string; parent?: unknown };
    followup?(message: unknown): void;
    inject?(message: unknown): void;
  };
}

interface SessionEventPayload {
  session?: { id?: string };
  event?: SessionEventLike;
}

const PLUGIN_NAME = 'coopanion-connector-dsh';

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
          if (!facts) return null;
          return facts;
        },
        say: async (text, from) => {
          const body = text.trim();
          if (!body) return 'empty message';
          if (carriesBridgePrefix(body)) return 'this line already carries the bridge\'s prefix, so a second one would be nested around it';
          const agent = agents.owner;
          if (!agent) return 'no conversation is open on the DSH side';
          if (typeof agent.followup !== 'function') return 'this DSH build cannot accept a message here';
          try {
            await resolveFactory();
            agent.followup(buildUserMessage(`${from}（通过桌宠）说：${body}`, userTemplate));
            return null;
          } catch (err) {
            return `DSH refused the message: ${(err as Error).message}`;
          }
        },
        log,
      });
      hub = pet;
      const dispose = scoped.webServer!.registerUpgrade({ path: PET_PATH, handler: allowed(pet.upgrade) });
      scoped.effect(() => () => {
        dispose();
        pet.close();
        hub = null;
      });
      // A read-only view for the pet page and for hand-checking the bridge without a socket.
      scoped.webServer!.register({
        kind: 'exact',
        path: '/coopanion/status',
        handler: (_req, res) => {
          const facts = agents.facts();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, v: PROTOCOL_VERSION, pet: pet.connected, session: facts?.session ?? null }));
        },
      });
      log('info', `bridge listening on ${PET_PATH}`);
    });

    root.effect(() => () => {
      pending.length = 0;
    });

    root.on('agent/created', ((payload: CreatedPayload) => {
      const agent = payload?.agent;
      const id = agent?.session?.id;
      if (!agent || !id) return;
      // A subagent answers nothing the person asked the pet; only the main conversation owns the socket.
      if (agent.session?.parent) return;
      agents.add(String(id), agent as never);
    }) as never);

    root.on('session/disposed', ((payload: { session?: { id?: string } }) => {
      const id = payload?.session?.id;
      if (id) agents.remove(String(id));
    }) as never);

    root.on('session/event', ((session: { id?: string }, event: SessionEventLike) => {
      const id = String(session?.id ?? '');
      if (!id || agents.ownerSession !== id) return;
      const data = (event?.data ?? {}) as Record<string, unknown>;
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

