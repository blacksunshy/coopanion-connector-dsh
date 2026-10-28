/**
 * Where the bridge writes its proof-of-load and debug lines.
 *
 * One file per platform convention, both under a directory the Host may not have created; every
 * write is best-effort because a Host without that directory still runs. Windows keeps the two
 * destinations the desktop and CLI installs actually use; elsewhere the DSH home log directory is
 * the only one.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_LOG_FILE = 'coopanion-bridge.jsonl';

/** The files a load or debug line is appended to, in order. */
export function bridgeLogFiles(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  if (platform === 'win32') {
    const files: string[] = [];
    if (env.APPDATA) files.push(join(env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'logs', BRIDGE_LOG_FILE));
    if (env.USERPROFILE) files.push(join(env.USERPROFILE, '.dsh', 'logs', BRIDGE_LOG_FILE));
    return files;
  }
  return [join(home, '.dsh', 'logs', BRIDGE_LOG_FILE)];
}