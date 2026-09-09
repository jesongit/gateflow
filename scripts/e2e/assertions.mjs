import { access } from 'node:fs/promises';

import { E2EError } from './context.mjs';

export class E2EAssertionError extends E2EError {
  constructor(message) {
    super(message);
    this.name = 'E2EAssertionError';
  }
}

export function assert(condition, message) {
  if (!condition) throw new E2EAssertionError(message);
  return condition;
}

export function assertEqual(actual, expected, label = 'value') {
  if (actual !== expected) {
    throw new E2EAssertionError(`${label}: expected ${format(expected)}, received ${format(actual)}`);
  }
  return actual;
}

export function assertIncludes(haystack, needle, label = 'value') {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new E2EAssertionError(`${label}: expected to include ${format(needle)}, received ${format(haystack)}`);
  }
  return haystack;
}

export function assertMatches(value, pattern, label = 'value') {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new E2EAssertionError(`${label}: expected ${format(value)} to match ${pattern}`);
  }
  return value;
}

export function assertPrivateRepository(repository) {
  const visibility = repository?.visibility ?? repository?.isPrivate;
  assert(
    visibility === 'PRIVATE' || visibility === 'private' || visibility === true,
    `repository must be private, received ${format(visibility)}`,
  );
  return repository;
}

export async function assertPathExists(path, label = 'path') {
  try {
    await access(path);
  } catch (error) {
    throw new E2EAssertionError(`${label} does not exist at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}

function format(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

