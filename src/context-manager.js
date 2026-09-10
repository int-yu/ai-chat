import {
  DEFAULT_OUTPUT_RESERVE,
  RETAINED_TURNS,
  buildApiMessages,
  buildSummaryMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  resolveContextWindow,
  shouldCompact,
  splitForCompaction,
} from './context.js';

export class MessageTooLongError extends Error {
  constructor() {
    super('这条消息本身超过模型可用的上下文长度，请拆分成几条较短的消息后重试。');
    this.name = 'MessageTooLongError';
  }
}

function isSendable(message) {
  return ['user', 'assistant'].includes(message?.role)
    && typeof message.content === 'string'
    && message.content.length > 0
    && message.status !== 'error';
}

function pendingEntries(conversation) {
  const compactedCount = Number.isInteger(conversation.compactedMessageCount)
    ? conversation.compactedMessageCount
    : 0;
  return conversation.messages
    .slice(compactedCount)
    .map((message, offset) => ({
      ...message,
      sourceIndex: compactedCount + offset,
    }))
    .filter(isSendable);
}

function stripInternalFields(messages) {
  return messages.map(({ role, content }) => ({ role, content }));
}

export async function prepareConversationContext({
  conversation,
  client,
  apiKey,
  model,
  force = false,
  outputReserve = DEFAULT_OUTPUT_RESERVE,
  retainedTurns = RETAINED_TURNS,
  signal,
}) {
  const contextWindow = resolveContextWindow(model);
  const entries = pendingEntries(conversation);
  const latestUserMessage = [...entries].reverse().find((message) => message.role === 'user');
  const usableWindow = Math.max(1, contextWindow - outputReserve);
  if (latestUserMessage && estimateTextTokens(latestUserMessage.content) + 6 >= usableWindow) {
    throw new MessageTooLongError();
  }

  const currentApiMessages = buildApiMessages(
    conversation.memorySummary,
    stripInternalFields(entries),
  );
  const estimatedTokens = estimateMessagesTokens(currentApiMessages);
  const needsCompaction = force || shouldCompact(estimatedTokens, contextWindow, outputReserve);
  const { older, recent } = splitForCompaction(entries, retainedTurns);

  if (!needsCompaction || older.length === 0) {
    return {
      conversation,
      apiMessages: currentApiMessages,
      compacted: false,
      estimatedTokens,
      contextWindow,
    };
  }

  const summary = await client.summarize({
    apiKey,
    model: model?.id || conversation.modelId,
    messages: buildSummaryMessages(
      conversation.memorySummary,
      stripInternalFields(older),
    ),
    signal,
  });
  const nextBoundary = older.at(-1).sourceIndex + 1;
  const updatedConversation = {
    ...conversation,
    memorySummary: summary,
    compactedMessageCount: nextBoundary,
    compactionCount: (conversation.compactionCount || 0) + 1,
    contextWindow,
    updatedAt: Date.now(),
  };

  return {
    conversation: updatedConversation,
    apiMessages: buildApiMessages(summary, stripInternalFields(recent)),
    compacted: true,
    estimatedTokens: estimateMessagesTokens(buildApiMessages(summary, stripInternalFields(recent))),
    contextWindow,
  };
}
