/**
 * Sign-in (docs/accounts.md), end to end through the game's Net with the dev provider (auth.ts devAuth), no network:
 *   npm run auth:check
 * A real HTTP login for a token, then hellos: no token, a forged or expired one, a new account's name step, a name another account
 * holds, a name from before sign-in (with and without AUTH_CLAIM_EXISTING), and a returning account entering as its mayor whatever
 * name it types. Hanko's half (the JWKS check) is jose's and is not run here.
 */
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ServerMsg } from '@msimcity/shared';
import { World } from './world';
import { seedCommons } from './seed';
import { createGame } from './game';
import { devAuth } from './auth';
import type { Conn } from './transport';

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

const dir = mkdtempSync(join(tmpdir(), 'civitas-auth-'));
const file = join(dir, 'accounts.json');
const dev = devAuth({ users: 'ana:pw-a,ben:pw-b', secret: 'check', file });

// ---- the login endpoint, over real HTTP ----
const http = createServer((req, res) => { if (!dev.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
const login = async (user: string, password: string) => {
  const r = await fetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, password }) });
  return { status: r.status, ...((await r.json()) as { token?: string; error?: string }) };
};
const bad = await login('ana', 'nope');
ok(bad.status === 401 && !bad.token, 'a wrong password is refused (401, no token)');
ok((await login('zed', 'pw-a')).status === 401, 'an unknown user is refused');
const ana = await login('Ana', 'pw-a'), ben = await login('ben', 'pw-b');
ok(ana.status === 200 && !!ana.token && !!ben.token, 'the listed users get tokens (user names ignore case)');
ok((await fetch(`${base}/api/auth/dev`)).status === 405, 'GET on the login endpoint is refused');
http.close();

// ---- the game, with a player from before sign-in ----
const world = new World(7);
seedCommons(world);
let accept: ((c: Conn) => void) | null = null;
const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, auth: dev.hook }, 1);
world.getOrCreatePlayer('old-timer', 'Old Timer', 1000);

/** a socket: say hello, wait for the auth message or the welcome */
async function hello(name: string, token?: string): Promise<ServerMsg | undefined> {
  const got: ServerMsg[] = [];
  let onMsg: ((d: string) => void) | null = null;
  accept!({ open: true, send: (d) => { got.push(JSON.parse(d)); }, close() {}, onMessage: (fn) => { onMsg = fn; }, onClose() {} });
  onMsg!(JSON.stringify({ t: 'hello', name, ...(token ? { token } : {}) }));
  for (let i = 0; i < 50 && !got.some((m) => m.t === 'auth' || m.t === 'welcome'); i++) await new Promise((r) => setTimeout(r, 5));
  return got.find((m) => m.t === 'auth' || m.t === 'welcome');
}
const isAuth = (m: ServerMsg | undefined, need: 'signIn' | 'name') => m?.t === 'auth' && m.need === need;

ok(isAuth(await hello('Ana'), 'signIn'), 'a hello with no token is asked to sign in');
ok(isAuth(await hello('Ana', ana.token!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), 'signIn'), 'a forged token is asked to sign in again');
// signed with the same key, so only its expiry is wrong
const expiredBody = Buffer.from(JSON.stringify({ sub: 'dev:ana', exp: Date.now() - 1 })).toString('base64url');
const expired = `${expiredBody}.${createHmac('sha256', Buffer.from('check')).update(expiredBody).digest('base64url')}`;
ok(isAuth(await hello('Ana', expired), 'signIn'), 'an expired token is asked to sign in again');
ok(isAuth(await hello('', ana.token), 'name'), 'a new account with no name is asked for one');
ok(isAuth(await hello('Old Timer', ana.token), 'name'), 'a name from before sign-in is refused without AUTH_CLAIM_EXISTING');
const w1 = await hello('Mayor Ana', ana.token);
ok(w1?.t === 'welcome' && w1.you === 'mayor-ana', 'a new account with a free name enters as that mayor');
ok(existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).accounts['dev:ana']?.player === 'mayor-ana', 'the binding is saved in accounts.json');
const t = await hello('mayor ana', ben.token);
ok(isAuth(t, 'name') && t?.t === 'auth' && /taken/.test(t.msg ?? ''), "another account cannot have that name (the same id, other spelling)");
const w2 = await hello('Somebody Else', ana.token);
ok(w2?.t === 'welcome' && w2.you === 'mayor-ana', 'a returning account enters as its mayor whatever name it types');
const fresh = devAuth({ users: 'ana:pw-a,ben:pw-b', secret: 'check', file });
ok(fresh.hook.accountOf('dev:ana')?.player === 'mayor-ana' && fresh.hook.holderOf('mayor-ana') === 'dev:ana', 'the binding survives a restart');

// ---- AUTH_CLAIM_EXISTING ----
const claim = devAuth({ users: 'ben:pw-b', secret: 'check', file: join(dir, 'claim.json'), claimExisting: true });
(game.net as unknown as { cfg: { auth: unknown } }).cfg.auth = claim.hook;
const w3 = await hello('Old Timer', ben.token);
ok(w3?.t === 'welcome' && w3.you === 'old-timer', 'with AUTH_CLAIM_EXISTING the first account to ask takes a player from before sign-in');

console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
