import { describe, expect, it } from 'vitest';

describe('rotation model', () => {
  it('requires predecessor consumption before successor acceptance', async () => {
    let consumed = false;
    let successes = 0;
    const rotate = async () => {
      if (consumed) return false;
      consumed = true;
      successes += 1;
      return true;
    };
    await Promise.all([rotate(), rotate()]);
    expect(successes).toBe(1);
  });
});
