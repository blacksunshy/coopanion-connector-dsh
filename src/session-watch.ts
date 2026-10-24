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

/** One live agent, as much of it as this plugin touches. */
export interface LiveAgent {
  session: { id?: string; cwd?: string; parent?: unknown };
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
  private ownerId: string | null = null;

  /** Keyed by session id, which is what `agent/created` and `session/disposed` agree on. */
  add(id: string, agent: LiveAgent): void {
    this.live.set(id, agent);
    this.ownerId = id;
  }

  remove(id: string): void {
    this.live.delete(id);
    if (this.ownerId === id) this.ownerId = [...this.live.keys()].at(-1) ?? null;
  }

  get owner(): LiveAgent | null {
    return this.ownerId === null ? null : this.live.get(this.ownerId) ?? null;
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
    if (!this.live.has(id)) return false;
    this.ownerId = id;
    return true;
  }

  /** What the pet is told on connect; null when no conversation is open yet. */
  facts(): AgentFacts | null {
    const agent = this.owner;
    if (!agent) return null;
    if (agent.session.parent) return null;
    return {
      session: String(agent.session.id ?? ''),
      cwd: String(agent.session.cwd ?? ''),
      model: this.modelOf(agent),
    };
  }

  private modelOf(agent: LiveAgent): string {
    const model = (agent as { model?: unknown }).model;
    if (typeof model === 'string') return model;
    const source = (agent as { source?: { model?: unknown } }).source;
    return typeof source?.model === 'string' ? source.model : '';
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
