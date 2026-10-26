/**
 * Self-update for the DSH Host bridge.
 *
 * Works without any external dependency — Node 22 has built-in fetch and fs.cpSync.
 * Windows 10+ ships `tar.exe` for unpacking the GitHub source tarball.
 *
 * The `__PKG_VERSION__` identifier is injected at build time by esbuild's
 * `define` option (see `scripts/build.mjs`). It falls back to reading the
 * local `package.json` at runtime when the define is missing (dev/link
 * installs, where esbuild never ran).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

declare const __PKG_VERSION__: string | undefined;

const REPO_OWNER = 'blacksunshy';
const REPO_NAME = 'coopanion-connector-dsh';
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

/** Package directory — where this plugin actually lives inside the Host profile. */
function pkgDir(): string {
  // esbuild (CJS output) replaces __filename with the literal dist/index.cjs path.
  // We're in dist/index.cjs, so two levels up = package root.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const file = typeof __filename === 'string' ? __filename : '';
  if (file) return resolve(dirname(file), '..');
  // Fallback: search up from cwd for package.json with our name.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === REPO_NAME) return dir;
    } catch { /* not here */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function currentVersion(): string {
  if (typeof __PKG_VERSION__ === 'string' && __PKG_VERSION__) return __PKG_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

/** Compare two semver strings; returns true if `latest` is strictly newer. */
function isNewer(latest: string, current: string): boolean {
  const parse = (s: string) => s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(latest);
  const [b1, b2, b3] = parse(current);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

export interface CheckUpdateResult {
  ok: boolean;
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
  error?: string;
}

/** Query GitHub Releases for the newest published tag. */
export async function checkUpdate(): Promise<CheckUpdateResult> {
  const cur = currentVersion();
  try {
    const res = await fetch(`${GITHUB_API}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${REPO_NAME}/${cur}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { ok: false, current: cur, latest: '', hasUpdate: false, releaseUrl: '', error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { tag_name: string; html_url: string };
    const latest = data.tag_name.replace(/^v/, '');
    return {
      ok: true,
      current: cur,
      latest,
      hasUpdate: isNewer(latest, cur),
      releaseUrl: data.html_url,
    };
  } catch (err) {
    return { ok: false, current: cur, latest: '', hasUpdate: false, releaseUrl: '', error: (err as Error).message };
  }
}

export interface PerformUpdateResult {
  ok: boolean;
  from?: string;
  to?: string;
  backupDir?: string;
  error?: string;
  needsRestart: boolean;
}

/**
 * Download the GitHub Release source tarball, unpack it over the running
 * plugin directory, and return. The DSH Host must be restarted to pick up
 * the new `dist/index.cjs`.
 */
export async function performUpdate(): Promise<PerformUpdateResult> {
  const cur = currentVersion();
  const check = await checkUpdate();
  if (!check.ok || !check.hasUpdate) {
    return { ok: false, from: cur, to: check.latest, error: check.error ?? 'no newer release found', needsRestart: false };
  }

  const target = pkgDir();
  const tag = `v${check.latest}`;
  const tarballUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${tag}.tar.gz`;

  const workDir = join(tmpdir(), `${REPO_NAME}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const tarPath = join(workDir, 'src.tar.gz');
  const extractDir = join(workDir, 'extract');

  try {
    // 1. Download tarball
    const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok || !res.body) {
      return { ok: false, from: cur, to: check.latest, error: `download failed: HTTP ${res.status}`, needsRestart: false };
    }
    writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));

    // 2. Extract (Windows 10+ ships tar.exe)
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'pipe' });
    const entries = readdirSync(extractDir);
    const srcDir = join(extractDir, entries[0] ?? '');
    if (!existsSync(join(srcDir, 'package.json'))) {
      return { ok: false, from: cur, to: check.latest, error: 'tarball did not contain package.json', needsRestart: false };
    }

    // 3. Backup current files
    const backupDir = join(tmpdir(), `${REPO_NAME}-backup-${Date.now()}`);
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(join(target, 'dist'))) {
      cpSync(join(target, 'dist'), join(backupDir, 'dist'), { recursive: true });
    }
    if (existsSync(join(target, 'package.json'))) {
      writeFileSync(join(backupDir, 'package.json.bak'), readFileSync(join(target, 'package.json')));
    }

    // 4. Overlay: copy dist/, package.json, cordis.patch.yml, README.md
    if (existsSync(join(srcDir, 'dist'))) {
      rmSync(join(target, 'dist'), { recursive: true, force: true });
      cpSync(join(srcDir, 'dist'), join(target, 'dist'), { recursive: true });
    }
    for (const f of ['package.json', 'cordis.patch.yml', 'README.md']) {
      const src = join(srcDir, f);
      const dst = join(target, f);
      if (existsSync(src)) {
        // Strip BOM just in case — PowerShell can re-add it when the release was built on Windows
        let content = readFileSync(src, 'utf8');
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
        writeFileSync(dst, content);
      }
    }

    return {
      ok: true,
      from: cur,
      to: check.latest,
      backupDir,
      needsRestart: true,
    };
  } catch (err) {
    return { ok: false, from: cur, to: check.latest, error: (err as Error).message, needsRestart: false };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Exported so plugin.ts status route can include it. */
export { currentVersion };
