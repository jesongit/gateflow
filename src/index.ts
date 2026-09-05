/**
 * Entry point of the GitHub AI Workflow Gate action.
 *
 * Phase 0 placeholder: this stub is intentionally minimal and only proves the
 * build pipeline (esbuild -> dist/index.js). The real event router, permission
 * checks, command parser and label transitions are implemented in Phase 1
 * (src/gate.ts, src/commands.ts, src/states.ts, src/markers.ts,
 * src/permissions.ts, src/github.ts).
 */
import * as core from '@actions/core';

export const GATE_VERSION = '0.0.1';

/** Runs the gate. Phase 0: log-only skeleton, performs no action. */
export function run(): void {
  core.info(`github-ai-workflow gate ${GATE_VERSION}: Phase 0 skeleton, nothing to do.`);
}

// Only auto-execute when actually running inside GitHub Actions,
// so that importing this module from tests stays side-effect free.
if (process.env.GITHUB_ACTIONS === 'true') {
  run();
}
