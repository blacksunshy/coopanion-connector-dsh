/**
 * Which agent the pet's words belong to, and what the pet hears about it.
 *
 * The pet is a second mouth for one conversation, so the bridge keeps exactly one owning agent.
 * Three ways the owner can change:
 *   1. A brand-new non-subagent session is created (agent/created) — the default follows newest.
 *   2. A session that already existed fires an active event (user message, reply, tool call, …) —
 *      the auto-follow snaps the owner to it, so a person switching tabs on an old conversation
 *      will see the pet pick up after they speak.
 *   3. The pet explicitly `pick`s a session — pins it; auto-follow and new-session creation stop
 *      stealing the owner away until that pinned session is disposed or unpinned.
 *
 * A subagent (header.parentSession present or origin === 'subagent') is never an owner.
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

/** The newest non-subagent wins, but a pinned session keeps the owner. */
export class AgentRegistry {
  private readonly live = new Map<string, LiveAgent>();
  /** model 按 session 缓存，因为模型是请求级属性而非 agent 常驻属性。 */
  private readonly modelCache = new Map<string, string>();
  private ownerId: string | null = null;
  /** True after the pet's explicit `pick` — auto-follow and new-session creation stop stealing. */
  private pinned: boolean = false;
  /**
   * Whether pet words are auto-forwarded into DSH sessions.
   *
   * Default **true** — 0.2.10 改回默认开，因为默认关等于"升级后主路径功能消失"
   * （用户升级后桥明明连着，打字却不自动转 DSH，必须手动开配置才恢复）。
   *
   * 用户关掉的开关会被持久化到 profile 下 `coopanion-forward.json`，
   * 下次启动由 Host 在 `apply()` 里用 `toggleForward(persisted)` 覆盖这个默认值。
   * 所以这个 `true` 只管"从没设置过"的情况；一旦用户显式切过，持久化生效。
   */
  private forward: boolean = true;

  /** Forward pet's words into DSH sessions (opt-in). */
  get forwarding(): boolean { return this.forward; }

  /** Toggle; returns the new value. */
  toggleForward(next?: boolean): boolean {
    this.forward = next ?? !this.forward;
    return this.forward;
  }

  /** True while the pet has explicitly pinned one session. */
  get isPinned(): boolean {
    return this.pinned;
  }

  /**
   * A new agent appeared. Subagents join the live map but do not steal the owner from an
   * unpinned non-subagent. An unpinned registry still points at the newest non-subagent; a
   * pinned one stays put.
   */
  add(id: string, agent: LiveAgent): void {
    this.live.set(id, agent);
    if (this.isSubagent(agent)) return;
    if (!this.pinned) this.ownerId = id;
  }

  remove(id: string): void {
    this.live.delete(id);
    this.modelCache.delete(id);
    // The pinned session is gone — nothing left to pin. Let natural follow resume.
    if (this.pinned && this.ownerId === id) this.pinned = false;
    if (this.ownerId === id) {
      this.ownerId = [...this.live.keys()].at(-1) ?? null;
    }
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

  /** How many sessions are currently in the live map — useful for debug logging. */
  get liveSize(): number {
    return this.live.size;
  }

  /** The agent currently tracked by id, or undefined when never seen or already disposed. */
  liveGet(id: string): LiveAgent | undefined {
    return this.live.get(id);
  }

  /**
   * Lets the pet point its words at a specific live session, instead of always following the
   * newest one. Also pins the registry so auto-follow and new-session creation stop stealing the
   * owner away. Returns false when the session is not live (already disposed, never created, or
   * a subagent), so the caller can refuse the switch.
   */
  setOwner(id: string): boolean {
    const agent = this.live.get(id);
    if (!agent) return false;
    if (this.isSubagent(agent)) return false;
    this.ownerId = id;
    this.pinned = true;
    return true;
  }

  /**
   * Auto-follow: snaps the owner to `id` when the person clearly switched tabs and spoke there,
   * or the model replied there. Silent navigation (no events from the target session) does not
   * trigger a move — this only reacts to real activity. Returns true when moved, false when the
   * session is not live, it is a subagent, or it is already the owner.
   *
   * When it *does* move, it also clears the pin. A pin was either set explicitly (pet said "hold
   * this one") or accumulated as a side effect of the pet syncing its own owner — the user's
   * active behaviour on another session is a stronger signal, so the old pin falls away. The pin
   * still protects against `agent/created` stealing, which is what it was built for.
   */
  forceOwner(id: string): boolean {
    if (id === this.ownerId) return false;
    const agent = this.live.get(id);
    if (!agent) return false;
    if (this.isSubagent(agent)) return false;
    this.pinned = false;
    this.ownerId = id;
    return true;
  }

  /** Unconditionally clears the pin; used when the pet manually unpins (future). */
  clearPin(): void {
    this.pinned = false;
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

  /**
   * All live sessions, for the pet's explicit session picker. DSH emits no event when a person
   * merely switches tabs, so auto-follow cannot see silent navigation — the picker lets the pet
   * switch the owner deliberately instead of waiting for a signal DSH never sends.
   */
  listSessions(): Array<{ id: string; cwd: string; model: string; owner: boolean; pinned: boolean; subagent: boolean }> {
    const out: Array<{ id: string; cwd: string; model: string; owner: boolean; pinned: boolean; subagent: boolean }> = [];
    for (const [id, agent] of this.live) {
      const sub = this.isSubagent(agent);
      out.push({
        id,
        cwd: String(agent.session.header?.cwd ?? ''),
        model: this.modelOf(id),
        owner: id === this.ownerId && !sub,
        pinned: this.pinned && id === this.ownerId,
        subagent: sub,
      });
    }
    return out;
  }

  /** Is this agent a subagent, so it should never be the owner? */
  isSubagent(agent: LiveAgent): boolean {
    const header = agent.session.header;
    if (!header) return false;
    if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return true;
    if (header.origin === 'subagent') return true;
    return false;
  }

  private modelOf(sessionId: string): string {
    return this.modelCache.get(sessionId) ?? '';
  }
}

/** DSH envelope: `{ type, data }` with the payload keyed by type. */
export interface SessionEventLike {
  type?: unknown;
  data?: unknown;
}

/** Active session events that indicate the person or the model is talking on this session —
 *  trigger auto-follow when they come from a non-owner, non-pinned registry. */
const ACTIVE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'turn/start',
  'turn/end',
  'tool/call',
  'approval/asked',
]);

/** Whether `event` is one of the active-event types that moves the auto-follow owner. */
export function isActiveSessionEvent(event: SessionEventLike): boolean {
  const t = event?.type;
  return typeof t === 'string' && ACTIVE_EVENT_TYPES.has(t);
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
