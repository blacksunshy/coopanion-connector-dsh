/**
 * The two pure halves of the bridge: what a frame may say, and which conversation the pet's words
 * belong to. Both are folds over input the Host does not control, so the tests are about refusal
 * as much as about acceptance.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/pet-hub.ts';
import { SAY_MAX, argumentNames, assistantText, carriesBridgePrefix, parsePetFrame, reasonText } from '../src/protocol.ts';
import { AgentRegistry, noticeOf, type LiveAgent } from '../src/session-watch.ts';

describe('a frame from the pet', () => {
  it('is read when it is one this Host knows', () => {
    expect(parsePetFrame(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'coo' }))).toEqual({ t: 'hello', v: PROTOCOL_VERSION, name: 'coo' });
    expect(parsePetFrame(JSON.stringify({ t: 'say', id: 'a', text: 'hi', from: '大肥鱼' }))).toEqual({ t: 'say', id: 'a', text: 'hi', from: '大肥鱼' });
    expect(parsePetFrame(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
  });

  it('is refused when it is malformed or from another protocol', () => {
    expect(parsePetFrame('{')).toBeNull();
    expect(parsePetFrame('[]')).toBeNull();
    expect(parsePetFrame('"a string"')).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'say', id: 'a' }))).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'hello', name: 'coo' }))).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'unknown' }))).toBeNull();
  });

  it('names its sender even when it does not say who that is', () => {
    expect(parsePetFrame(JSON.stringify({ t: 'say', id: 'a', text: 'hi', from: '  ' }))).toMatchObject({ from: 'the pet' });
  });
});

describe('a line that carries the bridge prefix', () => {
  it('is recognised however the pet came by it', () => {
    expect(carriesBridgePrefix('某人（通过桌宠）说：检查一下今天的天气')).toBe(true);
    expect(carriesBridgePrefix('  Coo（通过桌宠）说：hi')).toBe(true);
    expect(carriesBridgePrefix('Coo（通过桌宠）说：某人（通过桌宠）说：hi')).toBe(true);
  });

  it('is an ordinary line when no prefix stands at its front', () => {
    expect(carriesBridgePrefix('检查一下今天的天气')).toBe(false);
    expect(carriesBridgePrefix('我说过「（通过桌宠）说：」这种格式')).toBe(false);
  });
});

describe('what a tool call tells the pet', () => {
  it('is the parameter names, never their values', () => {
    expect(argumentNames('{"path":"a.ts","limit":10}')).toBe('path, limit');
  });

  it('keeps a secret that sits in a value out of the notice', () => {
    expect(argumentNames('{"token":"sk-live-abcdef123456","url":"https://example.test"}')).not.toContain('sk-live');
  });

  it('carries nothing when the arguments are not one object of named parameters', () => {
    expect(argumentNames('not json at all')).toBe('');
    expect(argumentNames('["a","b"]')).toBe('');
    expect(argumentNames(undefined)).toBe('');
  });
});

describe('the text of an assistant message', () => {
  it('joins the text blocks and leaves the rest', () => {
    expect(assistantText({ content: [{ type: 'text', text: 'one' }, { type: 'tool-call', name: 'read' }, { type: 'text', text: 'two' }] })).toBe('one\n\ntwo');
  });

  it('is nothing when the message carries no text', () => {
    expect(assistantText({ content: [{ type: 'tool-call', name: 'read' }] })).toBeNull();
    expect(assistantText({ content: [] })).toBeNull();
    expect(assistantText({})).toBeNull();
    expect(assistantText(null)).toBeNull();
  });

  it('is cut when it would not fit a bubble', () => {
    const long = 'x'.repeat(SAY_MAX * 2);
    const text = assistantText({ content: [{ type: 'text', text: long }] });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(long.length);
    expect(text!.endsWith('…')).toBe(true);
  });
});

describe('a turn-ending reason', () => {
  it('is one short line whatever shape DSH used', () => {
    expect(reasonText('completed')).toBe('completed');
    expect(reasonText({ kind: 'error', message: 'boom' })).toBe('error: boom');
    expect(reasonText({ kind: 'aborted', reason: { reason: 'user' } })).toBe('aborted: user');
    expect(reasonText(undefined)).toBe('completed');
  });
});

describe('which conversation the pet speaks into', () => {
  /** A live agent shaped like DSH's, with only the session the registry reads. */
  const agentOf = (id: string, parent?: unknown): LiveAgent => ({ session: { id, cwd: `/w/${id}`, ...(parent ? { parent } : {}) } });

  it('is the newest one', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentOf('a'));
    agents.add('b', agentOf('b'));
    expect(agents.ownerSession).toBe('b');
    expect(agents.facts()).toMatchObject({ session: 'b', cwd: '/w/b' });
  });

  it('hands the conversation back when the newest one is disposed', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentOf('a'));
    agents.add('b', agentOf('b'));
    agents.remove('b');
    expect(agents.ownerSession).toBe('a');
    agents.remove('a');
    expect(agents.owner).toBeNull();
    expect(agents.facts()).toBeNull();
  });

  it('is nobody when no conversation is open', () => {
    expect(new AgentRegistry().facts()).toBeNull();
  });

  it('can be pointed at a specific live session by the pet', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentOf('a'));
    agents.add('b', agentOf('b'));
    // newest wins by default
    expect(agents.ownerSession).toBe('b');
    // the pet switches to an older one
    expect(agents.setOwner('a')).toBe(true);
    expect(agents.ownerSession).toBe('a');
    expect(agents.facts()).toMatchObject({ session: 'a' });
    // a disposed / unknown session is refused, owner unchanged
    expect(agents.setOwner('gone')).toBe(false);
    expect(agents.ownerSession).toBe('a');
  });
});

describe('a session event', () => {
  it('becomes a notice only for the turns the pet shows', () => {
    expect(noticeOf('s', { type: 'turn/start', data: { turn: 2 } })?.frame).toEqual({ t: 'turn-start', turn: 2 });
    expect(noticeOf('s', { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', message: 'boom' } } })?.frame).toEqual({ t: 'turn-end', turn: 2, reason: 'error' });
    expect(noticeOf('s', { type: 'step/start', data: { turn: 2, step: 1 } })).toBeNull();
    expect(noticeOf('s', { type: 'turn/start', data: {} })).toBeNull();
  });
});
