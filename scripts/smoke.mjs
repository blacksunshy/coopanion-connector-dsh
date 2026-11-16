/**
 * Smoke test against the BUILT artifact (`dist/index.cjs`), not the TS source.
 *
 * It wires the plugin into a fake cordis context the way DSH does, opens a real loopback
 * WebSocket, and plays a pet that (1) greets, (2) checks the list it was handed, (3) speaks into a
 * named conversation, (4) aims at a conversation that is gone, and (5) speaks with no target at all.
 *
 * Run: node scripts/smoke.mjs
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const bundle = require('../dist/index.cjs');
const plugin = bundle.default;

const frames = [];
const upgrades = new Map();
const listeners = new Map();
const injected = [];

function agentOf(id) {
  const messages = [];
  injected.push({ id, messages });
  return {
    session: { id, header: { cwd: `/w/${id}` } },
    followup: (message) => messages.push(message),
  };
}

const services = {
  sessionController: {
    commands: {
      create: async () => {
        emit('agent/created', { agent: agentOf('session-brand-new') });
        return { sessionId: 'session-brand-new' };
      },
    },
  },
  workspaceRegistry: {
    list: () => [{ id: 'ws-1', path: '/w/session-a', sessionIds: ['session-a'] }],
    archivedSessionIds: [],
  },
};

const scoped = {
  webServer: {
    registerUpgrade(route) {
      upgrades.set(route.path, route.handler);
      return () => upgrades.delete(route.path);
    },
    register() {
      return () => {};
    },
  },
  effect(callback) {
    callback();
  },
  get: (name) => services[name],
};

const ctx = {
  inject(_names, callback) {
    callback(scoped);
  },
  effect(callback) {
    callback();
  },
  on(event, listener) {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    return () => {};
  },
  get: (name) => services[name],
};

function emit(event, ...args) {
  for (const listener of listeners.get(event) ?? []) listener(...args);
}

plugin.apply(ctx);

const handler = upgrades.get('/coopanion/pet');
if (typeof handler !== 'function') {
  console.error('FAIL: the bundle did not mount /coopanion/pet');
  process.exit(1);
}

const http = createServer();
http.on('upgrade', handler);
new WebSocketServer({ noServer: true });
await new Promise((done) => http.listen(0, '127.0.0.1', done));
const { port } = http.address();

// Conversations exist before the pet connects, the way they do after a DSH restart.
emit('agent/created', { agent: agentOf('session-a') });
emit('agent/created', { agent: agentOf('session-b') });

const socket = new WebSocket(`ws://127.0.0.1:${port}/coopanion/pet`);
socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
await new Promise((done, fail) => {
  socket.once('open', done);
  socket.once('error', fail);
});

const send = (frame) => socket.send(JSON.stringify(frame));
const until = async (check, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('condition never held');
};

const failures = [];
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` → ${JSON.stringify(detail)}` : ''}`);
  }
};

// Two conversations are open, the older one owned first, then the newer steals the default owner.
send({ t: 'hello', v: 1, name: 'smoke-pet' });
await until(() => frames.some((f) => f.t === 'ready'));
const ready = frames.find((f) => f.t === 'ready');
console.log('\n1) the pet is handed the whole list on its first frame');
check('ready names the owner', ready.session === 'session-b', ready.session);
check(
  'ready carries every open conversation',
  Array.isArray(ready.sessions) && ready.sessions.map((s) => s.id).join(',') === 'session-a,session-b',
  ready.sessions?.map((s) => s.id),
);
check('ready carries the pin flag', ready.pinned === false, ready.pinned);

console.log('\n2) a pushed list arrives whenever the menu changes');
const pushesBefore = frames.filter((f) => f.t === 'session-list').length;
emit('agent/created', { agent: agentOf('session-c') });
await until(() => frames.filter((f) => f.t === 'session-list').length > pushesBefore);
const pushed = frames.filter((f) => f.t === 'session-list').at(-1);
check('push lists all three', pushed.sessions.map((s) => s.id).join(',') === 'session-a,session-b,session-c', pushed.sessions.map((s) => s.id));
check('push names the owner at the top level', pushed.owner === 'session-c', pushed.owner);

console.log('\n3) speaking into a NAMED conversation lands there, not in the owner');
send({ t: 'say', id: 's1', text: '帮我看下构建', from: '大肥鱼', session: 'session-a' });
await until(() => frames.some((f) => f.t === 'accepted' || f.t === 'refused' && f.id === 's1'));
const ack1 = frames.find((f) => (f.t === 'accepted' || f.t === 'refused') && f.id === 's1');
check('accepted', ack1.t === 'accepted', ack1);
check('the ack names the conversation that took the words', ack1.session === 'session-a', ack1.session);
check('the ack repeats the whole list', Array.isArray(ack1.sessions) && ack1.sessions.length === 3, ack1.sessions?.length);
check(
  'session-a received the words',
  injected.find((a) => a.id === 'session-a').messages.length === 1,
  injected.map((a) => [a.id, a.messages.length]),
);
check(
  'the default owner (session-c) received nothing',
  injected.find((a) => a.id === 'session-c').messages.length === 0,
  injected.map((a) => [a.id, a.messages.length]),
);

console.log('\n4) aiming at a conversation that is gone is REFUSED, never silently re-routed');
send({ t: 'say', id: 's2', text: '在吗', from: '大肥鱼', session: 'session-gone' });
await until(() => frames.some((f) => f.t === 'refused' && f.id === 's2'));
const refused = frames.find((f) => f.t === 'refused' && f.id === 's2');
check('refused', refused.t === 'refused', refused);
check('machine-readable code', refused.code === 'stale-session', refused.code);
check('the current list comes back with it', Array.isArray(refused.sessions) && refused.sessions.length === 3, refused.sessions?.length);
check(
  'nothing was delivered anywhere',
  injected.every((a) => a.messages.length === (a.id === 'session-a' ? 1 : 0)),
  injected.map((a) => [a.id, a.messages.length]),
);

console.log('\n5) an older pet that names no conversation still works');
// Naming a conversation in step 3 deliberately re-aimed the pet, so the aimless line now follows
// that aim rather than jumping back to whatever was newest. That is the point: an explicit target
// is remembered, not forgotten the moment it is used.
send({ t: 'say', id: 's3', text: '老协议', from: '大肥鱼' });
await until(() => frames.some((f) => (f.t === 'accepted' || f.t === 'refused') && f.id === 's3'));
const ack3 = frames.find((f) => (f.t === 'accepted' || f.t === 'refused') && f.id === 's3');
check('accepted', ack3.t === 'accepted', ack3);
check('landed in the aim set by step 3', ack3.session === 'session-a', ack3.session);
check(
  'session-a received it',
  injected.find((a) => a.id === 'session-a').messages.length === 2,
  injected.map((a) => [a.id, a.messages.length]),
);

console.log('\n6) asking for a brand-new conversation works and re-aims the pet');
send({ t: 'new', id: 'n1' });
await until(() => frames.some((f) => f.t === 'created' || f.t === 'refused' && f.id === 'n1'));
const created = frames.find((f) => (f.t === 'created' || f.t === 'refused') && f.id === 'n1');
check('created', created.t === 'created', created);
check('names the new conversation', created.session === 'session-brand-new', created.session);
await until(() => frames.filter((f) => f.t === 'ready').length >= 2 || frames.some((f) => f.t === 'session-list' && f.sessions.some((s) => s.id === 'session-brand-new')));
check(
  'the pet is re-aimed at it',
  frames.filter((f) => f.t === 'ready').at(-1)?.session === 'session-brand-new',
  frames.filter((f) => f.t === 'ready').map((f) => f.session),
);

console.log('\n7) when nothing is open at all, the refusal says so and carries an empty list');
// Dispose everything the pet knows about.
for (const id of ['session-a', 'session-b', 'session-c', 'session-brand-new']) emit('session/disposed', { id });
await new Promise((done) => setTimeout(done, 150));
send({ t: 'say', id: 's4', text: '有人吗', from: '大肥鱼' });
await until(() => frames.some((f) => (f.t === 'accepted' || f.t === 'refused') && f.id === 's4'));
const ack4 = frames.find((f) => (f.t === 'accepted' || f.t === 'refused') && f.id === 's4');
check('refused', ack4.t === 'refused', ack4);
check('code is no-session', ack4.code === 'no-session', ack4.code);
check('empty list', Array.isArray(ack4.sessions) && ack4.sessions.length === 0, ack4.sessions);

socket.close();
await new Promise((done) => http.close(done));

console.log(`\n${failures.length === 0 ? 'PASS — every check held' : `FAIL — ${failures.length} check(s) failed: ${failures.join(', ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
