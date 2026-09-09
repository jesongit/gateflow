/**
 * Explicit Control/Target binding helpers for Workspace Protocol v3.
 *
 * A Control Repository is where the GateFlow Issue lives and is the only
 * repository the Driver GitHub client may read/write for protocol comments.
 * A Target Repository/Workspace is task metadata for local project work. It
 * is never used to derive a GitHub IssueRef.
 */
import * as nodePath from 'node:path';

/** GitHub owner/name limits, intentionally stricter than a generic path slug. */
export const REPOSITORY_SLUG_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;

/** Target portion copied into every task-facing binding record. */
export interface TargetBinding {
  target_repository: string | null;
  target_workspace: string | null;
}

/** Return true only for a GitHub-shaped owner/name slug. */
export function isRepositorySlug(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_SLUG_PATTERN.test(value);
}

/** Compare repository slugs case-insensitively as GitHub does. */
export function sameRepositorySlug(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** True for either the host platform's absolute path or a Windows path. */
function isAbsolutePath(value: string): boolean {
  return nodePath.isAbsolute(value) || nodePath.win32.isAbsolute(value);
}

/** Reject path traversal syntax before path normalization can hide it. */
function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..');
}

/**
 * Normalize an explicit target workspace. `null` is the only representation
 * of an unknown target; empty, relative and traversal-containing paths are
 * never accepted. The returned value is absolute and platform-normalized.
 */
export function normalizeTargetWorkspace(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('target_workspace must be null or a non-empty absolute path');
  }
  if (value.includes('\0') || hasTraversalSegment(value)) {
    throw new Error(`target_workspace contains a forbidden path segment: ${JSON.stringify(value)}`);
  }
  if (!isAbsolutePath(value)) {
    throw new Error(`target_workspace must be absolute, got ${JSON.stringify(value)}`);
  }

  // On the host platform nodePath.resolve/normalize is authoritative. The
  // win32 fallback makes validation deterministic for Windows paths in tests
  // running on another platform, without ever turning a relative path into
  // an accepted target.
  const normalized = nodePath.isAbsolute(value)
    ? nodePath.normalize(nodePath.resolve(value))
    : nodePath.win32.normalize(value);
  if (normalized === '.' || normalized.endsWith(nodePath.sep + '..')) {
    throw new Error(`target_workspace resolves to an unsafe path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

/** Lexical containment, including the base directory itself. */
export function isPathInside(base: string, candidate: string): boolean {
  const resolvedBase = nodePath.resolve(base);
  const resolvedCandidate = nodePath.resolve(candidate);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(resolvedBase + nodePath.sep);
}

/**
 * Reject a target that points at the Driver communication/private directory.
 * The project root itself remains a valid explicit target for legacy
 * control-repository-local tasks; `.gateflow/` and descendants do not.
 */
export function assertTargetOutsideRuntime(
  projectRoot: string,
  workspaceDir: string,
  targetWorkspace: string | null,
): string | null {
  const normalized = normalizeTargetWorkspace(targetWorkspace);
  if (normalized === null) return null;
  const runtimeRoot = nodePath.resolve(projectRoot, workspaceDir);
  if (isPathInside(runtimeRoot, normalized)) {
    throw new Error(`target_workspace must not point inside the Driver runtime directory: ${normalized}`);
  }
  return normalized;
}

/** Stable comparison key for workspace collision detection. */
export function workspaceKey(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizeTargetWorkspace(value);
  return process.platform === 'win32' ? normalized?.toLowerCase() ?? null : normalized;
}
