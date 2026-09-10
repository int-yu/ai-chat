import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';

import {
  clearPreferences,
  createConversation,
  createConversationStore,
  deriveConversationTitle,
  loadPreferences,
  savePreferences,
} from '../src/storage.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('createConversation returns a complete independent conversation record', () => {
  const conversation = createConversation({ modelId: 'grok-4', now: 1234, id: 'chat-1' });

  assert.deepEqual(conversation, {
    id: 'chat-1',
    title: '新对话',
    modelId: 'grok-4',
    createdAt: 1234,
    updatedAt: 1234,
    messages: [],
    memorySummary: '',
    compactionCount: 0,
    compactedMessageCount: 0,
    contextWindow: 128_000,
  });
});

test('deriveConversationTitle collapses whitespace and limits long titles', () => {
  assert.equal(deriveConversationTitle('  帮我\n\n写一个   手机聊天页面  '), '帮我 写一个 手机聊天页面');
  assert.equal(deriveConversationTitle('abcdefghijklmnopqrstuvwxyz1234567890'), 'abcdefghijklmnopqrstuvwxyz12…');
  assert.equal(deriveConversationTitle('   '), '新对话');
});

test('conversation store saves and lists conversations by most recent update', async () => {
  const store = createConversationStore({ indexedDBImpl: indexedDB, dbName: `chat-${crypto.randomUUID()}` });
  await store.put({ ...createConversation({ id: 'older', now: 100 }), title: '较早' });
  await store.put({ ...createConversation({ id: 'newer', now: 200 }), title: '较新' });

  const conversations = await store.list();

  assert.deepEqual(conversations.map(({ id }) => id), ['newer', 'older']);
  assert.equal((await store.get('older')).title, '较早');
});

test('conversation store deletes one conversation and can clear all data', async () => {
  const store = createConversationStore({ indexedDBImpl: indexedDB, dbName: `chat-${crypto.randomUUID()}` });
  await store.put(createConversation({ id: 'one', now: 1 }));
  await store.put(createConversation({ id: 'two', now: 2 }));

  await store.delete('one');
  assert.deepEqual((await store.list()).map(({ id }) => id), ['two']);

  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test('conversation store propagates IndexedDB failures to the caller', async () => {
  const store = createConversationStore({
    indexedDBImpl: { open: () => { throw new Error('storage blocked'); } },
    dbName: 'broken',
  });

  await assert.rejects(() => store.list(), /storage blocked/);
});

test('preferences persist only supported string fields and recover from corrupt JSON', () => {
  const storage = memoryStorage();
  savePreferences(storage, {
    apiKey: 'sk-secret',
    selectedModel: 'grok-4',
    manualModel: '',
    ignored: 'do not save',
  });

  assert.deepEqual(loadPreferences(storage), {
    apiKey: 'sk-secret',
    selectedModel: 'grok-4',
    manualModel: '',
  });

  const corruptStorage = memoryStorage({ 'jbb-grok-chat:preferences': '{bad json' });
  assert.deepEqual(loadPreferences(corruptStorage), {
    apiKey: '',
    selectedModel: '',
    manualModel: '',
  });
});

test('clearPreferences removes the stored key and settings', () => {
  const storage = memoryStorage();
  savePreferences(storage, { apiKey: 'secret', selectedModel: 'grok-4', manualModel: '' });

  clearPreferences(storage);

  assert.deepEqual(loadPreferences(storage), {
    apiKey: '',
    selectedModel: '',
    manualModel: '',
  });
});
