#!/usr/bin/env node
// Fails when the npm tarball would be missing build output.
//
// Why this exists: `.npmrc` sets `ignore-scripts=true` (supply-chain hardening), which also
// disables npm lifecycle hooks such as `prepublishOnly` and `prepack`. Nothing builds the package
// implicitly, so `npm run release` builds and then runs this check before publishing.
import { execFileSync } from 'node:child_process';

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'bin/apk-downloader.js',
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.d.cts',
  'dist/cli/main.js',
];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const output = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
const [pack] = JSON.parse(output);
const files = new Set(pack.files.map((f) => f.path));

const missing = REQUIRED.filter((file) => !files.has(file));
const unexpected = [...files].filter(
  (file) => !REQUIRED.includes(file) && !/^dist\/.+\.map$/.test(file),
);

if (missing.length > 0 || unexpected.length > 0) {
  if (missing.length > 0) console.error(`Missing from the package: ${missing.join(', ')}`);
  if (unexpected.length > 0) console.error(`Unexpected in the package: ${unexpected.join(', ')}`);
  console.error('Run "npm run build" first (lifecycle scripts are disabled by .npmrc).');
  process.exit(1);
}
console.log(`Package contents OK: ${files.size} files, ${pack.size} bytes packed.`);
