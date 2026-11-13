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

/**
 * A conversation DSH reports as existing while this process holds no Agent for it.
 *
 * DSH's own session list calls these rows cold: they are on disk, they carry a title and a
 * directory in the sidebar, and opening one loads it. The bridge keeps them out of the live map
 * because there is nothing to submit a message to until DSH attaches an Agent — but it still
 * *lists* them, because a pet that can only see the two conversations this process happened to
 * resume cannot tell "the bug-fix conversation" from "the one about the other repo", and a name it
 * cannot read is a name it cannot check itself against before speaking.
 *
 * Not listing them was the second half of the wrong-session bug: the sidebar showed sixteen
 * conversations and the pet was offered two, so every session it knew about was a guess's worth of
 * stale.
 */
export interface ListedSession {
  cwd: string;
  title: string;
  running: boolean;
}

/** One row of the list the pet is handed: a conversation it can aim at. */
export interface SessionRow {
  id: string;
  cwd: string;
  model: string;
  title: string;
  running: boolean;
  owner: boolean;
  pinned: boolean;
  subagent: boolean;
  /**
   * True when DSH lists this conversation but this process holds no Agent for it yet.
   *
   * Nothing about the pet's behaviour changes — a `say` aimed here still gets delivered, because
   * the Host attaches an Agent on demand. It is reported so a reader (and a bug report) can tell
   * "the sidebar's sixteen" from "the two this process happens to hold".
   *
   * Present only on cold rows: absent on a live one is not a claim, it is the shape every older
   * Host answers with, and a reader must not have to tell "false" from "unreported".
   */
  cold?: boolean;
}

/** DSH's session header: where cwd and subagent flags actually live. */
interface SessionHeader {
  cwd?: string;
  parentSession?: string;
  origin?: string;
}

/** One live agent, as much of it as this plugin touches. */
export interface LiveAgent {
  session: {
    id?: string;
    header?: SessionHeader;
    /** The routed model's capacity, when DSH exposes one for this session. */
    requestContext?(): { contextWindow?: number } | undefined;
    /**
     * Every event of this session so far, oldest first. DSH keeps the title in the log (one
     * `session/title` event, appended when the first message names the conversation), not in the
     * header, so reading it means folding the log — the same thing DSH's own title service does.
     */
    snapshotEvents?(): Array<{ type?: unknown; data?: unknown }>;
  };
  /**
   * DSH's own liveness flag: `'idle' | 'running'`, read straight off the Agent.
   *
   * This is the authoritative answer to "is this conversation working right now", and it needs no
   * event subscription — it is a property, so reading it at `listSessions()` time is always current.
   * Declared loosely (`unknown`) because it is not part of this plugin's typed Host surface, and a
   * Host that does not expose it must fall back instead of throwing.
   */
  status?: unknown;
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
  /**
   * title 按 session 缓存。标题在日志里，折叠它要扫完整个会话的 events（长会话数千条），
   * 而 `listSessions()` 会在每次 owner 变化与每次桌宠问清单时被调用，所以只在第一次折叠，
   * 之后靠 `session/title` 事件增量更新（见 `rememberTitle`）。
   */
  private readonly titleCache = new Map<string, string>();
  /**
   * Whether a turn is open, for the Hosts where `agent.status` cannot be read.
   *
   * DSH is the authority when it answers (`agent.status`), so this map is only consulted as a
   * fallback: it is maintained from the `turn/start` / `turn/end` events this plugin already sees,
   * which is exactly the "is a turn running" question the pet asks. Kept per session and deleted on
   * `remove`, so a disposed conversation cannot leave a stale "running" behind.
   */
  private readonly openTurn = new Set<string>();
  /**
   * Conversations DSH lists but this process holds no Agent for (see `ListedSession`).
   *
   * Kept beside the live map rather than in it, so nothing that asks "who is the owner" or "can we
   * deliver to this id" can pick one by accident: a listed row is a name to show the pet, not a
   * mouth to speak into. `add()` clears the entry, so a row that later gets an Agent keeps exactly
   * one identity in `listSessions()`.
   */
  private readonly listed = new Map<string, ListedSession>();
  private ownerId: string | null = null;
  /** True after the pet's explicit `pick` — auto-follow and new-session creation stop stealing. */
  private pinned: boolean = false;
  /**
   * Whether DSH has archived a session. An archived Session stays live but refuses every model
   * step, so words submitted there end as `blocked` instead of being answered: the bridge must not
   * offer one to the pet as somewhere to speak.
   */
  private archived: (id: string) => boolean = () => false;
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

  /** The archive set as DSH owns it; read at each decision, since archiving happens while we run. */
  setArchivedCheck(check: (id: string) => boolean): void {
    this.archived = check;
  }

