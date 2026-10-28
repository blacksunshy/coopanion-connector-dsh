/**
 * The pet's side of the bridge: one local WebSocket the Coopanion World connects to, and the
 * notices DSH broadcasts to it. Bound to the Host's own `webServer`, so it shares the port the
 * console already uses and nothing listens on a second one.
 *
 * A notice with no connection is dropped. DSH work does not wait for a pet, and a queue here would
 * only replay stale turns into a bubble after the person already read them on the console.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { SAY_MAX, parsePetFrame, type HostFrame, type HostAck, type PetFrame } from './protocol.ts';

/** The path the pet connects to, relative to the DSH web server's root. */
export const PET_PATH = '/coopanion/pet';

/** Protocol revision; the pet refuses a Host that speaks another one. */
export const PROTOCOL_VERSION = 1;

/** How long a connection may stay silent before the Host pings it. */
const IDLE_PING_MS = 30_000;

export interface PetHubOptions {
  /**
   * The current owning agent's facts, or null when no conversation is open yet.
   * The pet connects first and waits in a "bound = false" state until facts become available;
   * when they do, the Host sends a late `ready` frame. This lets the pet connect before any
   * conversation has been created (common on `dsh web --no-open` and other CLI paths).
   */
  welcome(): { session: string; cwd: string; model: string } | null;
  /** A person's words arrived; resolve to the refusal reason, or null when they were submitted. */
  say(text: string, from: string): Promise<string | null>;
  /** The pet asked to switch the owning session; return null to accept, or the refusal reason. */
  pick?(session: string): string | null;
  /** The pet asked for every live session, to render an explicit picker. */
  listSessions?(): { sessions: Array<{ id: string; cwd: string; model: string; owner: boolean; pinned: boolean; subagent: boolean }>; pinned: boolean };
  /** The pet asked to drop the pin so auto-follow takes over again; return null when accepted. */
  unpin?(): string | null;
  log(level: 'info' | 'warn', text: string): void;
  /** The upgrade handler of another server, when the caller owns one (tests, embedding). */
  server?: WebSocketServer;
}

export class PetHub {
  private readonly wss: WebSocketServer;
  private readonly ownsServer: boolean;
  private connection: WebSocket | null = null;
  /** True after this.connection has received its first `ready` frame. A pet in waiting state may
   *  have an open connection but has not yet been told which session to speak into. */
  private bound: boolean = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: PetHubOptions) {
    this.ownsServer = opts.server === undefined;
    this.wss = opts.server ?? new WebSocketServer({ noServer: true });
    this.timer = setInterval(() => this.ping(), IDLE_PING_MS);
    this.timer.unref?.();
  }

  get connected(): boolean {
    return this.connection !== null && this.connection.readyState === this.connection.OPEN;
  }

  /** Whether an open connection has been bound to a DSH conversation (has received `ready`). */
  get boundState(): boolean {
    return this.bound && this.connected;
  }

  /** The upgrade route `webServer.registerUpgrade` takes.
   *
   *  Always accepts the HTTP upgrade: whether a conversation exists or not, the pet gets an open
   *  socket. When no conversation exists yet it lands in waiting state and receives a late `ready`
   *  later via `notifyBound()`. */
  readonly upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  };

  /** A notice to the pet; false when nobody is listening or the pet has not yet bound to a session. */
  send(frame: HostFrame): boolean {
    if (!this.connected || !this.bound) return false;
    this.connection!.send(JSON.stringify(frame));
    return true;
  }

  /** Tells the pet the owning conversation has appeared or changed; sends `ready` if the pet is waiting. */
  notifyBound(facts: { session: string; cwd: string; model: string }): void {
    if (!this.connected) return;
    this.opts.log('info', `DSH bridge bound to session ${facts.session}`);
    this.connection!.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, ...facts } satisfies HostFrame));
    this.bound = true;
  }

  /** Tells the pet the owning conversation is gone (disposed / subagent filtered out).
   *  Resets bound so subsequent `send()` calls are dropped and the caller may re-bind later. */
  notifyUnbound(): void {
    if (!this.connected) return;
    this.bound = false;
    this.connection!.send(JSON.stringify({ t: 'error', text: 'owning conversation disposed, waiting for a new one' } satisfies HostFrame));
  }

  close(): void {
    clearInterval(this.timer);
    try {
      this.connection?.close(1001, 'host closing');
    } catch {
      // a socket already gone needs no goodbye
    }
    this.connection = null;
    for (const client of this.wss.clients) client.terminate();
    if (this.ownsServer) this.wss.close();
  }

  private accept(ws: WebSocket): void {
    this.connection?.close(4000, 'replaced');
    this.connection = ws;
    this.bound = false;
    let greeted = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parsePetFrame(data.toString());
      if (!frame) return;
      if (!greeted && frame.t !== 'hello') {
        ws.close(4001, 'hello first');
        return;
      }
      switch (frame.t) {
        case 'hello': {
          if (frame.v !== PROTOCOL_VERSION) {
            this.opts.log('warn', `pet speaks protocol ${frame.v}, this Host speaks ${PROTOCOL_VERSION}`);
            ws.close(4002, 'protocol mismatch');
            return;
          }
          greeted = true;
          const welcome = this.opts.welcome();
          if (welcome) {
            this.bound = true;
            this.opts.log('info', `Coopanion pet "${frame.name}" connected`);
            ws.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, ...welcome } satisfies HostFrame));
          } else {
            this.opts.log('info', `Coopanion pet "${frame.name}" connected, waiting for a conversation`);
            // No `ready` yet — notifyBound() will send one when the caller has facts.
          }
          return;
        }
        case 'say': {
          const text = frame.text.slice(0, SAY_MAX);
          void this.opts.say(text, frame.from).then((refusal) => {
            const ack: HostAck = refusal === null ? { t: 'accepted', id: frame.id } : { t: 'refused', id: frame.id, reason: refusal };
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ack));
          });
          return;
        }
        case 'list-sessions': {
          const list = this.opts.listSessions?.();
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(
              list
                ? { t: 'session-list', sessions: list.sessions, pinned: list.pinned } satisfies HostFrame
                : { t: 'error', text: 'this Host does not support listing sessions' } satisfies HostFrame,
            ));
          }
          return;
        }
        case 'ping':
          return;
        case 'pick': {
          // `pick` resolves `null` on acceptance, so absence must be tested explicitly: `??`
          // would turn an accepted pick into the "unsupported" refusal.
          const pick = this.opts.pick;
          const reason = pick === undefined ? 'this Host does not support session switching' : pick(frame.session);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(reason === null ? { t: 'picked', session: frame.session } : { t: 'refused', reason }));
          }
          return;
        }
        case 'unpin': {
          const unpin = this.opts.unpin;
          const reason = unpin === undefined ? 'this Host does not support unpinning' : unpin();
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(reason === null ? { t: 'unpinned' } : { t: 'refused', reason }));
          }
          return;
        }
      }
    });
    ws.on('close', () => {
      if (this.connection === ws) this.connection = null;
    });
    ws.on('error', (err: Error) => this.opts.log('warn', `pet socket error: ${err.message}`));
  }

  private ping(): void {
    if (!this.connected) return;
    try {
      this.connection!.ping();
    } catch {
      // the socket is closing; the close handler clears it
    }
  }
}

export type { PetFrame, HostFrame };
