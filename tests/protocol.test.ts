/**
 * The two pure halves of the bridge: what a frame may say, and which conversation the pet's words
 * belong to. Both are folds over input the Host does not control, so the tests are about refusal
 * as much as about acceptance.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/pet-hub.ts';
import { SAY_MAX, argumentNames, assistantText, carriesBridgePrefix, parsePetFrame, questionTextOf, reasonText } from '../src/protocol.ts';
import { AgentRegistry, isPersonActionEvent, noticeOf, type LiveAgent } from '../src/session-watch.ts';

describe('a frame from the pet', () => {
  it('is read when it is one this Host knows', () => {
    expect(parsePetFrame(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'coo' }))).toEqual({ t: 'hello', v: PROTOCOL_VERSION, name: 'coo' });
    expect(parsePetFrame(JSON.stringify({ t: 'say', id: 'a', text: 'hi', from: '大肥鱼' }))).toEqual({ t: 'say', id: 'a', text: 'hi', from: '大肥鱼' });
    expect(parsePetFrame(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' });
    expect(parsePetFrame(JSON.stringify({ t: 'new', id: 'n1' }))).toEqual({ t: 'new', id: 'n1' });
    expect(parsePetFrame(JSON.stringify({ t: 'new', id: 'n2', workspace: ' /work/fish ' })))
      .toEqual({ t: 'new', id: 'n2', workspace: '/work/fish' });
    expect(parsePetFrame(JSON.stringify({ t: 'list-workspaces' }))).toEqual({ t: 'list-workspaces' });
  });

  it('treats a blank workspace as no wish at all', () => {
    expect(parsePetFrame(JSON.stringify({ t: 'new', id: 'n3', workspace: '   ' }))).toEqual({ t: 'new', id: 'n3' });
  });

  it('is refused when it is malformed or from another protocol', () => {
    expect(parsePetFrame('{')).toBeNull();
    expect(parsePetFrame('[]')).toBeNull();
    expect(parsePetFrame('"a string"')).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'say', id: 'a' }))).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'hello', name: 'coo' }))).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'unknown' }))).toBeNull();
    expect(parsePetFrame(JSON.stringify({ t: 'new' }))).toBeNull();
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

describe('what an ask_user_question call tells the pet', () => {
  it('is the first question\'s text', () => {
    expect(questionTextOf(JSON.stringify({ questions: [{ question: ' 要用哪个分支？ ' }, { question: '第二个' }] })))
      .toBe('要用哪个分支？');
  });

  it('carries nothing when there is no readable question', () => {
    expect(questionTextOf('not json at all')).toBe('');
    expect(questionTextOf(JSON.stringify({ questions: [] }))).toBe('');
    expect(questionTextOf(JSON.stringify({ questions: [{ header: 'x' }] }))).toBe('');
    expect(questionTextOf(undefined)).toBe('');
  });

  it('keeps a long question to one bubble', () => {
    const text = questionTextOf(JSON.stringify({ questions: [{ question: '问'.repeat(300) }] }));
    expect(text.length).toBe(201);
    expect(text.endsWith('…')).toBe(true);
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
  const agentOf = (id: string, opts?: { parentSession?: string; origin?: string }): LiveAgent => ({
    session: { id, header: { cwd: `/w/${id}`, ...opts } },
  });

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

  it('is nobody when every open conversation has been archived', () => {
    const agents = new AgentRegistry();
    agents.setArchivedCheck((id) => id === 'a' || id === 'b');
    agents.add('a', agentOf('a'));
    agents.add('b', agentOf('b'));
    // Archived Sessions stay live in DSH but refuse every model step, so offering one would mean
    // the pet's words end as `blocked` with no reply.
    expect(agents.owner).toBeNull();
    expect(agents.ownerSession).toBeNull();
    expect(agents.facts()).toBeNull();
  });

  it('is the newest conversation that is still open when the owner was archived', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentOf('a'));
    agents.add('b', agentOf('b'));
    agents.setArchivedCheck((id) => id === 'b');
    expect(agents.ownerSession).toBe('a');
  });

  it('does not let a new archived session steal the owner', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentOf('a'));
    agents.setArchivedCheck((id) => id === 'b');
    agents.add('b', agentOf('b'));
    expect(agents.ownerSession).toBe('a');
  });

  it('refuses to be pointed at an archived conversation', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentOf('a'));
    agents.add('b', agentOf('b'));
    agents.setArchivedCheck((id) => id === 'a');
    expect(agents.setOwner('a')).toBe(false);
    expect(agents.forceOwner('a')).toBe(false);
    expect(agents.ownerSession).toBe('b');
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

  describe('auto-follow from an already-live session', () => {
    it('snaps the owner when an older live session fires an active event', () => {
      const agents = new AgentRegistry();
      agents.add('a', agentOf('a'));
      agents.add('b', agentOf('b'));
      // newest wins by default
      expect(agents.ownerSession).toBe('b');
      // the older session becomes active (person switched tabs and spoke)
      expect(agents.forceOwner('a')).toBe(true);
      expect(agents.ownerSession).toBe('a');
    });

    it('does not snap when pinned by explicit pick ... until the target session becomes active', () => {
      const agents = new AgentRegistry();
      agents.add('a', agentOf('a'));
      agents.add('b', agentOf('b'));
      // pet pinned 'a' explicitly
      agents.setOwner('a');
      expect(agents.isPinned).toBe(true);
      // A brand-new 'c' appears while pinned — add() must not overwrite (pin still protects)
      agents.add('c', agentOf('c'));
      expect(agents.ownerSession).toBe('a');
      expect(agents.isPinned).toBe(true);
      // BUT if 'b' fires real activity (forceOwner) — the pin clears and owner snaps to 'b'
      // because the user's active behaviour is a stronger signal than a stale pin.
      expect(agents.forceOwner('b')).toBe(true);
      expect(agents.ownerSession).toBe('b');
      expect(agents.isPinned).toBe(false);   // ← the pin falls away
    });

    it('does not steal from a pinned session when a brand-new session appears', () => {
      const agents = new AgentRegistry();
      agents.add('a', agentOf('a'));
      agents.setOwner('a');
      // 'b' is created after the pin — add() must not overwrite
      agents.add('b', agentOf('b'));
      expect(agents.ownerSession).toBe('a');
    });

    it('clears the pin when the pinned session is disposed, so natural follow can resume', () => {
      const agents = new AgentRegistry();
      agents.add('a', agentOf('a'));
      agents.add('b', agentOf('b'));
      agents.setOwner('a');           // pin to 'a'
      expect(agents.isPinned).toBe(true);
      agents.remove('a');             // pinned session goes away
      expect(agents.isPinned).toBe(false);
      expect(agents.ownerSession).toBe('b');   // newest of the remaining
      // forceOwner on a non-owner now moves it (but here owner IS 'b' so no-op → false)
      expect(agents.forceOwner('b')).toBe(false);
      // the real proof: a NEW live session can steal, which was blocked while pinned
      agents.add('c', agentOf('c'));
      expect(agents.ownerSession).toBe('c');   // natural newest-follow works again
    });

    it('refuses a subagent, an unknown session, and an already-owner session', () => {
      const agents = new AgentRegistry();
      agents.add('a', agentOf('a'));
      agents.add('sub', agentOf('sub', { parentSession: 'a' }));
      expect(agents.forceOwner('sub')).toBe(false);    // subagent
      expect(agents.forceOwner('gone')).toBe(false);   // never seen
      expect(agents.forceOwner('a')).toBe(false);      // already the owner (no-op, no "moved")
    });
  });

  describe('person-action detection', () => {
    it('picks the events a person makes on a session', () => {
      expect(isPersonActionEvent({ type: 'user/message' })).toBe(true);
      expect(isPersonActionEvent({ type: 'approval/decided' })).toBe(true);
    });

    it('ignores the model working, so a reply elsewhere cannot steal the owner', () => {
      // Every one of these is the model acting, and a model acts wherever a line was handed to it.
      // Following them is how a pinned conversation lost its pin to whatever answered last.
      expect(isPersonActionEvent({ type: 'assistant/message' })).toBe(false);
      expect(isPersonActionEvent({ type: 'turn/start' })).toBe(false);
      expect(isPersonActionEvent({ type: 'turn/end' })).toBe(false);
      expect(isPersonActionEvent({ type: 'tool/call' })).toBe(false);
      expect(isPersonActionEvent({ type: 'approval/asked' })).toBe(false);
    });

    it('ignores request/header, unknown types, and missing type', () => {
      expect(isPersonActionEvent({ type: 'request/header', data: { header: { config: { model: 'x' } } } })).toBe(false);
      expect(isPersonActionEvent({ type: 'step/start' })).toBe(false);
      expect(isPersonActionEvent({ type: 'banana' })).toBe(false);
      expect(isPersonActionEvent({})).toBe(false);
    });
  });
});

describe('the conversations the pet reads off the list', () => {
  /** A live agent whose log already holds the given events. */
  const titledAgent = (id: string, events: Array<{ type: string; data?: unknown }>): LiveAgent => ({
    session: { id, header: { cwd: `/w/${id}` }, snapshotEvents: () => events },
  });

  it('carries the title the person knows the conversation by', () => {
    // DSH never puts a title in the header; it appends a session/title event once the first
    // message names the conversation. A pet that only sees an id and a directory guesses.
    const agents = new AgentRegistry();
    agents.add('a', titledAgent('a', [
      { type: 'session/created' },
      { type: 'session/title', data: { title: '修复桌宠会话错发问题' } },
    ]));
    expect(agents.listSessions()).toEqual([
      { id: 'a', cwd: '/w/a', model: '', title: '修复桌宠会话错发问题', running: false, owner: true, pinned: false, subagent: false },
    ]);
  });

  it('is empty while nobody has named the conversation yet', () => {
    const agents = new AgentRegistry();
    agents.add('a', titledAgent('a', [{ type: 'session/created' }]));
    expect(agents.listSessions()[0].title).toBe('');
  });

  it('keeps the last title when the conversation was renamed', () => {
    const agents = new AgentRegistry();
    agents.add('a', titledAgent('a', [
      { type: 'session/title', data: { title: '先说的事' } },
      { type: 'user/message', data: { text: '换个说法' } },
      { type: 'session/title', data: { title: '换个说法' } },
    ]));
    expect(agents.listSessions()[0].title).toBe('换个说法');
  });

  it('takes a fresh title without folding the log again', () => {
    const agents = new AgentRegistry();
    let folded = 0;
    agents.add('a', {
      session: {
        id: 'a',
        header: { cwd: '/w/a' },
        snapshotEvents: () => {
          folded += 1;
          return [{ type: 'session/title', data: { title: '旧的' } }];
        },
      },
    });
    expect(agents.listSessions()[0].title).toBe('旧的');
    // A rename arrives as an event, so the cached fold is replaced rather than recomputed:
    // listSessions() runs on every owner change and every session question.
    agents.rememberTitle('a', '新的');
    expect(agents.listSessions()[0].title).toBe('新的');
    expect(folded).toBe(1);
  });

  it('survives an agent that cannot show its log', () => {
    const agents = new AgentRegistry();
    agents.add('a', { session: { id: 'a', header: { cwd: '/w/a' } } });
    expect(agents.listSessions()[0]).toMatchObject({ id: 'a', title: '' });
  });
});

