import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, renameSync, unlinkSync, readFileSync, copyFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICK_MS, DEMO_TOWN, DEMOS, isDemoId, type DemoId, type ServerConfig } from '@msimcity/shared';
import { World } from './world';
import { createGame, tuneEconomy } from './game';
import { WsSource } from './transport-ws';
import { loadWorld, saveWorld } from './store';
import { seedCommons, seedFrontier } from './seed';
import { seedCity } from './loadtest/cities';
import { TestCities, testCitiesAvailable, worldLauncherAvailable, watchIdle, stopsChildrenOn, writeDemoMeta } from './testcities';
import { fillCity } from './fill';
import { seedDemoTown, seedDemoNetwork, seedDemoStudents, seedDemoGraves, fillDemo, seededRandom, worldHash } from './demo/seed';
import { seedDemoAdverts } from './demo/adverts';
import { PerfMonitor } from './perf/monitor';
import { hankoAuth, devAuth } from './auth';
import { demoFireDrills, demoFireRows, demoFireBlasts, demoBlackouts, demoFunerals } from '@msimcity/shared';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA = resolve(process.env.WORLD_FILE ?? join(here, '../../../data/world.json'));
const STATIC = resolve(process.env.STATIC_DIR ?? join(here, '../../client/dist'));
/** The offline build (npm run build:local, relative paths) served under /play/ so the home page can offer the in-browser game from this very site (docs/local-mode.md) */
const PLAY = resolve(process.env.PLAY_DIR ?? join(here, '../../client/dist-local'));
const playAvailable = () => existsSync(join(PLAY, 'index.html'));
/** The public servers the home page lists under Multiplayer (`GET /api/servers`): name, url, region, status 'open' | 'closed' | 'coming', note; read on each request */
const SERVERS_FILE = resolve(process.env.SERVERS_FILE ?? join(here, '../servers.json'));
const SAVE_EVERY_MS = 30_000;
/** Dev knobs: SIM_STEPS runs several simulation ticks per interval (fast-forward); a RESET marker next to the
 *  world file makes the next start discard the world and reseed; SEED_BUILT pre-builds the Commons at that level. */
const SIM_STEPS = Math.max(1, Number(process.env.SIM_STEPS ?? 1) | 0);
/** ECON=name=value,... overrides ECONOMY_TUNING (shared/src/tuning.ts) for an offline economy run */
tuneEconomy(process.env.ECON ?? '');
const RESET_MARKER = join(dirname(DATA), 'RESET');
/** CITY_DISTRICTS=n makes this process a test city (testcities.ts): a fresh world is an n×n-district city built to level 3
 *  and filled with citizens before clients are accepted. Set by the parent server, not by hand (though it works by hand). */
const CITY = Math.max(0, Number(process.env.CITY_DISTRICTS ?? 0) | 0);
/** DEMO=<id> makes this process a demo map (docs/demo.md, shared/src/demo/showcase.ts): a fresh world is the scenario,
 *  seeded through the players' planners and filled before clients are accepted; DEMO_SNAPSHOT is where the filled
 *  world is copied for Reset demo. Set by the parent's world launcher (testcities.ts). */
const DEMO = isDemoId(process.env.DEMO) ? process.env.DEMO : null;
const DEMO_SNAPSHOT = process.env.DEMO_SNAPSHOT;
/** a child world (test city or demo): saves on stop and after its fill, not every 30 s, and stops itself when idle */
const CHILD = CITY > 0 || DEMO !== null;
/** A public showcase (docs/demo.md, "A public showcase"). SPECTATE=1 makes this server read-only for every client: the game refuses every
 *  intent that changes the world (net.ts READ_ONLY), and the world launcher every demo stop, reset and test-city start or stop. The
 *  children inherit it with the rest of the environment (testcities.ts), so every demo is read-only too. DEFAULT_DEMO=<id> sends a page
 *  opened without ?demo=, ?ws= or ?city= to that demo instead of the live world (the client reads both from /api/config), and starts it
 *  with this server so the first visitor does not wait for its fill. */
