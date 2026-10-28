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

/** Host→pet frames. `v` is the protocol revision, so a pet from another release can refuse. */
export type HostFrame =
  /** Sent once per connection, before any other frame. */
  | { t: 'ready'; v: number; session: string; cwd: string; model: string }
  /** A turn began: the pet switches to its working face. */
  | { t: 'turn-start'; turn: number }
  /** A turn ended. `reason` is DSH's own wording for why. */
  | { t: 'turn-end'; turn: number; reason: string }
  /** One finished reply of the assistant, already rendered to plain text. */
  | { t: 'reply'; turn: number; text: string }
  /** A tool the assistant began calling; `detail` names its parameters, never their values. */
  | { t: 'tool'; name: string; detail: string }
  /** DSH is waiting for the person to approve a tool call. */
  | { t: 'approval'; name: string; reason: string }
  /** DSH is waiting for the person to answer a question. */
  | { t: 'question'; text: string }
  /** The turn ended badly. */
  | { t: 'error'; text: string }
  /** Answers a `new`: the Host created this session and now owns it. */
  | { t: 'created'; id: string; session: string }
  /**
   * Generic one-shot announcement the Host wants the pet to surface.
   * `kind` groups them (e.g. "update-available") so a pet can pick which to show;
   * `text` is always safe to render; `url` is optional action destination.
   * Frames of unknown `kind` should be silently dropped — Host may add more.
   */
  | { t: 'notice'; kind: string; text: string; url?: string };

/** Pet→Host frames. */
export type PetFrame =
  /** Must arrive first; a connection that sends anything else is closed. */
  | { t: 'hello'; v: number; name: string }
  /** A person's words, submitted to the owning agent. `id` is echoed in `accepted`/`refused`. */
  | { t: 'say'; id: string; text: string; from: string }
  /**
   * Switch the conversation the pet speaks into. The newest live session is the default; a person
   * may point the pet at another open session (for example after archiving the current one). The
   * Host refuses a session that is not live with a `refused` frame.
   */
  | { t: 'pick'; session: string }
  /**
   * Start a new conversation on the DSH side and make it the owner, so the pet has somewhere to
   * speak when every session it knew has been archived. `id` is echoed in `created`/`refused`.
   */
  | { t: 'new'; id: string }
  | { t: 'ping' };

/** Host→pet answers to a `say`. */
export type HostAck = { t: 'accepted'; id: string } | { t: 'refused'; id: string; reason: string };

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
      return { t: 'say', id: frame.id.slice(0, 64), text: frame.text, from: from.slice(0, 64) };
    }
    case 'ping':
      return { t: 'ping' };
    case 'pick':
      if (typeof frame.session !== 'string' || !frame.session) return null;
      return { t: 'pick', session: frame.session.slice(0, 128) };
    case 'new':
      if (typeof frame.id !== 'string' || !frame.id) return null;
      return { t: 'new', id: frame.id.slice(0, 64) };
    default:
      return null;
  }
}

/** Longest `say` text this plugin submits; a runaway pet must not fill a session with one frame. */
export const SAY_MAX = 4000;

/** Longest one line of assistant text forwarded to the pet. */
export const REPLY_MAX = 2000;

/**
 * The name this Host speaks under, and the line it writes into DSH.
 *
 * A local customisation on this machine (see `~/.dsh/AGENTS.md`): the Mac host is 麦麦 and the
 * Windows host is 墨墨, so both DSH and the pet call the same thing by the same name.
 * `COOPANION_HOST_NAME` overrides it for a host that wants another name.
 */
const HOST_NAME_ENV = 'COOPANION_HOST_NAME';
const PLATFORM_NAMES: Record<string, string> = { win32: '墨墨', darwin: '麦麦' };

/** The name this Host's lines are attributed to. */
export function speakerName(from: string | null, platform = process.platform, env = process.env): string {
  const configured = env[HOST_NAME_ENV]?.trim();
  if (configured) return configured.slice(0, 64);
  const named = PLATFORM_NAMES[platform];
  if (named) return named;
  return (from ?? '').trim().slice(0, 64) || '桌宠';
}

/** One line for DSH, attributed to this Host's name. */
export function bridgeLine(text: string, name: string): string {
  return `${name}说：${text}`;
}

/**
 * Prefixes this Host writes on a line it submits for the pet, plus the legacy 0.2.x form
 * `${from}（通过桌宠）说：` that earlier lines in old sessions still carry.
 *
 * The name part is letters, digits, spaces, hyphens and underscores, so a person's line that
 * merely quotes a prefix further in is not mistaken for one of ours. A pet that writes a prefix
 * itself has a second one wrapped around its text, and each hand-over would add another.
 */
const LEGACY_BRIDGE_PREFIX = /^[\p{L}\p{N}_\- ]{1,64}（通过桌宠）说：/u;

/** The names whose `说：` line counts as this Host's own prefix. */
function bridgeSignatures(env = process.env): string[] {
  const names = new Set(Object.values(PLATFORM_NAMES));
  const configured = env[HOST_NAME_ENV]?.trim();
  if (configured) names.add(configured);
  return [...names];
}

/** True when `text` already carries this Host's prefix, so submitting it would nest a second one. */
export function carriesBridgePrefix(text: string, env = process.env): boolean {
  const line = text.trim();
  if (LEGACY_BRIDGE_PREFIX.test(line)) return true;
  return bridgeSignatures(env).some((name) => line.startsWith(`${name}说：`));
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
