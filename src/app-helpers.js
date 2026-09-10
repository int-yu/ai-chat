import { DEFAULT_CONTEXT_WINDOW } from './context.js';

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function chooseModel(models = [], selectedModel = '', manualModel = '') {
  if (models.some((model) => model.id === selectedModel)) return selectedModel;
  if (models.length > 0) return models[0].id;
  const manual = String(manualModel).trim();
  return manual.toLowerCase().includes('grok') ? manual : '';
}

export function createMessage(role, content, { id = makeId(), now = Date.now() } = {}) {
  return {
    id,
    role,
    content,
    createdAt: now,
    status: role === 'assistant' && !content ? 'streaming' : 'complete',
  };
}

export function normalizeLoadedConversation(conversation) {
  return {
    ...conversation,
    modelId: typeof conversation.modelId === 'string' ? conversation.modelId : '',
    createdAt: Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now(),
    updatedAt: Number.isFinite(conversation.updatedAt) ? conversation.updatedAt : Date.now(),
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.map((message) => ({
        ...message,
        status: message.status === 'streaming' ? 'stopped' : (message.status || 'complete'),
      }))
      : [],
    memorySummary: typeof conversation.memorySummary === 'string' ? conversation.memorySummary : '',
    compactionCount: Number.isInteger(conversation.compactionCount) ? conversation.compactionCount : 0,
    compactedMessageCount: Number.isInteger(conversation.compactedMessageCount)
      ? conversation.compactedMessageCount
      : 0,
    contextWindow: Number.isFinite(conversation.contextWindow)
      ? conversation.contextWindow
      : DEFAULT_CONTEXT_WINDOW,
  };
}

export function isProxyConfigured(value) {
  if (typeof value !== 'string' || value.includes('REPLACE-ME')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.workers.dev');
  } catch {
    return false;
  }
}

export async function stopGenerationAndWait(controller, generationPromise) {
  controller?.abort();
  if (generationPromise) await generationPromise;
}
