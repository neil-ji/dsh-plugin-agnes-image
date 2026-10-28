import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { missingKeyMessage, resolveAgnesKey } from '../lib/agnes-key.js';

const config = (overrides = {}) => ({ apiKey: '', credentialRef: 'AGNES_API_KEY', ...overrides });

describe('resolveAgnesKey', () => {
  test('prefers an explicit config key', async () => {
    const result = await resolveAgnesKey({
      config: config({ apiKey: 'sk-config' }),
      credentials: { resolve: async () => ({ value: 'sk-store', source: 'store' }) },
      env: { AGNES_API_KEY: 'sk-env' },
    });
    assert.deepEqual(result, { key: 'sk-config', source: 'config' });
  });

  test('reads the credential seam before the ambient environment', async () => {
    const calls = [];
    const result = await resolveAgnesKey({
      config: config(),
      credentials: {
        resolve: async (ref) => {
          calls.push(ref);
          return { value: '  sk-store  ', source: 'store' };
        },
      },
      env: { AGNES_API_KEY: 'sk-env' },
    });
    assert.deepEqual(result, { key: 'sk-store', source: 'credential' });
    assert.deepEqual(calls, ['AGNES_API_KEY'], 'the configured reference is resolved per call');
  });

  test('falls back to the environment when the seam has no value', async () => {
    const result = await resolveAgnesKey({
      config: config(),
      credentials: { resolve: async () => undefined },
      env: { AGNES_API_KEY: 'sk-env' },
    });
    assert.deepEqual(result, { key: 'sk-env', source: 'env' });
  });

  test('reads the environment without a credentials service', async () => {
    const result = await resolveAgnesKey({
      config: config({ credentialRef: 'MY_AGNES_KEY' }),
      env: { MY_AGNES_KEY: 'sk-custom' },
    });
    assert.deepEqual(result, { key: 'sk-custom', source: 'env' });
  });

  test('treats empty and whitespace values as missing', async () => {
    const result = await resolveAgnesKey({
      config: config(),
      credentials: { resolve: async () => ({ value: '   ', source: 'store' }) },
      env: { AGNES_API_KEY: '   ' },
    });
    assert.deepEqual(result, { key: '', source: 'missing' });
  });

  test('survives a throwing credential seam and still consults the environment', async () => {
    const result = await resolveAgnesKey({
      config: config(),
      credentials: {
        resolve: async () => {
          throw new Error('store unavailable');
        },
      },
      env: { AGNES_API_KEY: 'sk-env' },
    });
    assert.deepEqual(result, { key: 'sk-env', source: 'env' });
  });

  test('reports the missing state used by the tool error', async () => {
    const result = await resolveAgnesKey({ config: config(), env: {} });
    assert.deepEqual(result, { key: '', source: 'missing' });
    assert.match(missingKeyMessage('AGNES_API_KEY'), /Settings → Agnes 生图/);
    assert.match(missingKeyMessage('AGNES_API_KEY'), /credential store/);
    assert.match(missingKeyMessage('MY_KEY'), /MY_KEY environment variable/);
  });
});
