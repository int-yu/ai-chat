import { DEFAULT_CONTEXT_WINDOW } from './context.js';

const DB_NAME = 'jbb-grok-mobile-chat';
const DB_VERSION = 1;
const STORE_NAME = 'conversations';
const PREFERENCES_KEY = 'jbb-grok-chat:preferences';

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createConversation({
  modelId = '',
  now = Date.now(),
  id = makeId(),
  contextWindow = DEFAULT_CONTEXT_WINDOW,
} = {}) {
  return {
    id,
    title: '新对话',
    modelId,
    createdAt: now,
    updatedAt: now,
    messages: [],
    memorySummary: '',
    compactionCount: 0,
    compactedMessageCount: 0,
    contextWindow,
  };
}

export function deriveConversationTitle(content, maxLength = 28) {
  const normalized = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '新对话';
  const characters = [...normalized];
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength).join('')}…`
    : normalized;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('本地存储请求失败')), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('本地存储事务已中止')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error || new Error('本地存储事务失败')), { once: true });
  });
}

export function createConversationStore({
  indexedDBImpl = globalThis.indexedDB,
  dbName = DB_NAME,
} = {}) {
  let databasePromise;

  const openDatabase = () => {
    if (!indexedDBImpl) return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(dbName, DB_VERSION);
      request.addEventListener('upgradeneeded', () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      });
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error || new Error('无法打开本地数据库')), { once: true });
      request.addEventListener('blocked', () => reject(new Error('本地数据库正在被另一个页面占用')), { once: true });
    });

    return databasePromise;
  };

  const run = async (mode, operation) => {
    const database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, mode);
    const resultPromise = requestResult(operation(transaction.objectStore(STORE_NAME)));
    const result = await resultPromise;
    await transactionDone(transaction);
    return result;
  };

  return {
    async list() {
      const values = await run('readonly', (store) => store.getAll());
      return values.sort((left, right) => right.updatedAt - left.updatedAt);
    },
    get(id) {
      return run('readonly', (store) => store.get(id));
    },
    async put(conversation) {
      await run('readwrite', (store) => store.put(conversation));
      return conversation;
    },
    delete(id) {
      return run('readwrite', (store) => store.delete(id));
    },
    clear() {
      return run('readwrite', (store) => store.clear());
    },
  };
}

const EMPTY_PREFERENCES = Object.freeze({
  apiKey: '',
  selectedModel: '',
  manualModel: '',
});

export function loadPreferences(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(PREFERENCES_KEY) || '{}');
    return {
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      selectedModel: typeof value.selectedModel === 'string' ? value.selectedModel : '',
      manualModel: typeof value.manualModel === 'string' ? value.manualModel : '',
    };
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
}

export function savePreferences(storage = globalThis.localStorage, preferences = {}) {
  const safeValue = {
    apiKey: typeof preferences.apiKey === 'string' ? preferences.apiKey : '',
    selectedModel: typeof preferences.selectedModel === 'string' ? preferences.selectedModel : '',
    manualModel: typeof preferences.manualModel === 'string' ? preferences.manualModel : '',
  };
  storage.setItem(PREFERENCES_KEY, JSON.stringify(safeValue));
}

export function clearPreferences(storage = globalThis.localStorage) {
  storage.removeItem(PREFERENCES_KEY);
}