const SPECTATE = ['1', 'true', 'yes'].includes((process.env.SPECTATE ?? '').toLowerCase());
const DEFAULT_DEMO = isDemoId(process.env.DEFAULT_DEMO) ? process.env.DEFAULT_DEMO : null;
/** DEFAULT_VIEW="x,y,dist,yaw,pitch[,hour]": the camera's opening shot for a page with no camera parameters (yaw and pitch in degrees,
 *  the hour freezes the lighting; client camera.ts CameraShot), through /api/config, so a deployment can retune it without a rebuild */
const DEFAULT_VIEW = /^\s*-?[\d.]+(\s*,\s*-?[\d.]+){4,5}\s*$/.test(process.env.DEFAULT_VIEW ?? '') ? process.env.DEFAULT_VIEW!.replace(/\s+/g, '') : null;
if (process.env.DEFAULT_VIEW && !DEFAULT_VIEW) console.error(`DEFAULT_VIEW=${process.env.DEFAULT_VIEW} is not x,y,dist,yaw,pitch[,hour]; ignored`);
/** WARM_DEMOS=all | <id>,<id>: the demos this server builds at start, one after another, so a visitor finds them ready (testcities.ts warm). `all` is every
 *  demo with a `town` (the sample cities); the default is `all` on a SPECTATE showcase and none elsewhere. KEEP_DEMOS=<ids> (default: DEFAULT_DEMO only,
 *  which is always kept) are left running and never idle-stop; the other warmed demos save and stop (they resume in seconds on Open). DEFAULT_DEMO is
 *  warmed first and the kept demos are warmed too. On a showcase with a DEFAULT_DEMO the allowed demos are the union of the three. */
const demoIds = (name: string, v: string): DemoId[] => {
  const out: DemoId[] = [];
  for (const tok of v.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter((t) => t && t !== 'none')) {
    if (tok === 'all') out.push(...DEMOS.filter((d) => d.town).map((d) => d.id));
    else if (isDemoId(tok)) out.push(tok);
    else console.error(`${name}: ${tok} is not a demo; ignored`);
  }
  return out;
};
const KEEP_DEMOS = new Set<DemoId>([...(DEFAULT_DEMO ? [DEFAULT_DEMO] : []), ...demoIds('KEEP_DEMOS', process.env.KEEP_DEMOS ?? '')]);
const WARM_DEMOS = [...new Set<DemoId>([...(DEFAULT_DEMO ? [DEFAULT_DEMO] : []), ...demoIds('WARM_DEMOS', process.env.WARM_DEMOS ?? (SPECTATE ? 'all' : '')), ...KEEP_DEMOS])];
if (process.env.DEFAULT_DEMO && !DEFAULT_DEMO) console.error(`DEFAULT_DEMO=${process.env.DEFAULT_DEMO} is not a demo; the page opens the live world`);

