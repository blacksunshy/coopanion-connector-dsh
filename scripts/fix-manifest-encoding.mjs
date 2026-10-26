/**
 * Rewrites a manifest as UTF-8 without a byte-order mark and restores the repository's formatting
 * (two-space indent, LF line endings).
 *
 * A BOM is legal in a text file but not in JSON. DSH validates an installed plugin by reading
 * `node_modules/<name>/package.json` with `JSON.parse`, which throws on the leading U+FEFF and makes
 * the whole install roll back with:
 *
 *   dsh: installation rejected: Cannot validate installed package <name>:
 *   SyntaxError: Unexpected token '﻿', "﻿{... "na"... is not valid JSON
 *
 * A PowerShell `Get-Content package.json | ConvertTo-Json | Set-Content package.json` round trip is
 * the usual way one gets in. This script repairs that, and refuses to touch anything that is not
 * valid JSON even after the mark is removed.
 *
 * Usage: node scripts/fix-manifest-encoding.mjs [path-to-package.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = resolve(process.argv[2] ?? fileURLToPath(new URL('../package.json', import.meta.url)));
const bytes = readFileSync(path);
const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
const text = (hasBom ? bytes.subarray(3) : bytes).toString('utf8');

let manifest;
try {
  manifest = JSON.parse(text);
} catch (error) {
  console.error(`fix-manifest-encoding: ${path} is not valid JSON after the byte-order mark was removed.`);
  console.error(String(error));
  process.exitCode = 1;
  throw error;
}

const hadCrlf = text.includes('\r\n');
writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');

console.log(`fix-manifest-encoding: ${path}`);
console.log(`  BOM:        ${hasBom ? 'removed' : 'none'}`);
console.log(`  line ends:  ${hadCrlf ? 'CRLF -> LF' : 'LF'}`);
console.log(`  parseable:  yes (JSON.parse succeeds)`);
