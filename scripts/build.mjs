/** Builds the Host half as one CommonJS file that DSH can `require` or `import` from its profile. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * `--check` 只校验、不写盘：把源码重新打一遍，和仓库里的 `dist/index.cjs` 逐字节比对。
 *
 * 0.2.14 / 0.2.15 的教训（issue #11 / #12）：源码改好了，但发版时没重新构建、也没把产物一起推上去，
 * 用户装到的 `dist/index.cjs` 里还是 `Boolean(root.webServer)`——cordis 里未 inject 的服务属性一读就抛，
 * `apply()` 第一行就中止，插件启用失败、`/coopanion/status` 404。产物是随 git 分发的唯一代码，
 * 源码与产物不同步就等于发了一个坏包，所以发版前必须过这一关。
 */
const checkOnly = process.argv.includes('--check');
const outfile = fileURLToPath(new URL('../dist/index.cjs', import.meta.url));

/**
 * DSH validates a freshly installed plugin by reading `node_modules/<name>/package.json` with
 * `JSON.parse`. JSON has no byte-order mark, and `JSON.parse` rejects one, so a manifest saved as
 * "UTF-8 with BOM" makes the whole install roll back with
 *
 *   Cannot validate installed package <name>: SyntaxError: Unexpected token '﻿'
 *
 * A PowerShell `Get-Content package.json | ConvertTo-Json | Set-Content package.json` round trip is
 * the usual way such a mark appears. Refuse to build (and therefore refuse to publish) a manifest
 * that cannot be installed, instead of shipping it and finding out from the user.
 */
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) {
  throw new Error(
    `${manifestPath} starts with a UTF-8 byte-order mark, which JSON.parse rejects; ` +
      'DSH would refuse the installed package. Run "node scripts/fix-manifest-encoding.mjs" and rebuild.',
  );
}

/**
 * CommonJS, not ESM. The Host loads a profile plugin through its own module table, and a `.js` file
 * under a profile whose `package.json` has no `"type"` is CommonJS to Node: an ESM artifact with
 * `export default` fails there before `apply` ever runs, silently — the bundle is listed, the file
 * imports by hand, and no route appears. `.cjs` is unambiguous in both directions (Node's `require`
 * takes it directly, and `import()` interops it).
 *
 * Node builtins stay external. Bundling them inlines `ws`'s own `require('events')` and the Host
 * then dies with `Dynamic require of "events" is not supported`.
 *
 * `ws` is bundled in, NOT left external. A `link:` install (pnpm just symlinks the directory, it
 * does not run install inside it) leaves no `node_modules/ws` beside the plugin, and DSH's module
 * interception does not route bare `ws` for a linked bundle. The result is `Cannot find module 'ws'`
 * at import time and the plugin never activates. Bundling ws (~200 KB) makes the artifact
 * self-contained regardless of how it was installed; `ws` stays in `dependencies` for type checks
 * and is also declared as a peerDependency so a profile that already has it can reuse it.
 */
const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

// Loaded after the manifest guard above, so a manifest DSH cannot parse is reported by name instead
// of surfacing as a bundler error.
const { build } = await import('esbuild');

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: [...builtins],
  sourcemap: false,
  logLevel: checkOnly ? 'silent' : 'info',
  write: false,
  define: {
    __PKG_VERSION__: JSON.stringify(manifest.version ?? '0.0.0-unknown'),
  },
});

const fresh = result.outputFiles[0].text;

/**
 * 断言产物里没有越权读取 cordis 服务属性。合法写法只有 `root.get('webServer')` 或 `inject(['webServer'], …)`，
 * 裸 `root.webServer` 会在 `inject` 之外命中 proxy 的 get 陷阱并抛错（issue #9 / #11 / #12）。
 */
const forbidden = [
  { pattern: /root\.webServer\b/, fix: "改用 root.get('webServer') 或 inject(['webServer'], …)" },
];
for (const { pattern, fix } of forbidden) {
  if (pattern.test(fresh)) {
    throw new Error(
      `❌ dist 里仍有 ${pattern.source}：cordis 未 inject 的服务属性一读就抛，` +
        `插件会在 apply() 开头的日志行直接崩掉。${fix}（issue #9 / #11 / #12）`,
    );
  }
}

const previous = existsSync(outfile) ? readFileSync(outfile, 'utf8') : null;
if (checkOnly) {
  if (previous === fresh) {
    console.log('✅ dist/index.cjs 与源码同步（可以发版）');
  } else {
    throw new Error(
      '❌ 仓库里的 dist/index.cjs 与源码不一致：源码改了但产物没重建，或者重建了没提交。\n' +
        '   git 安装会直接用到这份产物，发出去的包会在启用时崩溃（issue #11 / #12）。\n' +
        '   先跑 `pnpm run build` 重建，并把 dist/index.cjs 一起提交/推送，再发版。',
    );
  }
} else {
  writeFileSync(outfile, fresh, 'utf8');
  if (previous !== null && previous !== fresh) {
    console.log('⚠️  dist/index.cjs 已重建且与仓库里的不同 —— 发版前必须把它一起提交/推送（pnpm run verify:dist 复核）');
  }
}
