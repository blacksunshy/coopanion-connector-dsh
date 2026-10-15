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
  /** Called once per accepted connection, before it is used. Return null to refuse. */
  welcome(): { session: string; cwd: string; model: string } | null;
  /** A person's words arrived; resolve to the refusal reason, or null when they were submitted. */
  say(text: string, from: string): Promise<string | null>;
  log(level: 'info' | 'warn', text: string): void;
  /** The upgrade handler of another server, when the caller owns one (tests, embedding). */
  server?: WebSocketServer;
}

export class PetHub {
  private readonly wss: WebSocketServer;
  private readonly ownsServer: boolean;
  private connection: WebSocket | null = null;
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

  /** The upgrade route `webServer.registerUpgrade` takes. */
  readonly upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // A refusal answers the handshake, so the pet learns why instead of seeing a reset socket.
    if (!this.opts.welcome()) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  };

  /** A notice to the pet; false when nobody is listening. */
  send(frame: HostFrame): boolean {
    if (!this.connected) return false;
    this.connection!.send(JSON.stringify(frame));
    return true;
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
          if (!welcome) {
            ws.close(4003, 'no session');
            return;
          }
          this.opts.log('info', `Coopanion pet "${frame.name}" connected`);
          ws.send(JSON.stringify({ t: 'ready', v: PROTOCOL_VERSION, ...welcome } satisfies HostFrame));
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
        case 'ping':
          return;
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
