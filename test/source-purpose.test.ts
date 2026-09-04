import { describe, expect, test } from 'bun:test';
import { isCodeSourceConfig } from '../src/core/source-purpose.ts';

describe('source purpose', () => {
  test('only an explicit code strategy is a code source', () => {
    expect(isCodeSourceConfig({ strategy: 'code' })).toBe(true);
    expect(isCodeSourceConfig({ strategy: 'markdown' })).toBe(false);
    expect(isCodeSourceConfig({ strategy: 'auto' })).toBe(false);
    expect(isCodeSourceConfig({})).toBe(false);
    expect(isCodeSourceConfig(null)).toBe(false);
  });
});
