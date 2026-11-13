/**
 * The wire between this DSH Host plugin and the Coopanion World that watches it
 * (`packages/cortico-world-fatfish`). Frames are one JSON object per WebSocket text message.
 *
 * Direction decides cadence. Host→pet frames are notices: DSH work moves on whether or not the
 * pet is listening, so a frame with no connection is dropped, never queued. Pet→Host frames carry
 * a person's words: they become one `user/message` on the owning agent through `agent.followup`,
 * which is why they are labelled with the name of the person they came from.
 *
 * The shapes here are the contract both sides compile against; the Coopanion World keeps its own
 * copy of the same literals because the two packages ship separately.
 */

/**
 * One live conversation as the pet sees it — in `session-list`, and in the snapshot a refusal
 * carries so the pet can correct itself without a second round trip.
 *
 * `owner` marks the conversation a `say` without an explicit target would land in right now;
 * `pinned` marks the one an explicit `pick` is holding. Archived sessions never appear here:
 * they stay live but refuse every model step, so words sent to one end as `blocked`.
 */
export interface SessionSummary {
  id: string;
  cwd: string;
  model: string;
  /**
   * The conversation's title, as the person sees it in DSH's sidebar.
   *
   * A pet that can only read an id and a directory cannot tell "the bug-fix conversation" from
   * "the one about the other repo", so it guesses — and a guess is how a line lands in the wrong
   * window. The title is what the person themselves uses to recognise a conversation.
   *
   * Empty for a conversation nobody has spoken in yet (DSH titles a log from its first user
   * message), so a reader must treat '' as "untitled", not as "no title support".
   */
  title?: string;
  /**
   * Whether this conversation is working right now — a turn is open and the model is still going.
   *
   * A pet that cannot see this reads "no answer yet" as "the person is ignoring me" and sends the
   * same thing again, or speaks into a busy conversation believing it is idle. DSH exposes it as
   * `agent.status` (`'idle' | 'running'`); when that is unavailable the bridge falls back to the
   * turn boundaries it saw, so a reader gets a plain boolean either way.
   *
   * Absent means the Host does not report it (anything older than 0.2.23) — *not* idle.
   */
  running?: boolean;
  /**
   * True when DSH knows this conversation but this Host process holds no Agent for it yet.
   *
   * These are the conversations the sidebar shows for a project you have not opened since DSH
   * started: real, named, and openable — DSH attaches an Agent the moment one is spoken into. A pet
   * that never sees them can only aim at whatever happens to be resumed, which is how a line lands
   * in a conversation the person was not looking at.
   *
   * Absent means the Host does not report it (anything older than 0.2.24) — *not* "live".
   */
  cold?: boolean;
  owner: boolean;
  pinned: boolean;
  subagent: boolean;
}

/**
 * Why the Host would not take a `say`, in a form a pet can branch on.
 *
 * `reason` stays the human sentence it always was; `code` is the machine answer, so a pet can
 * retry (`stale-session` → re-list and pick), create a conversation (`no-session`) or stop
 * (`forwarding-off`) without parsing English.
 */
export type RefusalCode =
  /** The text was blank once trimmed. */
  | 'empty'
  /** The line already carries this Host's `… （通过桌宠）说：` prefix; submitting it would nest another. */
  | 'nested-prefix'
  /** Auto-forward is switched off; the person turned it off deliberately. */
  | 'forwarding-off'
  /** No conversation is open, so the pet must create one before it can speak. */
  | 'no-session'
  /** The named conversation is gone, archived, or a subagent; re-list and pick again. */
  | 'stale-session'
  /** The owning agent cannot accept a message on this DSH build. */
  | 'cannot-deliver'
  /** DSH itself threw while queuing the message. */
  | 'host-error';

/** A refusal a `say` may produce: the human sentence, plus what a pet needs to recover. */
export interface SayRefusal {
  reason: string;
  code?: RefusalCode;
  /** The conversation the words would have landed in, when the Host knew one. */
  session?: string | null;
  /** Every live conversation at the moment of the refusal, so a pet can re-pick in one click. */
  sessions?: SessionSummary[];
  pinned?: boolean;
}

