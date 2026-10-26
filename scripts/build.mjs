/** Builds the Host half as one CommonJS file that DSH can `require` or `import` from its profile. */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

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

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: [...builtins],
  sourcemap: false,
  logLevel: 'info',
});
