/* session.mjs -- the bot check's memory: a signed, short-lived cookie.
   Turnstile is asked once; a passing visitor gets an HMAC token bound to the
   day's hashed address, and later requests show the token instead of a new
   challenge. Pure WebCrypto, so node tests it. */
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const keyFor = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sign = async (secret, payload) => b64u(await crypto.subtle.sign('HMAC', await keyFor(secret), enc.encode(payload)));

export const SESSION_COOKIE = 'assist_session';
export const SESSION_TTL_MS = 60 * 60 * 1000;

export async function makeSession(secret, who, now = Date.now(), ttlMs = SESSION_TTL_MS) {
  const payload = `${who}.${now + ttlMs}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function checkSession(secret, token, who, now = Date.now()) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== who) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < now) return false;
  const expect = await sign(secret, `${parts[0]}.${parts[1]}`);
  if (expect.length !== parts[2].length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ parts[2].charCodeAt(i);
  return diff === 0;
}

export function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Ask Cloudflare whether a widget token is good. */
export async function verifyTurnstile(secret, token, ip, fetchFn = fetch) {
  if (!token) return { ok: false, codes: ['missing-input-response'] };
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    if (!r.ok) return { ok: false, codes: [`http_${r.status}`] };
    const j = await r.json();
    return { ok: !!j.success, codes: j['error-codes'] || [] };
  } catch (err) {
    return { ok: false, codes: ['unreachable'] };
  }
}