/** What a `say` settled to: delivered, refused, or — from an older Host — a bare reason string. */
export type SayOutcome = string | SayRefusal | null;

/**
 * How a pet decides where its next line goes. This is the contract the fields above exist for;
 * every step is answerable from frames the Host already sends.
 *
 * DSH has no "focused conversation" signal. A person switching tabs emits no `session/event`, so
 * neither side can observe a silent switch: the owner an idle Host holds is a guess that can be
 * hours stale. A pet that simply speaks into its local aim will therefore, sooner or later, drop a
 * line into whichever conversation DSH happened to touch last. The fix is to make the target
 * explicit and check it at the moment of speaking, not at the moment of aiming.
 *
 * Before each `say`:
 *   1. Use the list already in hand — the `sessions` on the last `ready`, on the last pushed
 *      `session-list`, or on the last ack. The Host pushes one on every open and every dispose, so
 *      it is current unless a push was missed while disconnected.
 *   2. If the conversation you mean is in that list, send `session: <its id>`. The Host re-checks it
 *      against the live list and refuses rather than re-routing, so a wrong aim is visible, not
 *      silent.
 *   3. If the list is empty, or the conversation you mean is gone, do not send a bare `say`
 *      expecting a fallback: send `new` and let `created` tell you where to speak. This is the
 *      "should I start a conversation?" decision — the answer is yes exactly when the list has no
 *      entry you can point at.
 *   4. If you are unsure, send `list-sessions` first; it is one round trip, and its `owner` is the
 *      conversation a targetless `say` would currently land in.
 *
 * After the ack:
 *   - `accepted` repeats the conversation that took the words. Show that to the person, so a
 *     misroute is caught by the reader who knows where the line belongs.
 *   - `refused` with `stale-session` → re-pick from the `sessions` it carries (don't re-send blind).
 *   - `refused` with `no-session` → `new`.
 *   - `refused` with `forwarding-off` → stop; the person turned forwarding off on purpose.
 *   - no ack at all → the Host is gone; do not retry into a fresh connection without re-listing.
 */

/** Host→pet frames. `v` is the protocol revision, so a pet from another release can refuse. */
export type HostFrame =
  /**
   * Sent once per connection, before any other frame — and again whenever the owning conversation
   * changes. `session` is where words land *now*; `sessions` is every open conversation, so a pet
   * can show the person where it is speaking and let them correct it without asking first.
   */
  | {
      t: 'ready';
      v: number;
      session: string;
      cwd: string;
      model: string;
      sessions?: SessionSummary[];
      pinned?: boolean;
    }
  /** A turn began: the pet switches to its working face. */
  | { t: 'turn-start'; turn: number }
  /** A turn ended. `reason` is DSH's own wording for why. `used`/`size` are the routed model's
   *  context spend and capacity when DSH can report both; absent otherwise (old Hosts never set them). */
  | { t: 'turn-end'; turn: number; reason: string; used?: number; size?: number }
  /** One finished reply of the assistant, already rendered to plain text. */
  | { t: 'reply'; turn: number; text: string }
  /** A tool the assistant began calling; `detail` names its parameters, never their values. */
  | { t: 'tool'; name: string; detail: string }
  /** DSH is waiting for the person to approve a tool call. */
  | { t: 'approval'; name: string; reason: string }
  /** DSH is waiting for the person to answer a question. `callId` keys the matching `question-end`. */
  | { t: 'question'; text: string; callId?: string }
  /** The question above was answered, skipped or timed out; stop reminding. */
  | { t: 'question-end'; callId: string }
  /** The turn ended badly. */
  | { t: 'error'; text: string }
  /**
   * Answers a `new`: the Host created this session and now owns it.
   *
   * `workspace` is the path of the workspace the conversation actually landed in. A pet that asked
   * for a specific one must compare: a Host from before this field ignores the request and would
   * otherwise report success for a conversation started in the wrong project.
   */
  | { t: 'created'; id: string; session: string; workspace?: string }
  /**
   * Generic one-shot announcement the Host wants the pet to surface.
   * `kind` groups them (e.g. "update-available") so a pet can pick which to show;
   * `text` is always safe to render; `url` is optional action destination.
   * Frames of unknown `kind` should be silently dropped — Host may add more.
   */
  | { t: 'notice'; kind: string; text: string; url?: string }
  /** Answer to `list-sessions`: every live session with its owner/pin state. */
  | {
      t: 'session-list';
      sessions: SessionSummary[];
      pinned: boolean;
      /**
       * The conversation a `say` without an explicit target would land in, or null when none is
       * open. Repeated at top level because it is the one field a pet checks before every line.
       */
      owner?: string | null;
    }
  /** Answer to `unpin`: the pin is gone, auto-follow may move the owner again. */
  | { t: 'unpinned' }
  /**
   * Answer to `list-workspaces`: the projects a `new` may target, so the pet can name one instead
   * of guessing a path. `sessions` counts the ones currently open (archived ones excluded).
   */
  | { t: 'workspace-list'; workspaces: Array<{ id: string; path: string; sessions: number; owner: boolean }> };

