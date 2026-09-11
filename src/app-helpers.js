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
    reasoning: '',
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
        reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
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

export function isNearScrollBottom(element, threshold = 96) {
  if (!element) return true;
  const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
  return distance <= threshold;
}

export function getVisibleViewportGeometry(windowLike) {
  const visualHeight = Number(windowLike?.visualViewport?.height);
  const innerHeight = Number(windowLike?.innerHeight);
  const height = Number.isFinite(visualHeight) && visualHeight > 0
    ? visualHeight
    : (Number.isFinite(innerHeight) && innerHeight > 0 ? innerHeight : 0);
  const visualOffsetTop = Number(windowLike?.visualViewport?.offsetTop);
  const offsetTop = Number.isFinite(visualOffsetTop) ? Math.max(0, visualOffsetTop) : 0;
  return { height, offsetTop };
}

export function getVisibleViewportHeight(windowLike) {
  return getVisibleViewportGeometry(windowLike).height;
}

export function createFrameBatcher(scheduleFrame = globalThis.requestAnimationFrame) {
  let scheduled = false;
  let latestTask = null;
  let version = 0;

  const batch = (task) => {
    latestTask = task;
    if (scheduled) return;
    scheduled = true;
    const frameVersion = version;
    scheduleFrame(() => {
      if (frameVersion !== version) return;
      scheduled = false;
      const currentTask = latestTask;
      latestTask = null;
      currentTask?.();
    });
  };

  batch.cancel = () => {
    version += 1;
    scheduled = false;
    latestTask = null;
  };

  batch.flush = () => {
    const currentTask = latestTask;
    version += 1;
    scheduled = false;
    latestTask = null;
    currentTask?.();
  };

  return batch;
}

export function hasMessageOutput(message) {
  return Boolean(message?.content || message?.reasoning);
}

export function prepareAssistantRetry(message) {
  message.content = '';
  message.reasoning = '';
  message.status = 'streaming';
  return message;
}

export async function stopGenerationAndWait(controller, generationPromise) {
  controller?.abort();
  if (generationPromise) await generationPromise;
}
