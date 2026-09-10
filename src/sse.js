function abortError() {
  return new DOMException('请求已停止', 'AbortError');
}

export function createSseParser(onEvent) {
  let buffer = '';
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length > 0) {
      onEvent(dataLines.join('\n'));
      dataLines = [];
    }
  };

  const consumeLine = (line) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line === 'data') {
      dataLines.push('');
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(line);
      }
    },
    finish() {
      if (buffer.length > 0) consumeLine(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    },
  };
}

export async function readChatStream(stream, options = {}) {
  const { onDelta = () => {}, onUsage = () => {}, signal } = options;
  if (signal?.aborted) throw abortError();

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let streamError;

  const parser = createSseParser((data) => {
    if (data === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error('服务返回了无法解析的流式数据');
    }

    if (payload?.error) {
      streamError = new Error(payload.error.message || '服务返回错误');
      return;
    }

    const delta = payload?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      fullText += delta;
      onDelta(delta, fullText);
    }
    if (payload?.usage) onUsage(payload.usage);
  });

  const handleAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener('abort', handleAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (streamError) throw streamError;
    }
    parser.push(decoder.decode());
    parser.finish();
    if (streamError) throw streamError;
    return fullText;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    reader.releaseLock();
  }
}