/** Pet→Host frames. */
export type PetFrame =
  /** Must arrive first; a connection that sends anything else is closed. */
  | { t: 'hello'; v: number; name: string }
  /**
   * A person's words, submitted to the owning agent. `id` is echoed in `accepted`/`refused`.
   *
   * `session` names the conversation they belong to. A pet that omits it keeps the old behaviour
   * (the Host's current owner, whatever that is); a pet that sends it gets an explicit target,
   * which is the only way to be sure when several conversations are open — DSH emits no event on
   * a silent tab switch, so the owner the Host guessed can be stale by the time words arrive.
   * The Host re-checks the named session against its live list on every `say` and refuses a stale
   * one with `code: 'stale-session'` plus the current list, instead of quietly delivering into
   * the wrong conversation.
   */
  | { t: 'say'; id: string; text: string; from: string; session?: string }
  /**
   * Switch the conversation the pet speaks into. The newest live session is the default; a person
   * may point the pet at another open session (for example after archiving the current one). The
   * Host refuses a session that is not live with a `refused` frame.
   */
  | { t: 'pick'; session: string }
  /**
   * Start a new conversation on the DSH side and make it the owner, so the pet has somewhere to
   * speak when every session it knew has been archived. `id` is echoed in `created`/`refused`.
   *
   * `workspace` names the project the conversation belongs in: a workspace id, or its path (the
   * form a person is more likely to say out loud). Without it the Host keeps its own preference —
   * the owning session's workspace, then the last directory it saw, then the first workspace.
   */
  | { t: 'new'; id: string; workspace?: string }
  /** Ask for every live session, so the pet can offer an explicit picker (DSH emits no event on
   *  silent tab switches, so auto-follow alone cannot see them). */
  | { t: 'list-sessions' }
  /** Ask which workspaces a `new` may target, so the pet can offer them instead of guessing a path. */
  | { t: 'list-workspaces' }
  /** Drop the pin so the Host's own auto-follow picks the owner again. */
  | { t: 'unpin' }
  | { t: 'ping' };

/**
 * Host→pet answers to a `say`.
 *
 * `accepted` echoes which conversation the words actually went into (`session`) and how many were
 * open when they did (`sessions`), so a pet can tell a person exactly where its line landed instead
 * of assuming. `refused` carries the same snapshot plus a `code`, so the pet can recover: re-list
 * and pick for `stale-session`, create a conversation for `no-session`.
 *
 * Older Hosts send the same two tags with only `id` (and `reason`), which is why every added field
 * is optional.
 */
export type HostAck =
  | { t: 'accepted'; id: string; session?: string; sessions?: SessionSummary[]; pinned?: boolean }
  | {
      t: 'refused';
      id: string;
      reason: string;
      code?: RefusalCode;
      session?: string | null;
      sessions?: SessionSummary[];
      pinned?: boolean;
    };

