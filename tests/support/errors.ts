import { expect } from 'vitest';
import { RedisToolkitError } from '../../src/index.js';

/** Asserts an operation fails with a package error of the given class and code, whether it throws or rejects. */
export async function expectPackageError(operation: () => unknown, type: new (...args: never[]) => RedisToolkitError, code: string): Promise<void> {
  let failure: unknown;
  try { await operation(); }
  catch (error) { failure = error; }
  // Every package error is catchable at one boundary: the base class.
  expect(failure).toBeInstanceOf(RedisToolkitError);
  expect(failure).toBeInstanceOf(type);
  expect((failure as RedisToolkitError).code).toBe(code);
}