// ---- world ---------------------------------------------------------------------
let seedBuilt = Number(process.env.SEED_BUILT ?? 0) | 0;
if (existsSync(RESET_MARKER)) {
  // the marker may carry options, e.g. "built=3" for a ready-made Commons
  const opts = Object.fromEntries(readFileSync(RESET_MARKER, 'utf8').split(/\s+/).filter(Boolean).map((kv) => kv.split('=') as [string, string]));
  if (opts.built) seedBuilt = Number(opts.built) | 0;
  if (existsSync(DATA)) renameSync(DATA, DATA + '.reset.bak');
  unlinkSync(RESET_MARKER);
  console.log(`RESET marker found: starting a fresh world${seedBuilt ? ` with the Commons built to level ${seedBuilt}` : ''}`);
}
let world = loadWorld(DATA);
let needsFill = false;
/** a demo being seeded draws from a seeded generator until its fill is done, so the same scenario gives the same town */
const realRandom = Math.random;
if (world) {
  console.log(`loaded world from ${DATA}: ${world.chunks.size} chunks, ${world.parcels.size} parcels, ${world.citizens.size} citizens, day ${world.day}`);
} else if (DEMO) {
  Math.random = seededRandom(DEMO_TOWN.seed);
  world = new World(DEMO_TOWN.seed);
  const problems = seedDemoTown(world, DEMO);
  if (problems.length) { console.error(`demo ${DEMO}: the scenario does not build:\n  ${problems.join('\n  ')}`); process.exit(1); }
  needsFill = true;
  console.log(`demo ${DEMO}: seeded the town (seed ${DEMO_TOWN.seed})`);
} else {
  const seed = Number(process.env.SEED ?? (CITY ? 1 : Math.floor(Math.random() * 2 ** 31)));
  world = new World(seed);
  if (CITY) { seedCity(world, { districts: CITY, built: 3 }); needsFill = true; }
  else if (process.env.START === 'frontier') seedFrontier(world); // from zero (docs/first-five.md section 0): one road in, a gate, a charter
  else seedCommons(world, seedBuilt);
  console.log(`created new world with seed ${seed}`);
}
/** Sign-in (docs/accounts.md), for the live world only: demos and test cities are sandboxes and a SPECTATE showcase only looks.
 *  HANKO_API_URL: Hanko (HANKO_AUDIENCE checks the token's `aud`). DEV_AUTH_USERS="user:pass,...": the built-in test sign-in for dev
 *  and UAT (DEV_AUTH_SECRET keeps its tokens across restarts). Not both. ACCOUNTS_FILE moves the bindings; AUTH_CLAIM_EXISTING=1
 *  lets the first account to ask for a name from before sign-in take that player (either provider). */
const HANKO_API_URL = process.env.HANKO_API_URL?.trim() || undefined;
const DEV_AUTH_USERS = process.env.DEV_AUTH_USERS?.trim() || undefined;
if (HANKO_API_URL && DEV_AUTH_USERS) { console.error('HANKO_API_URL and DEV_AUTH_USERS are both set: choose one sign-in'); process.exit(1); }
const authOn = !CHILD && !SPECTATE;
const accountsFile = resolve(process.env.ACCOUNTS_FILE ?? join(dirname(DATA), 'accounts.json'));
const claimExisting = ['1', 'true', 'yes'].includes((process.env.AUTH_CLAIM_EXISTING ?? '').toLowerCase());
const DEV_AUTH = DEV_AUTH_USERS && authOn ? devAuth({ users: DEV_AUTH_USERS, secret: process.env.DEV_AUTH_SECRET || undefined, file: accountsFile, claimExisting }) : undefined;
const AUTH = HANKO_API_URL && authOn ? hankoAuth({ apiUrl: HANKO_API_URL, audience: process.env.HANKO_AUDIENCE?.trim() || undefined, file: accountsFile, claimExisting })
  : DEV_AUTH?.hook;
const AUTH_CONFIG: ServerConfig['auth'] = !AUTH ? undefined : HANKO_API_URL ? { provider: 'hanko', apiUrl: HANKO_API_URL } : { provider: 'dev' };
if (HANKO_API_URL && AUTH) console.log(`sign-in required: Hanko at ${HANKO_API_URL}`);
if (DEV_AUTH) console.warn('sign-in required: DEV sign-in (DEV_AUTH_USERS), for testing only; never on a public server');
// ---- http (serves the built client when present; the game's WebSockets share its port) -----------
const http = createServer((req, res) => void serve(req, res));
/** The market rules of a shared world (docs/multiplayer-land.md M2: a free homestead and little cash, land priced by value,
 *  outposts, the empty-land tax, abandoned land) on the live world; LAND=classic keeps the flat price and START_MONEY.
 *  game.ts never plays them on a frontier, a test city, a demo or a showcase. */
