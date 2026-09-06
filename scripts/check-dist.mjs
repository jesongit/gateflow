// check-dist.mjs — verify that the committed dist/ bundles are byte-identical
// to a fresh esbuild rebuild of src/. GitHub JavaScript Actions require the
// bundled dist/ to be committed, so any drift must fail the build.
// Run via `npm run check:dist` (also wired into .github/workflows/ci.yml).
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const artifacts = [
  { entry: 'src/index.ts', dist: 'dist/index.js' }, // Gate Action bundle
  { entry: 'src/cli.ts', dist: 'dist/cli.js' }, // gateflow driver CLI bundle
];

// Rebuild one entry in memory. Flags EXACTLY mirror the `build:gate` /
// `build:cli` scripts in package.json (`esbuild <entry> --bundle
// --platform=node --target=node20 --outfile=<dist>`); only `write: false` is
// added so we compare bytes without touching the working tree.
async function rebuild(entry, outfile) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile,
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].contents;
}

let failed = false;

for (const { entry, dist } of artifacts) {
  let committed;
  try {
    committed = await readFile(join(root, dist));
  } catch {
    console.error(
      `[check:dist] MISSING: ${dist} is not committed (entry: ${entry}). Run \`npm run build\` and commit dist/.`
    );
    failed = true;
    continue;
  }

  let rebuilt;
  try {
    rebuilt = await rebuild(entry, dist);
  } catch (err) {
    console.error(
      `[check:dist] ERROR: rebuilding ${entry} failed: ${err.message}`
    );
    failed = true;
    continue;
  }

  if (!Buffer.from(rebuilt).equals(committed)) {
    console.error(
      `[check:dist] DRIFTED: ${dist} does not match a fresh build of ${entry}. Run \`npm run build\` and commit dist/.`
    );
    failed = true;
  } else {
    console.log(`[check:dist] OK: ${dist} is in sync with ${entry}.`);
  }
}

process.exit(failed ? 1 : 0);
