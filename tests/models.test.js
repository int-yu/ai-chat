import test from 'node:test';
import assert from 'node:assert/strict';

import { filterGrokModels, normalizeModelsResponse } from '../src/models.js';

test('normalizeModelsResponse accepts OpenAI data arrays', () => {
  const models = normalizeModelsResponse({
    object: 'list',
    data: [{ id: 'grok-4' }, { id: 'gpt-5' }],
  });

  assert.deepEqual(models, [{ id: 'grok-4' }, { id: 'gpt-5' }]);
});

test('normalizeModelsResponse rejects malformed payloads', () => {
  assert.deepEqual(normalizeModelsResponse({ data: 'not-an-array' }), []);
  assert.deepEqual(normalizeModelsResponse(null), []);
});

test('filterGrokModels matches grok ids case-insensitively and deduplicates', () => {
  const models = filterGrokModels([
    { id: 'Grok-4', context_window: 262_144 },
    { id: 'gpt-5' },
    { id: 'Grok-4' },
    { id: 'grok-code-fast-1' },
  ]);

  assert.deepEqual(models, [
    { id: 'Grok-4', context_window: 262_144 },
    { id: 'grok-code-fast-1' },
  ]);
});
