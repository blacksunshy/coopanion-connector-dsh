/**
 * Creating a conversation when the pet has none: the one thing this bridge asks DSH to do on the
 * pet's behalf, rather than for it.
 *
 * The pet is a second mouth, so it needs a conversation to speak into. Normally one is open; when
 * the person archived every session, none is. `sessionController.commands.create` is the same
 * in-process path the settings window's Remote call takes: it mints the Session, publishes the
 * Agent and attaches it to a Workspace, so the new conversation shows up in DSH's own sidebar
 * and the usual `agent/created` event lifts this bridge's owner onto it.
 */

/** The part of `ctx.sessionController` this bridge uses. */
export interface SessionCommandsLike {
  commands?: {
    create(request: { workspaceId?: string } & { cwd?: string }): Promise<{ sessionId: string }>;
  };
}

/** The part of a Workspace entity this bridge reads. */
export interface WorkspaceLike {
  id: string;
  path: string;
  sessionIds: string[];
}

/**
 * Where the new conversation belongs.
 *
 * The owning session's Workspace wins: that is the project the person is working in. Without an
 * owner (every session archived, or DSH just restarted), the last directory this bridge saw
 * decides; failing both, the first Workspace in the person's own order, because a new conversation
 * in the wrong project is recoverable and no conversation at all is not.
 */
export function pickTarget(
  workspaces: readonly WorkspaceLike[],
  ownerSession: string | null,
  knownCwd: string | null,
): { workspaceId?: string; cwd?: string } | null {
  if (ownerSession !== null) {
    const owning = workspaces.find((workspace) => workspace.sessionIds.includes(ownerSession));
    if (owning) return { workspaceId: owning.id };
  }
  if (knownCwd) {
    const matching = workspaces.find((workspace) => workspace.path === knownCwd);
    if (matching) return { workspaceId: matching.id };
  }
  const first = workspaces[0];
  if (first) return { workspaceId: first.id };
  return knownCwd === null ? null : { cwd: knownCwd };
}

/** Paths compare the way the platform compares them: `C:\A\` and `c:/a` are the same project. */
function pathKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * The workspace a caller named, by id or by path, or null when nothing matches.
 *
 * The pet's model is more likely to have a directory in front of it than an opaque id, so both
 * forms are accepted; an id is checked first because a path and an id can never collide.
 */
export function resolveWorkspace(workspaces: readonly WorkspaceLike[], requested: string): WorkspaceLike | null {
  const key = requested.trim();
  if (!key) return null;
  const byId = workspaces.find((workspace) => workspace.id === key);
  if (byId) return byId;
  const wanted = pathKey(key);
  return workspaces.find((workspace) => pathKey(workspace.path) === wanted) ?? null;
}

/**
 * Create one conversation through the Session Controller, and report the session id or why not.
 *
 * `requested` is the workspace the pet named, if any: an explicit choice outranks every guess
 * below it, and a name that matches nothing is refused rather than quietly replaced by the
 * owner's project — a conversation in the wrong project is worse than no conversation, because
 * the pet would go on to hand work to it.
 *
 * The result carries the workspace path the conversation actually landed in, so the pet can tell
 * a Host that honoured the request from one that never knew about it.
 *
 * Failures are returned, not thrown: the pet reads the reason in its `refused` frame, and a bridge
 * that threw would leave the socket without an answer until its own timeout.
 */
export async function createConversation(
  controller: SessionCommandsLike | undefined,
  workspaces: readonly WorkspaceLike[],
  ownerSession: string | null,
  knownCwd: string | null,
  requested: string | null = null,
): Promise<{ session: string; workspace: string } | { reason: string }> {
  const create = controller?.commands?.create;
  if (create === undefined) {
    return { reason: 'this DSH build has no session controller, so the pet cannot create a conversation' };
  }
  let target: { workspaceId?: string; cwd?: string } | null;
  if (requested !== null && requested.trim()) {
    const hit = resolveWorkspace(workspaces, requested);
    if (hit === null) {
      const known = workspaces.map((workspace) => workspace.path).join(', ');
      return {
        reason: `DSH has no workspace matching "${requested}"${known ? `; it has: ${known}` : ''}`,
      };
    }
    target = { workspaceId: hit.id };
  } else {
    target = pickTarget(workspaces, ownerSession, knownCwd);
  }
  if (target === null) {
    return { reason: 'DSH has no workspace to create the conversation in' };
  }
  try {
    const created = await create.call(controller!.commands, target);
    const landed = target.workspaceId === undefined
      ? undefined
      : workspaces.find((workspace) => workspace.id === target.workspaceId);
    return { session: created.sessionId, workspace: landed?.path ?? target.cwd ?? '' };
  } catch (err) {
    return { reason: `DSH refused to create a conversation: ${err instanceof Error ? err.message : String(err)}` };
  }
}