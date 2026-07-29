import { describe, expect, test } from 'bun:test';
import { normalizeAdminSourceGrant } from '../src/commands/serve-http.ts';

describe('admin OAuth source grant normalization', () => {
  test('preserves the legacy default-source behavior when omitted', () => {
    expect(normalizeAdminSourceGrant(undefined, undefined)).toEqual({
      sourceId: 'default',
      federatedRead: undefined,
    });
  });

  test('accepts and deterministically normalizes a bounded source grant', () => {
    expect(normalizeAdminSourceGrant(
      'axiom-polaris',
      ['shared', 'axiom-polaris', 'shared'],
    )).toEqual({
      sourceId: 'axiom-polaris',
      federatedRead: ['axiom-polaris', 'shared'],
    });
  });

  test('rejects invalid or over-broad source grants', () => {
    expect(() => normalizeAdminSourceGrant('has_underscore', undefined))
      .toThrow(/sourceId/);
    expect(() => normalizeAdminSourceGrant(
      'axiom-polaris',
      ['default'],
    )).toThrow(/include the write source/);
    expect(() => normalizeAdminSourceGrant(
      'axiom-polaris',
      Array.from({ length: 33 }, (_, index) => `source-${index}`),
    )).toThrow(/1-32/);
  });
});
