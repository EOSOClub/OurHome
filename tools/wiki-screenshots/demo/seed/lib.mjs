// Tiny HTTP client for the throwaway demo server ONLY (http://localhost:3100).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = 'http://localhost:3100';
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = path.join(HERE, 'state.json');

export function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t}`, ...a);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
export function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function cronSecret() {
  const env = fs.readFileSync(path.join(HERE, '..', '.env'), 'utf8');
  const get = (k) => env.split(/\r?\n/).find((l) => l.startsWith(k + '='))?.slice(k.length + 1).trim();
  return { main: get('CRON_SECRET'), dev: get('DEV_CRON_SECRET') };
}

/** A signed-in client with its own cookie jar. */
export class Client {
  constructor(name) { this.name = name; this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async raw(method, p, body, extraHeaders = {}) {
    if (!p.startsWith('/')) throw new Error('path must start with /');
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        cookie: this.cookieHeader(),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (v === '' || /max-age=0/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  }
  async call(method, p, body) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.raw(method, p, body);
      if (r.status === 429 && attempt < 5) { log(`  [${this.name}] 429 on ${p}, waiting 15s`); await sleep(15000); continue; }
      if (r.status >= 400 || (r.json && r.json.ok === false)) {
        const msg = JSON.stringify(r.json).slice(0, 600);
        throw new Error(`[${this.name}] ${method} ${p} -> ${r.status}: ${msg}`);
      }
      return r.json && r.json.ok !== undefined ? r.json.data : r.json;
    }
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b ?? {}); }
  async signIn(username, password) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.raw('POST', '/api/auth/sign-in/username', { username, password });
      if (r.status === 429 && attempt < 6) { log(`  sign-in rate limited, waiting 11s`); await sleep(11000); continue; }
      if (r.status >= 400) throw new Error(`sign-in ${username} -> ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      log(`  signed in as ${username}`);
      await sleep(3500); // Better Auth sign-in limit is 3 per 10s
      return r.json;
    }
  }
}

/** Signed-in clients for every member, reusing saved session cookies when still valid. */
export async function clients(keys = ['alex', 'sam', 'jordan', 'riley', 'mia']) {
  const st = loadState();
  st.cookies = st.cookies ?? {};
  const out = {};
  for (const k of keys) {
    const c = new Client(k);
    if (st.cookies[k]) {
      c.cookies = st.cookies[k];
      const r = await c.raw('GET', '/api/profile');
      if (r.status === 200) { out[k] = c; log(`  reused session for ${k}`); continue; }
      c.cookies = {};
    }
    await c.signIn(k, 'DemoHouse!2026');
    st.cookies[k] = c.cookies;
    out[k] = c;
  }
  const latest = loadState();
  latest.cookies = st.cookies;
  saveState(latest);
  return out;
}

/** Days relative to "today" (2026-10-11), at a local-ish hour (America/Chicago = UTC-5 in Oct). */
export function day(offset, hour = 12, minute = 0) {
  const d = new Date(Date.UTC(2026, 9, 11, hour + 5, minute));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString();
}
