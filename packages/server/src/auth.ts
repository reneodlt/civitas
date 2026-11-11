import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthHook, AuthIdentity } from './net';

/**
 * Sign-in with Hanko (https://hanko.io, docs/accounts.md). Node only: net.ts sees just the AuthHook interface, so the
 * local-mode worker never loads this file.
 *
 * The browser signs in with Hanko's <hanko-auth> element and sends the session token (a JWT) in its hello. This checks the
 * token against the Hanko API's public keys (`/.well-known/jwks.json`, fetched once and cached by jose) and, when
 * HANKO_AUDIENCE is set, its `aud`. The token's `sub` is the Hanko user id; accounts.json binds it to one mayor (a player id).
 */
export interface HankoOptions {
  /** the Hanko API URL: the tenant's URL on Hanko Cloud (https://<id>.hanko.io) or a self-hosted hanko's public API */
  apiUrl: string;
  /** checked against the token's `aud` when set (Hanko's audience is the app's domain by default) */
  audience?: string;
  /** where the account bindings live (ACCOUNTS_FILE; by default accounts.json beside the world file) */
  file: string;
  /** AUTH_CLAIM_EXISTING=1: the first account to ask for a name a player already has (from before sign-in) takes that player */
  claimExisting?: boolean;
}

/** One sign-in's binding: the Hanko user (`sub`) is this player, under this name. */
interface Account { player: string; name: string; created: string; email?: string }
interface AccountsFile { version: 1; accounts: Record<string, Account> }

export function hankoAuth(o: HankoOptions): AuthHook {
  const apiUrl = o.apiUrl.replace(/\/+$/, '');
  const jwks = createRemoteJWKSet(new URL(`${apiUrl}/.well-known/jwks.json`));
  return {
    ...accountStore(o.file),
    claimExisting: !!o.claimExisting,
    async verify(token: string): Promise<AuthIdentity | null> {
      try {
        const { payload } = await jwtVerify(token, jwks, o.audience ? { audience: o.audience } : {});
        if (typeof payload.sub !== 'string' || !payload.sub) return null;
        const email = (payload as { email?: { address?: unknown } }).email?.address;
        return { sub: payload.sub, ...(typeof email === 'string' ? { email } : {}) };
      } catch (e) {
        // an expired or forged token is the player's problem (they sign in again); anything else (the JWKS unreachable) is ours
        const code = (e as { code?: string }).code ?? '';
        if (!code.startsWith('ERR_JWT') && !code.startsWith('ERR_JWS')) console.warn('hanko: token check failed:', (e as Error).message);
        return null;
      }
    },
  };
}

/**
 * Dev and UAT sign-in without a Hanko tenant (docs/accounts.md, "Dev sign-in"): DEV_AUTH_USERS="ana:pass,ben:pass" lists the
 * test logins. The page posts a user and password to POST /api/auth/dev; a match gets a token (HMAC-signed, 12 hours) that the
 * hello carries exactly as it would carry Hanko's, so everything after the token (accounts, the name step, expiry) is the same
 * code. The account id is `dev:<user>`, never a Hanko id. The key is DEV_AUTH_SECRET, or a random one per start (tokens then die
 * with a restart and the page asks again). Plain-text passwords in the environment: testing only, never a public server.
 */
export interface DevAuthOptions { users: string; secret?: string; file: string; claimExisting?: boolean }
const DEV_TOKEN_MS = 12 * 3600_000;

export function devAuth(o: DevAuthOptions): { hook: AuthHook; handle(req: IncomingMessage, res: ServerResponse): boolean } {
  const users = new Map<string, string>();
  for (const pair of o.users.split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) users.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1));
  }
  if (!users.size) throw new Error('DEV_AUTH_USERS has no user:password pairs');
  const key = o.secret ? Buffer.from(o.secret) : randomBytes(32);
  const sign = (body: string) => createHmac('sha256', key).update(body).digest('base64url');
  const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const hook: AuthHook = {
    ...accountStore(o.file),
    claimExisting: !!o.claimExisting,
    async verify(token: string) {
      const [body, mac] = token.split('.');
      if (!body || !mac || !same(mac, sign(body))) return null;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { sub?: unknown; exp?: unknown };
        if (typeof p.sub !== 'string' || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
        return users.has(p.sub.slice(4)) ? { sub: p.sub } : null; // a user taken off the list is signed out
      } catch { return null; }
    },
  };
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split('?')[0] !== '/api/auth/dev') return false;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (req.method !== 'POST') { res.writeHead(405, cors); res.end(); return true; }
    let raw = '';
    req.on('data', (d: Buffer) => { raw += d; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let user = '', password = '';
      try { const j = JSON.parse(raw) as { user?: unknown; password?: unknown }; user = String(j.user ?? '').trim().toLowerCase(); password = String(j.password ?? ''); } catch { /* refused below */ }
      const want = users.get(user);
      if (want === undefined || !same(password, want)) {
        res.writeHead(401, { ...cors, 'content-type': 'application/json' });
        return res.end('{"error":"Unknown user or wrong password"}');
      }
      const exp = Date.now() + DEV_TOKEN_MS;
      const body = Buffer.from(JSON.stringify({ sub: `dev:${user}`, exp })).toString('base64url');
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: `${body}.${sign(body)}`, exp }));
    });
    return true;
  };
  return { hook, handle };
}

/** The account bindings (accounts.json), shared by every provider: a provider's user id -> the player it is. */
function accountStore(file: string): Pick<AuthHook, 'accountOf' | 'holderOf' | 'bind'> {
  const store = loadAccounts(file);
  /** player id -> account id, the reverse of the file */
  const holders = new Map<string, string>();
  for (const [sub, a] of Object.entries(store.accounts)) holders.set(a.player, sub);
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(store, null, 1));
    renameSync(tmp, file);
  };
  return {
    accountOf(sub) { const a = store.accounts[sub]; return a ? { player: a.player, name: a.name } : undefined; },
    holderOf: (player) => holders.get(player),
    bind(who, player, name) {
      store.accounts[who.sub] = { player, name, created: new Date().toISOString(), ...(who.email ? { email: who.email } : {}) };
      holders.set(player, who.sub);
      save();
    },
  };
}

function loadAccounts(file: string): AccountsFile {
  if (!existsSync(file)) return { version: 1, accounts: {} };
  const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountsFile>; // a file that does not parse stops the server: never start over someone's accounts
  return { version: 1, accounts: j.accounts ?? {} };
}
