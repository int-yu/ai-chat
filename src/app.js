import { APP_CONFIG } from './config.js';
import { ApiError, createApiClient, isContextOverflowError } from './api.js';
import {
  chooseModel,
  createFrameBatcher,
  createMessage,
  getVisibleViewportGeometry,
  hasMessageOutput,
  isNearScrollBottom,
  isProxyConfigured,
  normalizeLoadedConversation,
  prepareAssistantRetry,
  stopGenerationAndWait,
} from './app-helpers.js';
import { MessageTooLongError, prepareConversationContext } from './context-manager.js';
import { filterGrokModels } from './models.js';
import { createReasoningPanel, renderMarkdown } from './render.js';
import {
  clearPreferences,
  createConversation,
  createConversationStore,
  deriveConversationTitle,
  loadPreferences,
  savePreferences,
} from './storage.js';

const elements = Object.fromEntries([
  'chat-main', 'message-list', 'message-input', 'composer', 'send-button',
  'stop-button', 'history-button', 'new-chat-button', 'settings-button', 'model-button',
  'connection-dot', 'notice', 'history-drawer', 'drawer-backdrop', 'close-history-button',
  'drawer-new-chat-button', 'history-list', 'settings-dialog', 'settings-form', 'api-key-input',
  'toggle-key-button', 'model-select', 'manual-model-field', 'manual-model-input',
  'proxy-warning', 'save-settings-button', 'clear-data-button', 'compact-now-button',
  'memory-strip', 'memory-strip-text', 'view-memory-button', 'memory-dialog', 'memory-content',
  'close-memory-button', 'toast-region',
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

const store = createConversationStore();
const proxyConfigured = isProxyConfigured(APP_CONFIG.proxyBaseUrl);
const client = proxyConfigured ? createApiClient({ baseUrl: APP_CONFIG.proxyBaseUrl }) : null;

let preferences = loadPreferences();
let conversations = [];
let activeConversation = null;
let models = [];
let activeController = null;
let activeGenerationPromise = null;
let generating = false;
let followLatest = true;
const batchStreamingRender = createFrameBatcher((callback) => requestAnimationFrame(callback));
const batchViewportSync = createFrameBatcher((callback) => requestAnimationFrame(callback));

function showToast(message, duration = 3_200) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

function showNotice(message = '') {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function setConnection(state) {
  elements.connectionDot.dataset.state = state;
}

function setGenerating(value) {
  generating = value;
  elements.sendButton.disabled = value;
  elements.stopButton.hidden = !value;
  elements.messageInput.disabled = value;
  setConnection(value ? 'working' : (preferences.apiKey && models.length ? 'connected' : 'idle'));
}

function resizeComposer() {
  const { height: viewportHeight } = getVisibleViewportGeometry(window);
  const maxHeight = Math.min(180, viewportHeight * 0.3);
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, maxHeight)}px`;
}

function syncViewportGeometry() {
  const { height, offsetTop } = getVisibleViewportGeometry(window);
  if (height > 0) document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
  document.documentElement.style.setProperty('--app-offset-top', `${Math.round(offsetTop)}px`);
  resizeComposer();
}

function scheduleViewportSync() {
  batchViewportSync(syncViewportGeometry);
}

function scrollToLatest(behavior = 'smooth') {
  followLatest = true;
  elements.chatMain.scrollTo({ top: elements.chatMain.scrollHeight, behavior });
}

function currentModelId() {
  return chooseModel(models, preferences.selectedModel, preferences.manualModel);
}

function currentModel() {
  const id = currentModelId();
  return models.find((model) => model.id === id) || { id };
}

function updateConversationInMemory(conversation) {
  const index = conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) conversations[index] = conversation;
  else conversations.push(conversation);
  conversations.sort((left, right) => right.updatedAt - left.updatedAt);
  if (activeConversation?.id === conversation.id) activeConversation = conversation;
}

async function persistConversation(conversation) {
  updateConversationInMemory(conversation);
  try {
    await store.put(conversation);
    renderHistory();
  } catch (error) {
    showToast(`本地保存失败：${error.message}`);
    throw error;
  }
}

function statusLabel(message) {
  if (message.status === 'streaming') return message.content ? '正在回答' : '正在等待响应';
  if (message.status === 'stopped') return '已停止';
  if (message.status === 'error') return '发送失败';
  return message.role === 'user' ? '你' : 'Grok';
}

function makeToolButton(label, action, messageId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.messageId = messageId;
  button.textContent = label;
  return button;
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.className = 'message';
  article.dataset.role = message.role;
  article.dataset.status = message.status || 'complete';
  article.id = `message-${message.id}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = statusLabel(message);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (message.status === 'streaming') {
    bubble.classList.add('streaming-cursor');
    if (!message.content) bubble.classList.add('is-waiting');
  }
  if (message.role === 'assistant' && message.status !== 'streaming') {
    renderMarkdown(bubble, message.content);
  } else {
    bubble.textContent = message.content || (message.status === 'streaming' ? '正在等待首段内容…' : '');
  }

  article.append(meta);
  if (message.role === 'assistant' && message.reasoning) {
    article.append(createReasoningPanel(document, message.reasoning, {
      open: message.status === 'streaming',
    }));
  }
  article.append(bubble);

  if (message.role === 'assistant' && message.status !== 'streaming') {
    const tools = document.createElement('div');
    tools.className = 'message-tools';
    if (message.content && message.status !== 'error') {
      tools.append(makeToolButton('复制', 'copy', message.id));
    }
    if (message.status === 'error') {
      tools.append(makeToolButton('重试', 'retry', message.id));
    }
    article.append(tools);
  }

  return article;
}

function renderConversation({ keepScroll = false } = {}) {
  if (!activeConversation) return;
  elements.messageList.replaceChildren(...activeConversation.messages.map(renderMessage));

  const hasMemory = Boolean(activeConversation.memorySummary);
  elements.memoryStrip.hidden = !hasMemory;
  elements.memoryStripText.textContent = hasMemory
    ? `上下文已优化 ${activeConversation.compactionCount} 次 · 查看摘要`
    : '上下文已优化';

  if (!keepScroll) requestAnimationFrame(() => scrollToLatest('auto'));
}

function updateStreamingMessage(conversation, message) {
  if (activeConversation?.id !== conversation.id) return;
  const article = document.getElementById(`message-${message.id}`);
  if (!article) {
    renderConversation();
    return;
  }
  batchStreamingRender(() => {
    if (activeConversation?.id !== conversation.id || message.status !== 'streaming') return;
    const currentArticle = document.getElementById(`message-${message.id}`);
    const bubble = currentArticle?.querySelector('.message-bubble');
    if (!currentArticle || !bubble) return;

    let reasoningPanel = currentArticle.querySelector('.reasoning-panel');
    if (message.reasoning && !reasoningPanel) {
      reasoningPanel = createReasoningPanel(document, message.reasoning, { open: true });
      currentArticle.insertBefore(reasoningPanel, bubble);
    } else if (reasoningPanel) {
      reasoningPanel.querySelector('.reasoning-content').textContent = message.reasoning;
    }

    bubble.textContent = message.content || '正在等待首段内容…';
    bubble.classList.add('streaming-cursor');
    bubble.classList.toggle('is-waiting', !message.content);
    currentArticle.querySelector('.message-meta').textContent = statusLabel(message);
    if (followLatest) scrollToLatest('auto');
  });
}

function formatConversationTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp));
}

