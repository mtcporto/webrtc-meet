const SESSION_SECONDS = 8 * 60 * 60;
export const TURN_TTL_SECONDS = 2 * 60 * 60;
const encoder = new TextEncoder();
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decode(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export function turnConfigured(env) {
  return Boolean(env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_KEY_API_TOKEN && env.TURN_SESSION_SECRET?.length >= 32);
}
export async function issueTurnSession(env, identity, now = Date.now()) {
  if (!turnConfigured(env)) return null;
  const payload = encode(encoder.encode(JSON.stringify({ v: 1, ...identity, exp: Math.floor(now / 1000) + SESSION_SECONDS })));
  const signature = await crypto.subtle.sign('HMAC', await key(env.TURN_SESSION_SECRET), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyTurnSession(env, token, now = Date.now()) {
  if (!turnConfigured(env) || typeof token !== 'string' || token.length > 4096) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await key(env.TURN_SESSION_SECRET), decode(parts[1]), encoder.encode(parts[0]))) return null;
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const timestamp = Math.floor(now / 1000);
    if (payload.v !== 1 || !Number.isInteger(payload.exp) || payload.exp <= timestamp || payload.exp > timestamp + SESSION_SECONDS) return null;
    if (!['room', 'id', 'participantId'].every(k => typeof payload[k] === 'string' && payload[k].length > 0) || !Number.isInteger(payload.generation)) return null;
    return payload;
  } catch { return null; }
}
export function allowedTurnOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // Non-browser clients still require a signed active session.
  try {
    const url = new URL(origin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return ['http:', 'https:'].includes(url.protocol);
    return url.protocol === 'https:' && (
      ['agoraone.vercel.app', 'calls-gamma.vercel.app'].includes(url.hostname)
      || /^calls-[a-z0-9-]+-marco-portos-projects\.vercel\.app$/.test(url.hostname)
    );
  } catch { return false; }
}
export async function generateTurnServers(env, fetchImpl = fetch) {
  const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'AgoraOne-TURN/1.0' },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }), signal: AbortSignal.timeout(10000), redirect: 'manual',
  });
  if (!response.ok) throw new Error('turn_provider_http_' + response.status);
  const data = await response.json();
  if (!Array.isArray(data.iceServers) || !data.iceServers.some(s => Array.isArray(s.urls) && s.urls.some(url => /^turns?:/.test(url)) && typeof s.username === 'string' && typeof s.credential === 'string')) throw new Error('invalid_turn_response');
  return { iceServers: data.iceServers, expiresAt: Date.now() + TURN_TTL_SECONDS * 1000 };
}
