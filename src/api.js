import { normalizeModelsResponse } from './models.js';
import { readChatStream } from './sse.js';

export class ApiError extends Error {
  constructor(message, status = 0, code = '', providerMessage = message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.providerMessage = providerMessage;
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

function authorizationValue(apiKey) {
  const key = String(apiKey ?? '').trim().replace(/^Bearer\s+/i, '');
  return `Bearer ${key}`;
}

function friendlyMessage(status, providerMessage) {
  if (status === 401 || status === 403) return '密钥无效或已过期，请重新检查。';
  if (status === 429) return '请求过于频繁或账户额度不足，请稍后再试。';
  if (status >= 500) return '服务暂时不可用，请稍后重试。';
  return providerMessage || '请求失败，请稍后重试。';
}

async function errorFromResponse(response) {
  let providerMessage = '';
  let code = '';

  try {
    const payload = await response.clone().json();
    providerMessage = payload?.error?.message || payload?.message || '';
    code = payload?.error?.code || payload?.code || '';
  } catch {
    try {
      providerMessage = (await response.text()).trim();
    } catch {
      providerMessage = '';
    }
  }

  return new ApiError(
    friendlyMessage(response.status, providerMessage),
    response.status,
    code,
    providerMessage,
  );
}

export function isContextOverflowError(error) {
  if (!(error instanceof ApiError)) return false;
  const value = `${error.code} ${error.providerMessage} ${error.message}`.toLowerCase();
  return error.status === 400 && (
    value.includes('context_length')
    || value.includes('context length')
    || value.includes('maximum context')
    || value.includes('too many tokens')
  );
}

export function createApiClient({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error('尚未配置 Cloudflare Worker 地址');

  const fetchApi = async (path, { apiKey, method = 'GET', body, signal } = {}) => {
    if (!String(apiKey ?? '').trim()) throw new ApiError('请先填写 JBB API 密钥。');

    let response;
    try {
      response = await fetchImpl(new Request(`${normalizedBaseUrl}${path}`, {
        method,
        headers: {
          authorization: authorizationValue(apiKey),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
      }));
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError('网络连接失败，请检查网络或 Worker 地址。', 0, '', error?.message || '');
    }

    if (!response.ok) throw await errorFromResponse(response);
    return response;
  };

  return {
    async listModels(apiKey, signal) {
      const response = await fetchApi('/v1/models', { apiKey, signal });
      try {
        return normalizeModelsResponse(await response.json());
      } catch {
        throw new ApiError('模型列表格式不正确。', response.status);
      }
    },

    async streamChat({ apiKey, model, messages, signal, onDelta, onUsage }) {
      const response = await fetchApi('/v1/chat/completions', {
        apiKey,
        method: 'POST',
        body: { model, messages, stream: true },
        signal,
      });
      if (!response.body) throw new ApiError('服务没有返回可读取的内容。', response.status);
      return readChatStream(response.body, { signal, onDelta, onUsage });
    },

    async summarize({ apiKey, model, messages, signal }) {
      const response = await fetchApi('/v1/chat/completions', {
        apiKey,
        method: 'POST',
        body: { model, messages, stream: false, max_tokens: 2_048 },
        signal,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ApiError('摘要响应格式不正确。', response.status);
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new ApiError('服务没有返回有效的上下文摘要。', response.status);
      }
      return content.trim();
    },
  };
}