function renderHistory() {
  const items = conversations.map((conversation) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.dataset.active = String(conversation.id === activeConversation?.id);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'history-select';
    select.dataset.action = 'select';
    select.dataset.conversationId = conversation.id;
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = conversation.title;
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatConversationTime(conversation.updatedAt);
    select.append(title, time);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'history-action';
    rename.dataset.action = 'rename';
    rename.dataset.conversationId = conversation.id;
    rename.setAttribute('aria-label', `重命名“${conversation.title}”`);
    rename.textContent = '✎';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-action';
    remove.dataset.action = 'delete';
    remove.dataset.conversationId = conversation.id;
    remove.setAttribute('aria-label', `删除“${conversation.title}”`);
    remove.textContent = '×';

    row.append(select, rename, remove);
    return row;
  });
  elements.historyList.replaceChildren(...items);
}

function updateModelUi() {
  const selected = currentModelId();
  elements.modelButton.textContent = selected || '尚未连接模型';
  elements.modelSelect.replaceChildren();

  if (models.length) {
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.id;
      option.selected = model.id === selected;
      elements.modelSelect.append(option);
    }
    elements.modelSelect.disabled = false;
    elements.manualModelField.hidden = true;
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未识别到可用的 Grok 模型';
    elements.modelSelect.append(option);
    elements.modelSelect.disabled = true;
    elements.manualModelField.hidden = false;
  }
}

