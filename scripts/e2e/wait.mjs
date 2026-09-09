import { E2EError } from './context.mjs';

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new E2EError(`wait timeoutMs must be a positive number, got ${JSON.stringify(timeoutMs)}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an async condition until it returns a truthy value. A failed poll is
 * retained and included in the timeout error, making eventual-consistency
 * failures actionable rather than just "timed out".
 */
export async function waitFor(label, check, options = {}) {
  if (typeof check !== 'function') throw new E2EError(`wait condition for ${label} must be a function`);
  const timeoutMs = options.timeoutMs;
  validateTimeout(timeoutMs);
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new E2EError(`wait intervalMs for ${label} must be positive, got ${JSON.stringify(intervalMs)}`);
  }
  const started = Date.now();
  let attempts = 0;
  let lastValue;
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    attempts += 1;
    try {
      lastValue = await check({ attempts, elapsedMs: Date.now() - started });
      if (lastValue) return lastValue;
    } catch (error) {
      lastError = error;
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  const diagnostic = lastError instanceof Error ? lastError.message : lastError === null ? 'none' : String(lastError);
  throw new E2EError(
    `timed out waiting for ${label} after ${timeoutMs}ms (${attempts} attempt(s)); ` +
      `last value: ${formatDiagnostic(lastValue)}; last error: ${diagnostic}`,
  );
}

export async function waitForGh(label, check, options = {}) {
  return waitFor(`GitHub ${label}`, check, options);
}

function formatDiagnostic(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

