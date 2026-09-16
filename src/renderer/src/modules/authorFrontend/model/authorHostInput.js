import { AUTHOR_API_VERSION } from '@eleckoi/author-sdk';

const hostInputMethods = new Set([
  'input.get',
  'input.set',
  'input.append',
  'input.clear',
  'input.send',
]);

function success(id, result) {
  return JSON.stringify({ id, ok: true, result: result ?? null });
}

function failure(id, code, message) {
  return JSON.stringify({ id, ok: false, error: { code, message } });
}

function requestHostInput(conversationId, method, params) {
  return new Promise((resolve, reject) => {
    let claimed = false;
    try {
      window.dispatchEvent(new CustomEvent('eleckoi:author-input-request', { detail: {
        conversationId,
        method,
        params,
        claim() {
          if (claimed) throw Object.assign(new Error('输入框操作已经由当前对话接收'), { code: 'INPUT_ALREADY_CLAIMED' });
          claimed = true;
          return { resolve, reject };
        },
      } }));
    } catch (error) {
      reject(error);
      return;
    }
    if (!claimed) reject(Object.assign(new Error('当前对话输入框尚未就绪'), { code: 'INPUT_UNAVAILABLE' }));
  });
}

export async function routeAuthorHostInputRequest(rawRequest, conversationId) {
  let value;
  try {
    value = JSON.parse(rawRequest);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !hostInputMethods.has(value.method)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    return failure('', 'INVALID_REQUEST', '请求 id 格式不正确');
  }
  if (value.apiVersion !== AUTHOR_API_VERSION) {
    return failure(id, 'UNSUPPORTED_VERSION', `不支持的 API 版本：${String(value.apiVersion || '')}`);
  }
  const params = value.params && typeof value.params === 'object' && !Array.isArray(value.params)
    ? value.params
    : {};
  try {
    return success(id, await requestHostInput(conversationId, value.method, params));
  } catch (error) {
    return failure(id, error?.code || 'INPUT_ERROR', error?.message || '输入框操作失败');
  }
}
