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
  | { t: 'error'; text: string };

/** Pet→Host frames. */
export type PetFrame =
  /** Must arrive first; a connection that sends anything else is closed. */
  | { t: 'hello'; v: number; name: string }
  /** A person's words, submitted to the owning agent. `id` is echoed in `accepted`/`refused`. */
  | { t: 'say'; id: string; text: string; from: string }
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