const MARKET = !CHILD && !SPECTATE && process.env.LAND !== 'classic';
/** the game (game.ts): simulation, airports, rail and the protocol, here over WebSockets on the http port. Draft kinds and
 *  dev actions on a non-production server; a test city or demo is a sandbox (all tech, endless funds, no onboarding). */
const game = createGame(world, new WsSource(http), { devTools: process.env.NODE_ENV !== 'production', sandbox: CHILD, spectate: SPECTATE, market: MARKET, ...(AUTH ? { auth: AUTH } : {}) }, SIM_STEPS);
const { sim, airports, rail, net, tickWin } = game;
game.fires.enabled = process.env.FIRES !== '0'; // FIRES=0: nothing catches light (sim/fires.ts; an A/B control)
if (DEMO) {
  // the scenario's fire drills (docs/incidents.md): a house on a loop, a row the fire runs along, a works that blows up
  game.fires.drills = demoFireDrills(DEMO).map(([x, y]) => [x, y]);
  // the scenario's blackout drill (docs/utilities.md 4.4): a fault on these substations every six game hours, the depot's van ends it
  game.utilities.drills = demoBlackouts(DEMO).map(([x, y]) => [x, y]);
  game.fires.rows = demoFireRows(DEMO).map((row) => row.map(([x, y]): [number, number] => [x, y]));
  game.fires.blastDrills = demoFireBlasts(DEMO).map(([x, y]) => [x, y]);
  // the funeral drill (docs/remembrance.md): a hearse and mourners from the funeral director to the churchyard every couple of hours
  sim.death.drills = demoFunerals(DEMO).map((f) => ({ fd: [f.from[0], f.from[1]], rest: [f.to[0], f.to[1]] }));
}
if (DEMO && needsFill) { // the second half of seeding needs the simulation: bus stops, track and every line
  const problems = seedDemoNetwork(world, sim, rail, DEMO);
  if (problems.length) { console.error(`demo ${DEMO}: the scenario's network does not build:\n  ${problems.join('\n  ')}`); process.exit(1); }
}
/** a demo's tiles, aux, sub and lines as it starts (after the fill, or as loaded): Reset demo must give the same */
let startHash = DEMO && !needsFill ? worldHash(world) : undefined;
/** test cities: false while the fast-fill runs; the progress is on /healthz */
let ready = !needsFill;
let fillProgress: { tick: number; of: number; pop: number } | undefined;
/** the live server's test-city launcher (dev only; a test city itself has none) */
const testCities = worldLauncherAvailable() // demos on every main server, test cities on dev servers only
  ? new TestCities({ entry: fileURLToPath(import.meta.url), staticDir: STATIC, dataDir: join(dirname(DATA), 'test-cities'), cwd: join(here, '..'), cities: testCitiesAvailable(), demoDir: join(dirname(DATA), 'demos'), spectate: SPECTATE, warm: WARM_DEMOS, keep: KEEP_DEMOS, ...(SPECTATE && DEFAULT_DEMO ? { allowed: new Set(WARM_DEMOS) } : {}) })
  : null;

