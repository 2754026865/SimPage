export const DATA_BODY_LIMIT = 512 * 1024;
export const AUTH_BODY_LIMIT = 4096;
export const MAX_COLLECTION_ITEMS = 1000;
export const inputError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function readBoundedJson(request, maxBytes = DATA_BODY_LIMIT) {
  const type = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw inputError('请求必须使用 application/json。', 415);
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw inputError('请求数据超出大小限制。', 413);
  if (!request.body) throw inputError('请求数据不能为空。');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw inputError('请求数据超出大小限制。', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw inputError('请求 JSON 格式不正确。'); }
}

export function limitedText(value, name, max, { required = false } = {}) {
  if (typeof value !== 'string') {
    if (value == null && !required) return '';
    throw inputError(`${name}格式不正确。`);
  }
  const text = value.trim();
  if (required && !text) throw inputError(`${name}不能为空。`);
  if (text.length > max) throw inputError(`${name}不能超过 ${max} 个字符。`);
  return text;
}

export function checkedUrl(value, name, { allowEmpty = true, allowRelative = false } = {}) {
  const text = limitedText(value, name, 2048, { required: !allowEmpty });
  if (!text) return '';
  if (/[\u0000-\u0020\u007f\\]/.test(text)) throw inputError(`${name}包含无效字符。`);
  if (allowRelative && text.startsWith('/') && !text.startsWith('//')) return text;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) throw inputError(`${name}仅支持 HTTP 或 HTTPS。`);
  let parsed;
  try { parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw inputError(`${name}格式不正确。`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw inputError(`${name}不能包含账号密码或其他协议。`);
  return parsed.href;
}

// Icons may be image URLs/data URLs or a short text/emoji fallback. They are
// rendered in image/text contexts only, never as HTML or a navigation target.
export function checkedIcon(value, name = '图标') {
  const text = limitedText(value, name, 8192);
  if (!text) return '';
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(text)) return text;
  if (/^https?:\/\//i.test(text) || text.startsWith('/')) return checkedUrl(text, name, { allowRelative: true });
  if (/^[a-z][a-z\d+.-]*:/i.test(text) || /[\u0000-\u001f\u007f<>]/.test(text)) throw inputError(`${name}格式不正确。`);
  if (Array.from(text).length > 16) throw inputError(`${name}请使用图片地址或简短的文字、表情。`);
  return text;
}

export function requiredVersion(body) {
  if (!Number.isSafeInteger(body?._version) || body._version < 0) throw inputError('缺少有效的数据版本，请刷新后重试。', 409);
  return body._version;
}