describe('whether a conversation is working right now', () => {
  const agentWith = (id: string, extra: Partial<LiveAgent> = {}): LiveAgent => ({
    session: { id, header: { cwd: `/w/${id}` } },
    ...extra,
  });

  it('reads DSH\'s own status when the Host exposes it', () => {
    // `agent.status` is a live property (`'idle' | 'running'`), so it is the authoritative answer
    // and needs no event subscription: reading it at list time is always current.
    const agents = new AgentRegistry();
    agents.add('busy', agentWith('busy', { status: 'running' }));
    agents.add('quiet', agentWith('quiet', { status: 'idle' }));
    const rows = agents.listSessions();
    expect(rows.find((row) => row.id === 'busy')?.running).toBe(true);
    expect(rows.find((row) => row.id === 'quiet')?.running).toBe(false);
  });

  it('falls back to the turn it saw start and has not seen end', () => {
    // A Host that does not expose `status` must still answer, otherwise every conversation reads
    // as idle and the pet cannot tell "still thinking" from "ignored me".
    const agents = new AgentRegistry();
    agents.add('a', agentWith('a'));
    expect(agents.listSessions()[0].running).toBe(false);
    agents.noteTurnEvent('a', { type: 'turn/start', data: { turn: 1 } });
    expect(agents.listSessions()[0].running).toBe(true);
    agents.noteTurnEvent('a', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
    expect(agents.listSessions()[0].running).toBe(false);
  });

  it('prefers the status over the fallback when the two disagree', () => {
    // The Host is the authority: a reloaded or resumed conversation can have a turn open in the
    // log while its agent is idle, and telling the pet "still running" then is a lie it acts on.
    const agents = new AgentRegistry();
    agents.add('a', agentWith('a', { status: 'idle' }));
    agents.noteTurnEvent('a', { type: 'turn/start', data: { turn: 1 } });
    expect(agents.listSessions()[0].running).toBe(false);
  });

  it('forgets the open turn when the conversation is disposed', () => {
    const agents = new AgentRegistry();
    agents.add('a', agentWith('a'));
    agents.noteTurnEvent('a', { type: 'turn/start', data: { turn: 1 } });
    agents.remove('a');
    agents.add('a', agentWith('a'));
    expect(agents.listSessions()[0].running).toBe(false);
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
