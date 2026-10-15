/**
 * The Host half's contract: what a pet may send, what it is told, and which frames are refused.
 * These run against a real socket and a real `ws` server on a loopback port — the negotiation this
 * plugin depends on is the one being tested, so a stub would test nothing.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PET_PATH, PROTOCOL_VERSION, PetHub, type PetHubOptions } from '../src/pet-hub.ts';

const open: Array<{ hub: PetHub; http: Server; wss: WebSocketServer; client?: WebSocket }> = [];

afterEach(async () => {
  for (const entry of open.splice(0)) {
    entry.client?.close();
    entry.hub.close();
    entry.wss.close();
    await new Promise<void>((done) => entry.http.close(() => done()));
  }
});

/** A hub on its own loopback port, plus the URL a pet connects to. */
async function listening(overrides: Partial<PetHubOptions> = {}): Promise<{ hub: PetHub; url: string }> {
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer();
  const hub = new PetHub({
    welcome: () => ({ session: 'session-1', cwd: '/work', model: 'deepseek-flash' }),
    say: async () => null,
    log: () => {},
    server: wss,
    ...overrides,
  });
  http.on('upgrade', hub.upgrade);
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', () => done()));
  const { port } = http.address() as AddressInfo;
  open.push({ hub, http, wss });
  return { hub, url: `ws://127.0.0.1:${port}${PET_PATH}` };
}

/** The next parsed frame of `socket`, in order. */
function next(socket: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('no frame arrived')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timer);
      done(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
}

/** The close code of `socket`. */
function closed(socket: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('socket stayed open')), timeoutMs);
    socket.once('close', (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}

/** Connects and completes the greeting, leaving a pet the Host has accepted. */
async function greeted(url: string): Promise<{ socket: WebSocket; ready: Record<string, unknown> }> {
  const socket = new WebSocket(url);
  const ready = next(socket);
  await new Promise<void>((done, fail) => {
    socket.once('open', () => done());
    socket.once('error', fail);
  });
  socket.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'test-pet' }));
  return { socket, ready: await ready };
}

describe('a pet connection', () => {
  it('is told the conversation it landed in', async () => {
    const { url } = await listening();
    const { ready } = await greeted(url);
    expect(ready).toMatchObject({ t: 'ready', v: PROTOCOL_VERSION, session: 'session-1', model: 'deepseek-flash' });
  });

  it('is refused when this Host speaks another protocol revision', async () => {
    const { url } = await listening();
    const socket = new WebSocket(url);
    await new Promise<void>((done) => socket.once('open', () => done()));
    socket.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'old-pet' }));
    expect(await closed(socket)).toBe(4002);
  });

  it('is refused when it speaks before greeting', async () => {
    const { url } = await listening();
    const socket = new WebSocket(url);
    await new Promise<void>((done) => socket.once('open', () => done()));
    socket.send(JSON.stringify({ t: 'say', id: '1', text: 'hello', from: 'person' }));
    expect(await closed(socket)).toBe(4001);
  });

  it('cannot connect when no conversation is open', async () => {
    const { url } = await listening({ welcome: () => null });
    const socket = new WebSocket(url);
    const failure = new Promise<void>((done) => socket.once('error', () => done()));
    await failure;
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });
});

describe('a pet that speaks', () => {
  it('has its words submitted once and confirmed', async () => {
    const say = vi.fn(async () => null);
    const { url } = await listening({ say });
    const { socket } = await greeted(url);
    const ack = next(socket);
    socket.send(JSON.stringify({ t: 'say', id: 'abc', text: '让桌宠说句话', from: '大肥鱼' }));
    expect(await ack).toEqual({ t: 'accepted', id: 'abc' });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('让桌宠说句话', '大肥鱼');
  });

  it('is told why the Host refused', async () => {
    const { url } = await listening({ say: async () => 'no conversation is open on the DSH side' });
    const { socket } = await greeted(url);
    const ack = next(socket);
    socket.send(JSON.stringify({ t: 'say', id: 'abc', text: 'hi', from: 'person' }));
    expect(await ack).toEqual({ t: 'refused', id: 'abc', reason: 'no conversation is open on the DSH side' });
  });

  it('drops a frame that is not a known one', async () => {
    const say = vi.fn(async () => null);
    const { url } = await listening({ say });
    const { socket } = await greeted(url);
    socket.send('not json at all');
    socket.send(JSON.stringify({ t: 'unknown-frame' }));
    socket.send(JSON.stringify({ t: 'say', id: '1' }));
    // the connection survives, and nothing reached the Host
    socket.send(JSON.stringify({ t: 'ping' }));
    const ack = next(socket);
    socket.send(JSON.stringify({ t: 'say', id: '2', text: 'still here', from: 'person' }));
    expect(await ack).toEqual({ t: 'accepted', id: '2' });
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('still here', 'person');
  });
});

describe('notices to the pet', () => {
  it('reach a connected pet', async () => {
    const { hub, url } = await listening();
    const { socket } = await greeted(url);
    const frame = next(socket);
    expect(hub.send({ t: 'turn-start', turn: 3 })).toBe(true);
    expect(await frame).toEqual({ t: 'turn-start', turn: 3 });
  });

  it('are dropped when no pet is listening', async () => {
    const { hub } = await listening();
    expect(hub.send({ t: 'turn-start', turn: 3 })).toBe(false);
  });
});
