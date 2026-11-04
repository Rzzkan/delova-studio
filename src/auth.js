import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getSecret } from './share.js';

export const COOKIE = 'ts_session';
export const loginEnabled = () => Boolean(config.adminPassword);

const sha = (s) => createHash('sha256').update(String(s)).digest();
export const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b));

export function checkCredentials(user, password) {
  const u = safeEqual(user ?? '', config.adminUser);
  const p = safeEqual(password ?? '', config.adminPassword); // keduanya selalu dievaluasi
  return u && p;
}

// Kunci sesi ikut berubah saat ADMIN_PASSWORD diganti, jadi semua sesi lama otomatis tidak berlaku.
async function key() {
  return createHmac('sha256', await getSecret()).update('session:' + sha(config.adminPassword).toString('hex')).digest();
}

export async function makeToken(user) {
  const exp = Math.floor(Date.now() / 1000) + config.sessionHours * 3600;
  const body = `${Buffer.from(user).toString('base64url')}.${exp}`;
  return `${body}.${createHmac('sha256', await key()).update(body).digest('base64url')}`;
}

export async function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [u, exp, sig] = parts;
  const want = createHmac('sha256', await key()).update(`${u}.${exp}`).digest('base64url');
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  if (!(Number(exp) * 1000 > Date.now())) return null;
  return Buffer.from(u, 'base64url').toString();
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const setCookie = (value, { secure }) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionHours * 3600}${secure ? '; Secure' : ''}`;
export const clearCookie = ({ secure }) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