function saveCurrentPreferences() {
  try {
    savePreferences(localStorage, preferences);
  } catch (error) {
    showToast(`设置保存失败：${error.message}`);
  }
}

async function refreshModels({ silent = false } = {}) {
  if (!client) throw new Error('Worker 尚未配置');
  if (!preferences.apiKey) throw new ApiError('请先填写 JBB API 密钥。');
  setConnection('working');
  if (!silent) elements.saveSettingsButton.disabled = true;

  try {
    models = filterGrokModels(await client.listModels(preferences.apiKey));
    preferences.selectedModel = chooseModel(models, preferences.selectedModel, preferences.manualModel);
    saveCurrentPreferences();
    updateModelUi();
    setConnection(models.length || preferences.selectedModel ? 'connected' : 'error');
    return models;
  } catch (error) {
    models = [];
    updateModelUi();
    setConnection('error');
    throw error;
  } finally {
    elements.saveSettingsButton.disabled = false;
  }
}

function openSettings({ focusKey = false } = {}) {
  elements.apiKeyInput.value = preferences.apiKey;
  elements.manualModelInput.value = preferences.manualModel;
  elements.proxyWarning.hidden = proxyConfigured;
  updateModelUi();
  if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  if (focusKey) requestAnimationFrame(() => elements.apiKeyInput.focus());
}

function openHistory() {
  renderHistory();
  elements.drawerBackdrop.hidden = false;
  elements.historyDrawer.dataset.open = 'true';
  elements.historyDrawer.setAttribute('aria-hidden', 'false');
}

function closeHistory() {
  elements.historyDrawer.dataset.open = 'false';
  elements.historyDrawer.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => { elements.drawerBackdrop.hidden = true; }, 180);
}

async function createNewChat() {
  activeController?.abort();
  const model = currentModel();
  const conversation = createConversation({ modelId: model.id || '', contextWindow: model.context_window || model.context_length });
  conversations.unshift(conversation);
  activeConversation = conversation;
  await persistConversation(conversation);
  renderConversation();
  closeHistory();
  elements.messageInput.focus();
}

function markAssistantError(conversation, assistantId, error) {
  const assistant = conversation.messages.find((message) => message.id === assistantId);
  if (!assistant) return;
  assistant.status = 'error';
  assistant.content = error?.message || '请求失败，请重试。';
}

async function streamPreparedConversation(conversation, assistantId, apiMessages, controller) {
  const assistant = conversation.messages.find((message) => message.id === assistantId);
  batchStreamingRender.cancel();
  assistant.content = '';
  assistant.reasoning = '';
  assistant.status = 'streaming';
  if (activeConversation?.id === conversation.id) renderConversation({ keepScroll: true });

  try {
    await client.streamChat({
      apiKey: preferences.apiKey,
      model: conversation.modelId,
      messages: apiMessages,
      signal: controller.signal,
      onDelta: (delta) => {
        assistant.content += delta;
        updateStreamingMessage(conversation, assistant);
      },
      onReasoningDelta: (delta) => {
        assistant.reasoning += delta;
        updateStreamingMessage(conversation, assistant);
      },
    });
  } finally {
    batchStreamingRender.flush();
  }
  assistant.status = 'complete';
}

