export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const DEFAULT_UPSTREAM = 'https://jbbtoken.pages.dev';
const DEFAULT_ORIGIN = 'https://int-yu.github.io';
const ALLOWED_PATHS = new Map([
  ['/v1/models', 'GET'],
  ['/v1/chat/completions', 'POST'],
]);

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    vary: 'Origin',
  };
}

function jsonError(message, status, origin = '') {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

function safeResponseHeaders(upstreamHeaders, origin) {
  const headers = new Headers(corsHeaders(origin));
  for (const name of ['content-type', 'retry-after', 'x-request-id']) {
    const value = upstreamHeaders.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function hasValidAuthorization(request) {
  return /^Bearer\s+\S+/i.test(request.headers.get('authorization') || '');
}

function parseAllowedOrigins(value) {
  const origins = String(value || DEFAULT_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length ? origins : [DEFAULT_ORIGIN];
}

export function createWorkerHandler({
  fetchImpl = globalThis.fetch,
  upstreamBase = DEFAULT_UPSTREAM,
  allowedOrigins = [DEFAULT_ORIGIN],
} = {}) {
  const allowed = new Set(allowedOrigins);

  return async function handleRequest(request) {
    const origin = request.headers.get('origin') || '';
    if (!allowed.has(origin)) return jsonError('不允许的请求来源', 403);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const expectedMethod = ALLOWED_PATHS.get(url.pathname);
    if (!expectedMethod) return jsonError('接口不存在', 404, origin);
    if (request.method !== expectedMethod) return jsonError('请求方法不允许', 405, origin);
    if (!hasValidAuthorization(request)) return jsonError('缺少有效的 API 密钥', 401, origin);

    let body;
    if (request.method === 'POST') {
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return jsonError('请求必须使用 JSON 格式', 415, origin);
      }

      const declaredLength = Number(request.headers.get('content-length') || 0);
      if (declaredLength > MAX_REQUEST_BYTES) return jsonError('请求内容过大', 413, origin);

      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_REQUEST_BYTES) return jsonError('请求内容过大', 413, origin);
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return jsonError('JSON 内容无效', 400, origin);
      }

      if (typeof body?.model !== 'string' || !body.model.toLowerCase().includes('grok')) {
        return jsonError('只允许使用 Grok 模型', 400, origin);
      }
      if (!Array.isArray(body.messages)) return jsonError('messages 必须是数组', 400, origin);
    }

    const upstreamHeaders = new Headers({
      authorization: request.headers.get('authorization'),
      accept: request.method === 'POST' ? 'text/event-stream, application/json' : 'application/json',
    });
    if (body !== undefined) upstreamHeaders.set('content-type', 'application/json');

    let upstreamResponse;
    try {
      upstreamResponse = await fetchImpl(new Request(`${upstreamBase}${url.pathname}`, {
        method: request.method,
        headers: upstreamHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      }));
    } catch {
      return jsonError('无法连接上游服务', 502, origin);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: safeResponseHeaders(upstreamResponse.headers, origin),
    });
  };
}

export default {
  fetch(request, env) {
    return createWorkerHandler({
      allowedOrigins: parseAllowedOrigins(env?.ALLOWED_ORIGINS),
    })(request);
  },
};
