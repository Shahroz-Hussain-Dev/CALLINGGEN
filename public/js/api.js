/** Thin fetch wrapper. Cookie session + CSRF marker header on every request. */
export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

async function request(method, path, body, opts = {}) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: opts.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Network error: could not reach the server. Check your connection and try again.');
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const err = data && data.error ? data.error : { code: 'http_' + res.status, message: res.statusText || 'Request failed' };
    if (res.status === 401 && !path.startsWith('/api/auth/login')) window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body === undefined ? {} : body, opts),
  patch: (path, body, opts) => request('PATCH', path, body || {}, opts),
  del: (path, opts) => request('DELETE', path, undefined, opts),
  qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? '?' + s : '';
  },
};