async function generateAssistant(startConversation, assistantId, initialSavePromise = Promise.resolve()) {
  const controller = new AbortController();
  activeController = controller;
  setGenerating(true);
  let conversation = startConversation;

  try {
    let prepared = await prepareConversationContext({
      conversation,
      client,
      apiKey: preferences.apiKey,
      model: currentModel(),
      signal: controller.signal,
    });
    conversation = prepared.conversation;
    conversation.modelId = currentModelId();
    if (prepared.compacted) {
      await initialSavePromise;
      await persistConversation(conversation);
      showToast('较早的对话已提炼为上下文摘要。');
    }

    try {
      await streamPreparedConversation(conversation, assistantId, prepared.apiMessages, controller);
    } catch (error) {
      if (!isContextOverflowError(error) || controller.signal.aborted) throw error;

      prepared = await prepareConversationContext({
        conversation,
        client,
        apiKey: preferences.apiKey,
        model: currentModel(),
        force: true,
        signal: controller.signal,
      });
      if (!prepared.compacted) {
        throw new MessageTooLongError();
      }
      conversation = prepared.conversation;
      await initialSavePromise;
      await persistConversation(conversation);
      showToast('检测到上下文上限，已优化后自动重试。');
      await streamPreparedConversation(conversation, assistantId, prepared.apiMessages, controller);
    }
  } catch (error) {
    const assistant = conversation.messages.find((message) => message.id === assistantId);
    if (error?.name === 'AbortError') {
      if (hasMessageOutput(assistant)) assistant.status = 'stopped';
      else conversation.messages = conversation.messages.filter((message) => message.id !== assistantId);
    } else {
      markAssistantError(conversation, assistantId, error);
      showToast(error?.message || '请求失败，请稍后重试。');
      setConnection('error');
    }
  } finally {
    batchStreamingRender.cancel();
    conversation.updatedAt = Date.now();
    if (activeConversation?.id === conversation.id) {
      activeConversation = conversation;
      renderConversation({ keepScroll: !followLatest });
    }
    await initialSavePromise;
    try { await persistConversation(conversation); } catch { /* toast already shown */ }
    if (activeController === controller) {
      activeController = null;
      setGenerating(false);
      elements.messageInput.focus();
    }
  }
}

async function sendDraft() {
  const content = elements.messageInput.value.trim();
  if (!content || generating) return;
  if (!client || !preferences.apiKey || !currentModelId()) {
    showToast(!proxyConfigured ? '请先部署并配置 Worker。' : '请先填写密钥并连接 Grok 模型。');
    openSettings({ focusKey: true });
    return;
  }

  const wasEmpty = activeConversation.messages.length === 0;
  const userMessage = createMessage('user', content);
  const assistantMessage = createMessage('assistant', '');
  activeConversation.messages.push(userMessage, assistantMessage);
  activeConversation.modelId = currentModelId();
  activeConversation.contextWindow = currentModel().context_window || currentModel().context_length || activeConversation.contextWindow;
  activeConversation.updatedAt = Date.now();
  if (wasEmpty) activeConversation.title = deriveConversationTitle(content);
  elements.messageInput.value = '';
  resizeComposer();

  renderConversation();
  const initialSavePromise = persistConversation(activeConversation).catch(() => {});
  const generationPromise = generateAssistant(activeConversation, assistantMessage.id, initialSavePromise);
  activeGenerationPromise = generationPromise;
  await generationPromise;
  if (activeGenerationPromise === generationPromise) activeGenerationPromise = null;
}

async function retryMessage(messageId) {
  if (generating) return;
  const assistant = activeConversation.messages.find((message) => message.id === messageId);
  if (!assistant || assistant.role !== 'assistant') return;
  prepareAssistantRetry(assistant);
  activeConversation.updatedAt = Date.now();
  renderConversation();
  const initialSavePromise = persistConversation(activeConversation).catch(() => {});
  const generationPromise = generateAssistant(activeConversation, assistant.id, initialSavePromise);
  activeGenerationPromise = generationPromise;
  await generationPromise;
  if (activeGenerationPromise === generationPromise) activeGenerationPromise = null;
}