/** the performance monitor (docs/perf.md): /api/perf, POST /api/perf/profile, /metrics; long ticks are logged as they happen */
const monitor = new PerfMonitor({
  perf: game.perf, dataDir: dirname(DATA),
  world: () => ({ label: DEMO ?? (CITY ? String(CITY) : 'live'), kind: DEMO ? 'demo' : CITY ? 'city' : 'live', citizens: world!.citizens.size, vehicles: sim.traffic.lastVehicles, clients: net.connections, day: world!.day, tick: world!.tick, ready }),
  ...(testCities ? { children: () => testCities.running() } : {}),
});
let longLogged = 0;
game.perf.onLong = (line) => { if (++longLogged % 10 === 1 || longLogged <= 3) console.warn(line + (longLogged > 3 ? ` (${longLogged} long ticks so far; /api/perf has the last 50)` : '')); };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.opus': 'audio/ogg; codecs=opus',
};
async function serve(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, chunks: world!.chunks.size, citizens: world!.citizens.size, clients: net.connections,
      pid: process.pid, rss: process.memoryUsage().rss, day: world!.day, dayFrac: sim.dayFrac, ready, ...(CITY ? { districts: CITY } : {}), ...(DEMO ? { demo: DEMO, startHash } : {}), ...(SPECTATE ? { spectate: true } : {}), ...(fillProgress && !ready ? { fill: fillProgress } : {}),
      ...(net.tickStats ? { tickAvg: net.tickStats.avg, tickP95: net.tickStats.p95, tickMax: net.tickStats.max } : {}),
      longTicks: game.perf.longTotal, heapUsed: process.memoryUsage().heapUsed, // the full picture is on /api/perf (docs/perf.md)
    }));
  }
  if (req.url?.split('?')[0] === '/api/config') {
    const cfg: ServerConfig = { ...(playAvailable() ? { play: true } : {}), ...(SPECTATE ? { spectate: true } : {}), ...(DEFAULT_DEMO && !CHILD ? { defaultDemo: DEFAULT_DEMO, ...(SPECTATE ? { demos: WARM_DEMOS } : {}) } : {}), ...(DEFAULT_VIEW && !CHILD ? { defaultView: DEFAULT_VIEW } : {}), ...(AUTH_CONFIG ? { auth: AUTH_CONFIG } : {}) };
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(cfg));
  }
  if (req.url?.split('?')[0] === '/api/servers') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    try {
      const j = JSON.parse(readFileSync(SERVERS_FILE, 'utf8')) as { servers?: unknown };
      return res.end(JSON.stringify({ servers: Array.isArray(j.servers) ? j.servers : [] }));
    } catch { return res.end('{"servers":[]}'); } // no file, or one that does not parse: an empty list, which the page says in words
  }
  if (DEV_AUTH?.handle(req, res)) return;
  if (monitor.handle(req, res)) return;
  if (testCities?.handle(req, res)) return;
  if (['/api/test-cities', '/api/demos'].includes(req.url?.split('?')[0] ?? '')) { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end('{"available":false}'); }
  if (!existsSync(STATIC)) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('msimcity server running. Build the client (npm run build) or use the Vite dev server.\n'); }
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (urlPath === '/play' || urlPath.startsWith('/play/')) { // the offline build: its own root, no fallback to the online page (it has a service worker and a scope of its own)
    if (!playAvailable()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('The offline build is not on this server (npm run build:local).\n'); }
    if (urlPath === '/play') { res.writeHead(302, { location: '/play/' + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }); return res.end(); }
    let f = join(PLAY, urlPath.slice('/play/'.length) || 'index.html');
    if (!f.startsWith(PLAY)) { res.writeHead(403); return res.end(); }
    try {
      if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
      const body = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', ...(f.endsWith('sw.js') ? { 'cache-control': 'no-cache' } : {}) }); // the service worker script is always revalidated
      return res.end(body);
    } catch { res.writeHead(404); return res.end(); }
  }
  let file = join(STATIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(STATIC)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    const body = await readFile(join(STATIC, 'index.html')).catch(() => null);
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(body);
  }
}
// demo sockets (/demo-ws/<id>) are piped to the demo's own process before the game's socket server sees them
if (testCities) {
  const emit = http.emit.bind(http) as (ev: string, ...args: unknown[]) => boolean;
  (http as { emit: (ev: string, ...args: unknown[]) => boolean }).emit = (ev, ...args) =>
    ev === 'upgrade' && testCities.upgrade(args[0] as IncomingMessage, args[1] as Duplex, args[2] as Buffer) ? true : emit(ev, ...args);
}

