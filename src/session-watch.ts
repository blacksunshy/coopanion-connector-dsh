/**
 * Which agent the pet's words belong to, and what the pet hears about it.
 *
 * The pet is a second mouth for one conversation, so the bridge keeps exactly one owning agent:
 * the most recently created live agent that is not a subagent. A subagent that answered a bubble
 * would be a speaker the person never opened, and an older session would take words the person
 * meant for the one on their screen.
 *
 * Everything this module reads from DSH arrives through `session/event`, whose envelopes are
 * `{ type, data }`. The plugin never writes an event of its own type: a reader that meets an
 * unknown persisted type cannot reopen the session.
 */

/** What the pet may be told about the agent it is talking to. */
export interface AgentFacts {
  session: string;
  cwd: string;
  model: string;
}

/** DSH's session header: where cwd and subagent flags actually live. */
interface SessionHeader {
  cwd?: string;
  parentSession?: string;
  origin?: string;
}

/** One live agent, as much of it as this plugin touches. */
export interface LiveAgent {
  session: { id?: string; header?: SessionHeader };
  /** Submits context and wakes the agent; resolves once the message is queued. */
  followup?(message: unknown): void;
  /** Submits context without waking the agent. */
  inject?(message: unknown): void;
  /** DSH's own text-only user message factory, resolved once per process. */
  createUserMessage?: (options: { content: string; source: unknown }) => unknown;
}

/** The newest agent wins; a subagent never wins. */
export class AgentRegistry {
  private readonly live = new Map<string, LiveAgent>();
  /** model 按 session 缓存，因为模型是请求级属性而非 agent 常驻属性。 */
  private readonly modelCache = new Map<string, string>();
  private ownerId: string | null = null;

  /** Keyed by session id, which is what `agent/created` and `session/disposed` agree on. */
  add(id: string, agent: LiveAgent): void {
    // 子代理不应成为 owner；但先加入 live Map（万一主会话晚到了，之后还能被正确移除）
    if (!this.isSubagent(agent)) {
      this.live.set(id, agent);
      this.ownerId = id;
    } else {
      this.live.set(id, agent);
    }
  }

  remove(id: string): void {
    this.live.delete(id);
    this.modelCache.delete(id);
    if (this.ownerId === id) this.ownerId = [...this.live.keys()].at(-1) ?? null;
    // owner 若变成子代理，跳过去找下一个非子代理
    while (this.ownerId !== null) {
      const owner = this.live.get(this.ownerId);
      if (owner && !this.isSubagent(owner)) break;
      this.ownerId = [...this.live.keys()].at(-1) ?? null;
    }
  }

  get owner(): LiveAgent | null {
    if (this.ownerId === null) return null;
    const a = this.live.get(this.ownerId);
    return a && !this.isSubagent(a) ? a : null;
  }

  get ownerSession(): string | null {
    return this.ownerId;
  }

  /**
   * Lets the pet point its words at a specific live session, instead of always following the
   * newest one. Returns false when the session is not live (already disposed, never created, or a
   * subagent), so the caller can refuse the switch.
   */
  setOwner(id: string): boolean {
    const agent = this.live.get(id);
    if (!agent) return false;
    if (this.isSubagent(agent)) return false;
    this.ownerId = id;
    return true;
  }

  /** 记录某会话最近一次 request/header 里看到的模型名。 */
  rememberModel(id: string, model: string): void {
    if (model) this.modelCache.set(id, model);
  }

  /** What the pet is told on connect; null when no conversation is open yet. */
  facts(): AgentFacts | null {
    const agent = this.owner;
    if (!agent) return null;
    const session = agent.session;
    const header = session.header;
    return {
      session: String(session.id ?? ''),
      cwd: String(header?.cwd ?? ''),
      model: this.modelOf(String(session.id ?? '')),
    };
  }

  private modelOf(sessionId: string): string {
    return this.modelCache.get(sessionId) ?? '';
  }

  private isSubagent(agent: LiveAgent): boolean {
    const header = agent.session.header;
    if (!header) return false;
    if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return true;
    if (header.origin === 'subagent') return true;
    return false;
  }
}

/** DSH envelope: `{ type, data }` with the payload keyed by type. */
export interface SessionEventLike {
  type?: unknown;
  data?: unknown;
}

/** A notice for the pet derived from one session event, or null when the event is not the pet's business. */
export function noticeOf(sessionId: string, event: SessionEventLike): { to: string; frame: unknown } | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'turn/start':
      return number(data.turn) === null
        ? null
        : { to: sessionId, frame: { t: 'turn-start', turn: number(data.turn) } };
    case 'turn/end':
      return number(data.turn) === null
        ? null
        : { to: sessionId, frame: { t: 'turn-end', turn: number(data.turn), reason: reason(data.reason) } };
    default:
      return null;
  }
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function reason(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return 'completed';
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : 'completed';
}