async function compactCurrentConversation() {
  if (generating) {
    showToast('请先停止当前回答。');
    return;
  }
  if (!client || !preferences.apiKey || !currentModelId()) {
    showToast('请先完成连接设置。');
    return;
  }
  elements.compactNowButton.disabled = true;
  setConnection('working');
  try {
    const result = await prepareConversationContext({
      conversation: activeConversation,
      client,
      apiKey: preferences.apiKey,
      model: currentModel(),
      force: true,
    });
    if (!result.compacted) {
      showToast('当前还没有足够的较早对话可供优化。');
      return;
    }
    activeConversation = result.conversation;
    await persistConversation(activeConversation);
    renderConversation();
    showToast('上下文摘要已更新。');
  } catch (error) {
    showToast(`优化失败：${error.message}`);
  } finally {
    elements.compactNowButton.disabled = false;
    setConnection('connected');
  }
}

async function clearAllData() {
  if (!window.confirm('确定清除密钥、设置和全部历史对话吗？此操作无法恢复。')) return;
  await stopGenerationAndWait(activeController, activeGenerationPromise);
  activeGenerationPromise = null;
  try {
    await store.clear();
    clearPreferences();
    preferences = loadPreferences();
    conversations = [];
    models = [];
    activeConversation = createConversation();
    conversations.push(activeConversation);
    await store.put(activeConversation);
    updateModelUi();
    renderConversation();
    renderHistory();
    elements.settingsDialog.close();
    setConnection('idle');
    showToast('本机数据已全部清除。');
    openSettings({ focusKey: true });
  } catch (error) {
    showToast(`清除失败：${error.message}`);
  }
}

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  sendDraft();
});

elements.messageInput.addEventListener('input', resizeComposer);
window.addEventListener('resize', scheduleViewportSync, { passive: true });
window.visualViewport?.addEventListener('resize', scheduleViewportSync, { passive: true });
window.visualViewport?.addEventListener('scroll', scheduleViewportSync, { passive: true });
elements.chatMain.addEventListener('scroll', () => {
  followLatest = isNearScrollBottom(elements.chatMain);
}, { passive: true });
elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendDraft();
  }
});

elements.stopButton.addEventListener('click', () => activeController?.abort());
elements.historyButton.addEventListener('click', openHistory);
elements.closeHistoryButton.addEventListener('click', closeHistory);
elements.drawerBackdrop.addEventListener('click', closeHistory);
elements.newChatButton.addEventListener('click', createNewChat);
elements.drawerNewChatButton.addEventListener('click', createNewChat);
elements.settingsButton.addEventListener('click', () => openSettings());
elements.modelButton.addEventListener('click', () => openSettings());

elements.toggleKeyButton.addEventListener('click', () => {
  const reveal = elements.apiKeyInput.type === 'password';
  elements.apiKeyInput.type = reveal ? 'text' : 'password';
  elements.toggleKeyButton.textContent = reveal ? '隐藏' : '显示';
});

elements.modelSelect.addEventListener('change', () => {
  preferences.selectedModel = elements.modelSelect.value;
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    elements.settingsDialog.close();
    return;
  }
  if (!proxyConfigured) {
    showToast('请先按照 README 配置 Worker 地址。');
    return;
  }

  const apiKey = elements.apiKeyInput.value.trim();
  if (!apiKey) {
    showToast('请输入 JBB API 密钥。');
    elements.apiKeyInput.focus();
    return;
  }

  preferences.apiKey = apiKey;
  preferences.manualModel = elements.manualModelInput.value.trim();
  preferences.selectedModel = elements.modelSelect.value || preferences.selectedModel;
  saveCurrentPreferences();

  try {
    await refreshModels();
    const selected = currentModelId();
    if (!selected) {
      preferences.manualModel = elements.manualModelInput.value.trim();
      preferences.selectedModel = chooseModel([], '', preferences.manualModel);
      if (!preferences.selectedModel) {
        showToast('没有识别到 Grok 模型，请填写包含“grok”的模型名称。');
        elements.manualModelField.hidden = false;
        elements.manualModelInput.focus();
        return;
      }
    }
    saveCurrentPreferences();
    activeConversation.modelId = currentModelId();
    await persistConversation(activeConversation);
    updateModelUi();
    elements.settingsDialog.close();
    showNotice('');
    showToast(`已连接 ${currentModelId()}`);
  } catch (error) {
    showToast(error.message);
    elements.apiKeyInput.focus();
  }
});