/** One of the frames this plugin understands; anything else is ignored. */
export function parsePetFrame(raw: string): PetFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.t) {
    case 'hello':
      if (typeof frame.v !== 'number' || typeof frame.name !== 'string') return null;
      return { t: 'hello', v: frame.v, name: frame.name.slice(0, 64) };
    case 'say': {
      if (typeof frame.id !== 'string' || typeof frame.text !== 'string') return null;
      const from = typeof frame.from === 'string' && frame.from.trim() ? frame.from : 'the pet';
      // A pet from before this field keeps working: no target means "the Host's owner", exactly
      // the old contract. A pet that sends one is taken at its word and checked by the caller.
      const session = typeof frame.session === 'string' && frame.session.trim()
        ? frame.session.trim().slice(0, 128)
        : undefined;
      return { t: 'say', id: frame.id.slice(0, 64), text: frame.text, from: from.slice(0, 64), session };
    }
    case 'ping':
      return { t: 'ping' };
    case 'pick':
      if (typeof frame.session !== 'string' || !frame.session) return null;
      return { t: 'pick', session: frame.session.slice(0, 128) };
    case 'new': {
      if (typeof frame.id !== 'string' || !frame.id) return null;
      const workspace = typeof frame.workspace === 'string' && frame.workspace.trim()
        ? frame.workspace.trim().slice(0, 512)
        : undefined;
      return { t: 'new', id: frame.id.slice(0, 64), workspace };
    }
    case 'list-sessions':
      return { t: 'list-sessions' };
    case 'list-workspaces':
      return { t: 'list-workspaces' };
    case 'unpin':
      return { t: 'unpin' };
    default:
      return null;
  }
}

/** Longest `say` text this plugin submits; a runaway pet must not fill a session with one frame. */
export const SAY_MAX = 4000;

/** Longest one line of assistant text forwarded to the pet. */
export const REPLY_MAX = 2000;

/**
 * The prefix this Host writes on a line it submits for the pet: `${from}（通过桌宠）说：`.
 *
 * The name part is letters, digits, spaces, hyphens and underscores, so a person's line that
 * merely quotes the prefix further in is not mistaken for one of ours. A pet that writes the
 * prefix itself has a second one wrapped around its text, and each hand-over would add another.
 */
const BRIDGE_PREFIX = /^[\p{L}\p{N}_\- ]{1,64}（通过桌宠）说：/u;

/** True when `text` already carries this Host's prefix, so submitting it would nest a second one. */
export function carriesBridgePrefix(text: string): boolean {
  return BRIDGE_PREFIX.test(text.trim());
}

/**
 * The plain text of an assistant message, or null when it carries none.
 *
 * `content` is an array whose text parts are the only thing a bubble can show; tool calls and
 * attachments in the same message are the pet's business only through `tool` frames.
 */
export function assistantText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
  }
  if (parts.length === 0) return null;
  const text = parts.join('\n\n');
  return text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}…` : text;
}

/** The first question's text from an `ask_user_question` call's argument JSON, or ''. */
export function questionTextOf(args: unknown): string {
  if (typeof args !== 'string') return '';
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return '';
  const first = questions[0] as { question?: unknown };
  const text = typeof first?.question === 'string' ? first.question.trim() : '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * The parameter names of one tool call, and never their values.
 *
 * A call can carry a secret — a token, a password, a signing key — and what reaches the pet reaches
 * a model's context and a stored event stream, where it cannot be taken back. The names are enough
 * for the bot to judge whether the call deserves a bubble. Arguments this cannot read as one object
 * of named parameters yield nothing rather than a fragment of their text.
 */
export function argumentNames(args: unknown): string {
  if (typeof args !== 'string') return '';
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '';
  return Object.keys(value as Record<string, unknown>).slice(0, 8).join(', ');
}

/** DSH's reason object as one short line, for a bubble that has room for one. */
export function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (typeof reason !== 'object' || reason === null) return 'completed';
  const r = reason as { kind?: unknown; message?: unknown; reason?: unknown };
  const kind = typeof r.kind === 'string' ? r.kind : 'completed';
  if (typeof r.message === 'string' && r.message) return `${kind}: ${r.message}`;
  if (typeof r.reason === 'string' && r.reason) return `${kind}: ${r.reason}`;
  if (typeof r.reason === 'object' && r.reason !== null && typeof (r.reason as { reason?: unknown }).reason === 'string') {
    return `${kind}: ${(r.reason as { reason: string }).reason}`;
  }
  return kind;
}
