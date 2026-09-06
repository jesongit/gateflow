/**
 * Outbox watcher (docs §6, frozen): watch outbox changes with a debounce
 * (default 300ms of silence) plus a file-size stability check (a dispatch
 * directory is only reported once its watched files have the same sizes on
 * two consecutive polls), so the Driver never reads a half-written file.
 *
 * Implementation notes:
 * - fs.watch (recursive where supported) accelerates change detection; a
 *   lightweight polling scan (default every 2000ms) is the uniform source of
 *   truth on all platforms, including filesystems where fs.watch is
 *   unreliable.
 * - Only directories matching the frozen dispatch_id grammar are reported.
 * - Callbacks and filesystem errors never propagate into the watcher loop;
 *   close() stops the fs.watch handle and the poll timer.
 */
import { watch } from 'node:fs';
import type { Dirent, FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { WorkspacePaths } from './paths';
import { validateDispatchDirName } from './validation';

/** Handle returned by watchOutbox; close() must stop all timers/watchers. */
export interface OutboxWatcher {
  close(): Promise<void>;
}

export interface WatchOutboxOptions {
  /** Silence period required before a dispatch directory is reported. */
  debounceMs?: number;
  /** Polling scan interval (uniform fallback for all platforms). */
  pollIntervalMs?: number;
}

/** Per-dispatch observation state. */
interface DispatchWatchState {
  /** Size signature from the last poll. */
  signature: string | null;
  /** Consecutive polls that observed the same signature. */
  stablePolls: number;
  /** Timestamp of the last observed change. */
  lastChangeMs: number;
  /** Whether the current stable state has already been reported. */
  fired: boolean;
}

/** Files whose sizes define the stability signature of a dispatch directory. */
const WATCHED_FILES = ['status.json', 'result.json', 'PLAN.md', 'PROGRESS.md', 'REPORT.md'] as const;

async function computeSignature(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const name of WATCHED_FILES) {
    try {
      const info = await stat(nodePath.join(dir, name));
      parts.push(`${name}:${info.isFile() ? info.size : '-'}`);
    } catch {
      parts.push(`${name}:-`);
    }
  }
  return parts.join('|');
}

/**
 * Watch `paths.outbox` and invoke `onDispatchId(dispatchId)` whenever a
 * dispatch directory has new activity that has settled: the debounce period
 * has elapsed without further changes AND the watched file sizes were
 * stable across two consecutive polls.
 */
export function watchOutbox(
  paths: WorkspacePaths,
  opts: { debounceMs?: number; pollIntervalMs?: number },
  onDispatchId: (dispatchId: string) => void,
): OutboxWatcher {
  const debounceMs = opts.debounceMs ?? 300;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;

  const states = new Map<string, DispatchWatchState>();
  let closed = false;
  let fsWatcher: FSWatcher | null = null;

  const startFsWatch = (): void => {
    if (closed || fsWatcher !== null) return;
    try {
      fsWatcher = watch(paths.outbox, { recursive: true }, (_event, fileName) => {
        if (closed || typeof fileName !== 'string') return;
        // Extract the top-level entry under outbox (Windows uses '\\').
        const top = fileName.split(/[\\/]/)[0];
        if (top === undefined || !validateDispatchDirName(top)) return;
        const now = Date.now();
        const state = states.get(top);
        if (state === undefined) {
          states.set(top, {
            signature: null,
            stablePolls: 0,
            lastChangeMs: now,
            fired: false,
          });
        } else {
          // Activity: postpone firing until debounce silence elapses again.
          state.lastChangeMs = now;
          state.fired = false;
        }
      });
      fsWatcher.on('error', () => {
        // e.g. outbox removed underneath us; drop the handle so the poll
        // loop can re-establish the watcher later.
        if (!closed) {
          try {
            fsWatcher?.close();
          } catch {
            // already closed
          }
          fsWatcher = null;
        }
      });
    } catch {
      // outbox may not exist yet; the polling loop keeps scanning and will
      // re-attempt the watch establishment.
      fsWatcher = null;
    }
  };

  const pollTick = async (): Promise<void> => {
    if (closed) return;
    let entries: Dirent[];
    try {
      entries = await readdir(paths.outbox, { withFileTypes: true });
    } catch {
      return;
    }
    if (fsWatcher === null) startFsWatch();

    const now = Date.now();
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || !validateDispatchDirName(entry.name)) continue;
      seen.add(entry.name);

      const signature = await computeSignature(nodePath.join(paths.outbox, entry.name));
      const existing = states.get(entry.name);
      const state: DispatchWatchState =
        existing ?? { signature: null, stablePolls: 0, lastChangeMs: now, fired: false };

      if (signature !== state.signature) {
        state.signature = signature;
        state.stablePolls = 1;
        state.lastChangeMs = now;
        state.fired = false;
      } else {
        state.stablePolls += 1;
      }
      states.set(entry.name, state);

      if (!state.fired && state.stablePolls >= 2 && now - state.lastChangeMs >= debounceMs) {
        state.fired = true;
        try {
          onDispatchId(entry.name);
        } catch {
          // A throwing callback must never kill the watcher loop.
        }
      }
    }
    // Forget directories that disappeared.
    for (const key of [...states.keys()]) {
      if (!seen.has(key)) states.delete(key);
    }
  };

  startFsWatch();
  void pollTick();
  const timer = setInterval(() => {
    void pollTick();
  }, pollIntervalMs);
  // Do not keep the process alive just for the poll timer.
  timer.unref();

  return {
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      if (fsWatcher !== null) {
        try {
          fsWatcher.close();
        } catch {
          // already closed
        }
        fsWatcher = null;
      }
      states.clear();
    },
  };
}
