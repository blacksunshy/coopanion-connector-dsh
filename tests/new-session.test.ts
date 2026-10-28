/**
 * Where a pet-made conversation lands, and what the pet is told when DSH will not make one.
 *
 * The creation itself lives in the Session Controller; this covers the two decisions the bridge
 * makes around it — which Workspace, and how a refusal reads — plus the shape the pet receives.
 */
import { describe, expect, it } from 'vitest';
import { createConversation, pickTarget, type WorkspaceLike } from '../src/new-session.ts';

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
    expect(result).toEqual({ session: 'session-new' });
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