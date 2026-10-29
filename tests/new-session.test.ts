/**
 * Where a pet-made conversation lands, and what the pet is told when DSH will not make one.
 *
 * The creation itself lives in the Session Controller; this covers the two decisions the bridge
 * makes around it — which Workspace, and how a refusal reads — plus the shape the pet receives.
 */
import { describe, expect, it } from 'vitest';
import { createConversation, pickTarget, resolveWorkspace, type WorkspaceLike } from '../src/new-session.ts';

const project = (id: string, path: string, sessionIds: string[] = []): WorkspaceLike => ({ id, path, sessionIds });

const fishPond = project('ws-fish', '/work/fish', ['session-live']);
const other = project('ws-other', '/work/other');

describe('where a new conversation belongs', () => {
  it('is the Workspace of the conversation the pet is already speaking into', () => {
    expect(pickTarget([other, fishPond], 'session-live', '/work/other')).toEqual({ workspaceId: 'ws-fish' });
  });

  it('is the Workspace of the last directory seen when no conversation is open', () => {
    expect(pickTarget([other, fishPond], null, '/work/fish')).toEqual({ workspaceId: 'ws-fish' });
  });

  it('is the first Workspace when neither is known', () => {
    expect(pickTarget([other, fishPond], null, null)).toEqual({ workspaceId: 'ws-other' });
  });

  it('is the known directory when no Workspace was ever registered', () => {
    expect(pickTarget([], null, '/tmp/loose')).toEqual({ cwd: '/tmp/loose' });
  });

  it('is nothing at all when there is neither a Workspace nor a directory', () => {
    expect(pickTarget([], null, null)).toBeNull();
  });
});

describe('asking DSH for a conversation', () => {
  it('reports the session DSH created, in the Workspace the pet was pointed at', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await createConversation(
      {
        commands: {
          create: async (request) => {
            calls.push(request);
            return { sessionId: 'session-new' };
          },
        },
      },
      [fishPond],
      'session-live',
      null,
    );
    expect(result).toEqual({ session: 'session-new', workspace: '/work/fish' });
    expect(calls).toEqual([{ workspaceId: 'ws-fish' }]);
  });

  it('reports the reason when DSH refuses', async () => {
    const result = await createConversation(
      { commands: { create: async () => { throw new Error('session/conflict'); } } },
      [fishPond],
      null,
      null,
    );
    expect(result).toEqual({ reason: 'DSH refused to create a conversation: session/conflict' });
  });

  it('reports a Host without a session controller instead of throwing', async () => {
    expect(await createConversation(undefined, [fishPond], null, null)).toEqual({
      reason: 'this DSH build has no session controller, so the pet cannot create a conversation',
    });
  });

  it('reports a Host with nowhere to put the conversation', async () => {
    expect(await createConversation({ commands: { create: async () => ({ sessionId: 'x' }) } }, [], null, null)).toEqual({
      reason: 'DSH has no workspace to create the conversation in',
    });
  });
});

describe('a workspace the pet names', () => {
  const controller = (calls: Array<Record<string, unknown>>) => ({
    commands: {
      create: async (request: Record<string, unknown>) => {
        calls.push(request);
        return { sessionId: 'session-new' };
      },
    },
  });

  it('outranks the owner and the last directory seen', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await createConversation(
      controller(calls),
      [other, fishPond],
      'session-live',
      '/work/other',
      'ws-other',
    );
    expect(calls).toEqual([{ workspaceId: 'ws-other' }]);
    expect(result).toEqual({ session: 'session-new', workspace: '/work/other' });
  });

  it('may be a path, not just an id', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await createConversation(controller(calls), [other, fishPond], null, null, '/work/fish/');
    expect(calls).toEqual([{ workspaceId: 'ws-fish' }]);
  });

  it('is refused when nothing matches, rather than quietly falling back', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await createConversation(controller(calls), [other, fishPond], 'session-live', '/work/other', '/work/nowhere');
    expect(result).toEqual({ reason: 'DSH has no workspace matching "/work/nowhere"; it has: /work/other, /work/fish' });
    expect(calls).toEqual([]);
  });
});

describe('matching the workspace a person named', () => {
  it('finds one by id or by path', () => {
    expect(resolveWorkspace([other, fishPond], 'ws-fish')).toBe(fishPond);
    expect(resolveWorkspace([other, fishPond], '/work/fish')).toBe(fishPond);
  });

  it('ignores a trailing separator', () => {
    expect(resolveWorkspace([other, fishPond], '/work/fish/')).toBe(fishPond);
  });

  it('finds nothing for an empty or unknown name', () => {
    expect(resolveWorkspace([other, fishPond], '   ')).toBeNull();
    expect(resolveWorkspace([other, fishPond], '/work/missing')).toBeNull();
  });
});