  /**
   * A new agent appeared. Subagents join the live map but do not steal the owner from an
   * unpinned non-subagent. An unpinned registry still points at the newest non-subagent; a
   * pinned one stays put.
   */
  add(id: string, agent: LiveAgent): void {
    this.live.set(id, agent);
    // A row that just gained an Agent stops being a listed name: one conversation, one identity.
    this.listed.delete(id);
    if (this.isSubagent(agent)) return;
    if (!this.pinned && !this.archived(id)) this.ownerId = id;
  }

  remove(id: string): void {
    this.live.delete(id);
    this.modelCache.delete(id);
    this.openTurn.delete(id);
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
    if (this.ownerId !== null) {
      const current = this.live.get(this.ownerId);
      if (current && !this.isSubagent(current) && !this.archived(this.ownerId)) return current;
    }
    // The owner was archived or disposed since it was chosen. A conversation the person can still
    // type into is a better answer than none, so take the newest one that is still open.
    for (const [id, agent] of [...this.live.entries()].reverse()) {
      if (!this.isSubagent(agent) && !this.archived(id)) return agent;
    }
    return null;
  }

  get ownerSession(): string | null {
    const agent = this.owner;
    return agent === null ? null : String(agent.session.id ?? '') || this.ownerId;
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
   * Replace the set of conversations DSH lists without this process holding an Agent for them.
   *
   * The whole set is replaced, never merged: a conversation that DSH stopped listing (archived,
   * deleted, or never really there) must disappear from the pet's menu in the same call, or the pet
   * keeps offering a name nobody can open. Rows that do have a live Agent are dropped here, so
   * `listSessions()` can concatenate the two sources without duplicates.
   */
  noteListed(rows: Iterable<{ id: string; cwd?: string; title?: string; running?: boolean }>): number {
    this.listed.clear();
    let kept = 0;
    for (const row of rows) {
      const id = String(row.id ?? '');
      if (!id || this.live.has(id) || this.archived(id)) continue;
      this.listed.set(id, {
        cwd: String(row.cwd ?? ''),
        title: String(row.title ?? ''),
        running: row.running === true,
      });
      kept++;
    }
    return kept;
  }

  /** How many listed-but-not-live conversations the registry is holding — for the bridge log. */
  get listedSize(): number {
    return this.listed.size;
  }

  /**
   * Add or refresh one listed conversation, from a Host event that names it.
   *
   * DSH announces a conversation becoming visible (`api-session/added`) with its whole summary, so
   * this keeps the pet's menu current without re-reading the entire list. A row that has a live
   * Agent here, or is archived, is ignored — it is not a listed row by definition.
   */
  noteListedOne(id: string, row: { cwd?: string; title?: string; running?: boolean }): boolean {
    if (!id || this.live.has(id) || this.archived(id)) return false;
    this.listed.set(id, {
      cwd: String(row.cwd ?? ''),
      title: String(row.title ?? ''),
      running: row.running === true,
    });
    return true;
  }

  /** Forget a listed conversation DSH says is gone. Answers whether it was being held. */
  forgetListed(id: string): boolean {
    return this.listed.delete(id);
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
    if (this.archived(id)) return false;
    this.ownerId = id;
    this.pinned = true;
    return true;
  }

  /**
   * Auto-follow: snaps the owner to `id` because **the person** acted there (`isPersonActionEvent`
   * is the only caller's gate). The model working on a session never calls this. Returns true when
   * moved, false when the session is not live, it is a subagent, or it is already the owner.
   *
   * When it does move, it also clears the pin. A pin was set either explicitly (the pet named this
   * conversation) or as a side effect of syncing the pet's own owner — the person speaking
   * elsewhere right now is a stronger signal about where the person is looking, so the old pin
   * falls away and the pet follows. The pin still protects against `agent/created` stealing and
   * against the model's own output, which is what it is for.
   */
  forceOwner(id: string): boolean {
    if (id === this.ownerId) return false;
    const agent = this.live.get(id);
    if (!agent) return false;
    if (this.isSubagent(agent)) return false;
    if (this.archived(id)) return false;
    this.pinned = false;
    this.ownerId = id;
    return true;
  }

  /** Unconditionally clears the pin; used when the pet manually unpins. */
  clearPin(): void {
    this.pinned = false;
  }

  /** 记录某会话最近一次 request/header 里看到的模型名。 */
  rememberModel(id: string, model: string): void {
    if (model) this.modelCache.set(id, model);
  }

  /**
   * 记录某会话的标题。DSH 追加 `session/title` 时调用；长度为零视为"还没起名"，
   * 于是丢掉缓存，下次 `listSessions()` 重新折叠日志——会话刚建好时正是这个状态。
   */
  rememberTitle(id: string, title: string): void {
    if (title) this.titleCache.set(id, title);
    else this.titleCache.delete(id);
  }

  /**
   * 会话的标题，没起名时给空串。
   *
   * 标题不在 header 里，而在日志的事件里：DSH 只在第一条用户消息之后追加一条
   * `session/title`，所以这里折叠日志取最后一条（等价于 DSH 自己的 `foldSessionTitle`）。
   * 折叠结果按 session 缓存，之后由 `rememberTitle` 增量更新。
   */
  private titleOf(sessionId: string): string {
    const cached = this.titleCache.get(sessionId);
    if (cached !== undefined) return cached;
    const events = this.live.get(sessionId)?.session.snapshotEvents?.() ?? [];
    let title = '';
    for (const event of events) {
      if (event?.type !== 'session/title') continue;
      const data = event.data as { title?: unknown } | undefined;
      if (typeof data?.title === 'string') title = data.title;
    }
    this.titleCache.set(sessionId, title);
    return title;
  }

  /**
   * Tracks `turn/start` / `turn/end` for the fallback answer to "is this conversation working".
   *
   * Only used when `agent.status` is unavailable, but it is recorded unconditionally: the fallback
   * has to be correct the first time it is asked, and by then the turn may already be running.
   */
  noteTurnEvent(id: string, event: SessionEventLike): void {
    if (event?.type === 'turn/start') this.openTurn.add(id);
    else if (event?.type === 'turn/end') this.openTurn.delete(id);
  }

  /**
   * Whether this conversation is working right now.
   *
   * DSH's `agent.status` wins when it is readable; otherwise the turn listener's own view stands in.
   * Deliberately never throws: an unreadable status must cost a field, not the whole session list.
   */
  private runningOf(id: string, agent: LiveAgent): boolean {
    const status = (agent as { status?: unknown }).status;
    if (status === 'running') return true;
    if (status === 'idle') return false;
    return this.openTurn.has(id);
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
   *
   * Archived sessions are excluded: one stays live but refuses every model step, so words
   * submitted there end as `blocked` instead of being answered.
   */
  listSessions(): SessionRow[] {
    const out: SessionRow[] = [];
    for (const [id, agent] of this.live) {
      if (this.archived(id)) continue;
      const sub = this.isSubagent(agent);
      out.push({
        id,
        cwd: String(agent.session.header?.cwd ?? ''),
        model: this.modelOf(id),
        // 没有标题的老会话给空串：桌宠据此知道"这条还没起名"，而不是"不认识它"。
        title: this.titleOf(id),
        // 有没有在跑轮次：桌宠据此知道"它是正在忙"还是"它没理我"，也据此决定要不要再等。
        running: this.runningOf(id, agent),
        owner: id === this.ownerId && !sub,
        pinned: this.pinned && id === this.ownerId,
        subagent: sub,
      });
    }
    // Then the conversations DSH lists but this process holds no Agent for. They come last so the
    // live ones stay in the order the pet has been reading them, and they never claim the owner:
    // a row nobody can deliver into must not look like the default target.
    for (const [id, row] of this.listed) {
      if (this.live.has(id) || this.archived(id)) continue;
      out.push({
        id,
        cwd: row.cwd,
        model: this.modelOf(id),
        title: row.title,
        running: row.running,
        owner: false,
        pinned: false,
        subagent: false,
        cold: true,
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

/**
 * The events that mean **the person** acted on a session — and therefore that they are looking at
 * it right now, which is the only thing allowed to move the auto-follow owner.
 *
 * `assistant/message`, `turn/start`, `turn/end` and `tool/call` deliberately are *not* here. They
 * are the model working, and a model works wherever a line was handed to it: a pet that pinned a
 * conversation lost that pin the moment the agent replied anywhere else, and a conversation nobody
 * had touched grabbed the owner just by finishing a turn. A pet then announced the wrong
 * "a line lands here by default" and the person's next line went to the wrong window — the exact
 * failure this module exists to prevent. Speech is the person's signal; the model's own output is
 * not evidence about where the person is looking.
 */
const PERSON_ACTION_EVENT_TYPES = new Set<string>([
  'user/message',
  // DSH appends this pair around a permission request: `approval/asked` when it asks, and
  // `approval/decided` when the answer is written. Only a person answers, so it is a person's mark
  // on the conversation even though the dsh app records it.
  'approval/decided',
]);

/** Whether `event` is a person action on this session, which may move the auto-follow owner. */
export function isPersonActionEvent(event: SessionEventLike): boolean {
  const t = event?.type;
  return typeof t === 'string' && PERSON_ACTION_EVENT_TYPES.has(t);
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