elements.clearDataButton.addEventListener('click', clearAllData);
elements.compactNowButton.addEventListener('click', compactCurrentConversation);

elements.viewMemoryButton.addEventListener('click', () => {
  renderMarkdown(elements.memoryContent, activeConversation.memorySummary || '当前还没有上下文摘要。');
  elements.memoryDialog.showModal();
});
elements.closeMemoryButton.addEventListener('click', () => elements.memoryDialog.close());

elements.messageList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const message = activeConversation.messages.find((item) => item.id === button.dataset.messageId);
  if (!message) return;
  if (button.dataset.action === 'copy') {
    try {
      await navigator.clipboard.writeText(message.content);
      showToast('已复制回答。');
    } catch {
      showToast('复制失败，请长按文字手动复制。');
    }
  }
  if (button.dataset.action === 'retry') await retryMessage(message.id);
});

elements.historyList.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const conversation = conversations.find((item) => item.id === button.dataset.conversationId);
  if (!conversation) return;

  if (button.dataset.action === 'select') {
    activeController?.abort();
    activeConversation = conversation;
    renderConversation();
    renderHistory();
    closeHistory();
  }

  if (button.dataset.action === 'rename') {
    const title = window.prompt('输入新的对话名称', conversation.title)?.trim();
    if (!title) return;
    conversation.title = [...title].slice(0, 48).join('');
    conversation.updatedAt = Date.now();
    await persistConversation(conversation);
    renderHistory();
  }

  if (button.dataset.action === 'delete') {
    if (!window.confirm(`确定删除“${conversation.title}”吗？`)) return;
    if (activeConversation.id === conversation.id) {
      await stopGenerationAndWait(activeController, activeGenerationPromise);
      activeGenerationPromise = null;
    }
    try {
      await store.delete(conversation.id);
      conversations = conversations.filter((item) => item.id !== conversation.id);
      if (activeConversation.id === conversation.id) {
        activeConversation = conversations[0] || createConversation({ modelId: currentModelId() });
        if (!conversations.length) {
          conversations.push(activeConversation);
          await store.put(activeConversation);
        }
      }
      renderConversation();
      renderHistory();
    } catch (error) {
      showToast(`删除失败：${error.message}`);
    }
  }
});

async function initialize() {
  try {
    conversations = (await store.list()).map(normalizeLoadedConversation);
    if (!conversations.length) {
      const conversation = createConversation({ modelId: preferences.selectedModel || preferences.manualModel });
      conversations = [conversation];
      await store.put(conversation);
    }
    activeConversation = conversations[0];
    renderConversation();
    renderHistory();
  } catch (error) {
    activeConversation = createConversation({ modelId: preferences.selectedModel || preferences.manualModel });
    conversations = [activeConversation];
    renderConversation();
    showNotice(`浏览器无法保存历史：${error.message}`);
  }

  if (!proxyConfigured) {
    showNotice('部署尚未完成：请先按 README 写入你的 Cloudflare Worker 地址。');
    openSettings();
    return;
  }

  if (!preferences.apiKey) {
    openSettings({ focusKey: true });
    return;
  }

  try {
    await refreshModels({ silent: true });
    if (!currentModelId()) openSettings();
  } catch (error) {
    showToast(error.message);
    openSettings({ focusKey: true });
  }
}

syncViewportGeometry();
initialize();
