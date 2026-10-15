/** Builds the Host half as one CommonJS file that DSH can `require` or `import` from its profile. */
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

/**
 * CommonJS, not ESM. The Host loads a profile plugin through its own module table, and a `.js` file
 * under a profile whose `package.json` has no `"type"` is CommonJS to Node: an ESM artifact with
 * `export default` fails there before `apply` ever runs, silently — the bundle is listed, the file
 * imports by hand, and no route appears. `.cjs` is unambiguous in both directions (Node's `require`
 * takes it directly, and `import()` interops it).
 *
 * Node builtins stay external. Bundling them inlines `ws`'s own `require('events')` and the Host
 * then dies with `Dynamic require of "events" is not supported`. `ws` itself is left to the profile
 * that installs this package (pnpm hoists it beside the plugin).
 */
const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['ws', ...builtins],
  sourcemap: false,
  logLevel: 'info',
});