// ---- main loop -----------------------------------------------------------------------
function startLoop() {
  setInterval(() => game.loop(), TICK_MS);
  // a test city saves when it stops (and after its fill), not every 30 s: a big world takes seconds to write
  if (!CHILD) setInterval(() => save('autosave'), SAVE_EVERY_MS);
}
function save(reason: string) {
  try { monitor.timeSave(() => saveWorld(world!, DATA)); console.log(`saved (${reason}): ${world!.citizens.size} citizens, day ${world!.day}, ${monitor.save.lastMs.toFixed(0)} ms`); }
  catch (e) { console.error('save failed', e); }
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => {
  if (CHILD && !ready) process.exit(0); // half-grown: nothing worth saving, the next start fills again
  save(sig);
  // tsx watch sends SIGTERM on every reload and the test cities must survive that; SIGINT (Ctrl-C) or
  // TEST_CITY_STOP_ON_EXIT=1 is a real shutdown and stops them (testcities.ts, stopsChildrenOn)
  if (testCities && stopsChildrenOn(sig)) void testCities.stopAll().then(() => process.exit(0)); else process.exit(0);
});

http.listen(PORT, HOST, async () => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address;
  console.log(`civitas server listening on http://${lan ?? HOST}:${PORT}  (ws same port)${SPECTATE ? ', read-only (SPECTATE)' : ''}${DEFAULT_DEMO && !CHILD ? `, default demo ${DEFAULT_DEMO}` : ''}`);
  if (testCities && WARM_DEMOS.length) void testCities.warm(); // the default demo first, then the rest, one child at a time
  if (needsFill && DEMO) {
    net.accepting = false;
    const t0 = performance.now();
    const fires = game.fires.enabled; game.fires.enabled = false; // the town fills as it did before fires (and the same every time)
    const r = await fillDemo(world!, game.step, (p) => { fillProgress = p; });
    game.fires.enabled = fires;
    const students = seedDemoStudents(world!, sim, DEMO); // the universities' first students (a campus would stand empty for days)
    const graves = seedDemoGraves(world!, sim, DEMO); // the resting places' long dead: headstones on the first visit (docs/remembrance.md)
    if (graves) console.log(`demo ${DEMO}: ${graves} graves seeded`);
    for (const p of seedDemoAdverts(world!, game.adverts, DEMO)) console.warn(`demo ${DEMO}: ${p}`); // the high street's posters (docs/adverts.md)
    Math.random = realRandom;
    startHash = worldHash(world!);
    ready = true;
    net.accepting = true;
    console.log(`demo ${DEMO} filled: ${r.pop} citizens after ${(r.ticks / 2400).toFixed(2)} days in ${((performance.now() - t0) / 1000).toFixed(1)} s, hash ${startHash}${students ? `, ${students} students enrolled` : ''}`);
    save('fill');
    if (DEMO_SNAPSHOT) try { copyFileSync(DATA, DEMO_SNAPSHOT); } catch (e) { console.error('demo snapshot failed', e); }
    try { const m = writeDemoMeta(DATA, DEMO, world!.citizens.size); console.log(`demo ${DEMO}: recorded scenario ${m.scenarioHash}`); } catch (e) { console.error('demo meta failed', e); } // last: a save without it is treated as out of date
  } else if (needsFill) {
    net.accepting = false;
    const fires = game.fires.enabled; game.fires.enabled = false;
    const r = await fillCity(world!, game.step, (p) => { fillProgress = p; });
    game.fires.enabled = fires;
    ready = true;
    net.accepting = true;
    console.log(`test city ${CITY}×${CITY} filled: ${r.pop} citizens after ${(r.ticks / 2400).toFixed(2)} days in ${r.seconds.toFixed(1)} s${r.settled ? '' : ' (still growing at the cap)'}`);
    save('fill');
  }
  // a child world looks after itself: no clients for TEST_CITY_IDLE_MS and it saves and exits, parent or no parent
  if (CHILD && !process.env.DEMO_KEEP) watchIdle(() => net.connections, () => { console.log(`${DEMO ? `demo ${DEMO}` : 'test city'} idle, stopping`); save('idle'); process.exit(0); });
  startLoop();
});
