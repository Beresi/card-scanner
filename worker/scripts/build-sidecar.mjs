/**
 * build-sidecar.mjs — Build the scan-local sidecar as a self-contained Windows exe.
 *
 * Toolchain: esbuild (TS → CJS bundle) → Node SEA (Single Executable Application).
 * Node 20+ SEA is the stable, no-MSVC approach: it embeds the bundle into a copy
 * of the Node binary. Output: a standalone .exe that needs no Node runtime at all.
 *
 * Steps:
 *   1. esbuild: bundle scripts/scan-local.ts → dist/scan-local.cjs
 *      (--external:better-sqlite3 ensures the test-only native dep is never bundled)
 *   2. Write dist/sea-config.json
 *   3. node --experimental-sea-config → dist/sea-prep.blob
 *   4. Copy the running node.exe to the output path
 *   5. postject injects the blob into the copy
 *
 * Output: desktop/src-tauri/binaries/scan-local-x86_64-pc-windows-msvc.exe
 * The Tauri manifest references externalBin: ["binaries/scan-local"] and appends
 * the target triple automatically.
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(WORKER_DIR, 'dist');
const BINARIES_DIR = path.resolve(WORKER_DIR, '..', 'desktop', 'src-tauri', 'binaries');
const OUTPUT_EXE = path.join(BINARIES_DIR, 'scan-local-x86_64-pc-windows-msvc.exe');
const BUNDLE_CJS = path.join(DIST_DIR, 'scan-local.cjs');
const SEA_CONFIG = path.join(DIST_DIR, 'sea-config.json');
const SEA_BLOB = path.join(DIST_DIR, 'sea-prep.blob');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[build-sidecar] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(' ')}`);
  // On Windows, .cmd files require shell:true (execFileSync rejects them with EINVAL).
  // Escape args with spaces by quoting them.
  if (process.platform === 'win32' && cmd.endsWith('.cmd')) {
    const quotedArgs = args.map((a) => (a.includes(' ') ? `"${a}"` : a));
    execSync(`"${cmd}" ${quotedArgs.join(' ')}`, { stdio: 'inherit', ...opts });
  } else {
    execFileSync(cmd, args, { stdio: 'inherit', ...opts });
  }
}

// ---------------------------------------------------------------------------
// Step 1: Bundle with esbuild
// ---------------------------------------------------------------------------

log('Step 1/4: bundling with esbuild...');
fs.mkdirSync(DIST_DIR, { recursive: true });

// On Windows, .bin symlinks need the .cmd extension for execFileSync.
const isWin = process.platform === 'win32';
const binExt = isWin ? '.cmd' : '';
const esbuildBin = path.join(WORKER_DIR, 'node_modules', '.bin', `esbuild${binExt}`);
run(esbuildBin, [
  path.join(__dirname, 'scan-local.ts'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  `--outfile=${BUNDLE_CJS}`,
  '--external:better-sqlite3',
  '--log-level=info',
]);

const bundleSize = fs.statSync(BUNDLE_CJS).size;
log(`Bundle size: ${(bundleSize / 1024).toFixed(1)} kB`);

// ---------------------------------------------------------------------------
// Step 2: Write SEA config
// ---------------------------------------------------------------------------

log('Step 2/4: writing sea-config.json...');
const seaConfig = {
  main: BUNDLE_CJS,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};
fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2));

// ---------------------------------------------------------------------------
// Step 3: Generate SEA blob
// ---------------------------------------------------------------------------

log('Step 3/4: generating SEA blob (node --experimental-sea-config)...');
run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);

const blobSize = fs.statSync(SEA_BLOB).size;
log(`Blob size: ${(blobSize / 1024).toFixed(1)} kB`);

// ---------------------------------------------------------------------------
// Step 4: Copy node.exe + inject blob with postject
// ---------------------------------------------------------------------------

log('Step 4/4: copying node.exe and injecting blob...');
fs.mkdirSync(BINARIES_DIR, { recursive: true });

// Copy the running node.exe as the base executable.
fs.copyFileSync(process.execPath, OUTPUT_EXE);
log(`Copied ${process.execPath} → ${OUTPUT_EXE}`);

// On Windows, remove the signature before injection (postject requirement).
// signtool may not be available — wrap in try/catch; unsigned is fine for dev.
try {
  execSync(`signtool remove /s "${OUTPUT_EXE}"`, { stdio: 'pipe' });
  log('Removed exe signature (signtool).');
} catch {
  log('signtool not available or no signature to remove — continuing.');
}

const postjectBin = path.join(WORKER_DIR, 'node_modules', '.bin', `postject${binExt}`);
run(postjectBin, [
  OUTPUT_EXE,
  'NODE_SEA_BLOB',
  SEA_BLOB,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--overwrite',
]);

const exeSize = fs.statSync(OUTPUT_EXE).size;
log(`\nDone! Sidecar exe: ${OUTPUT_EXE}`);
log(`Exe size: ${(exeSize / 1024 / 1024).toFixed(1)} MB`);
