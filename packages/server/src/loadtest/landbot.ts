/**
 * The homesteader (docs/multiplayer-land.md M2): bot F's moves on a shared world with the market rules, starting with
 * LAND_TUNING.startMoney and the free 16×16 homestead against the Commons' east edge, buying each later block's land at
 * the market price and paying the empty-land tax. Prints the treasury's low point, the hourly treasury, what land and
 * the tax cost, residents and rank-ups. `--classic` plays the same bot without the market rules ($20,000, $10 a tile,
 * no homestead, no tax) for comparison.
 *
 *   npx tsx packages/server/src/loadtest/landbot.ts [--minutes 180] [--seed 1] [--start 3000] [--classic] [--log]
 */
import { LAND_TUNING, RANKS, START_MONEY, mulberry32, type LedgerCat } from '@msimcity/shared';
import { World } from '../world';
import { seedCommons } from '../seed';
import { createGame } from '../game';
import type { Conn } from '../transport';
import { playMarket } from './botf';

const argv = process.argv.slice(2);
const arg = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const classic = argv.includes('--classic'), minutes = arg('minutes', 180), seed = arg('seed', 1);
LAND_TUNING.startMoney = arg('start', LAND_TUNING.startMoney); // --start n: try another start (tuning)
Math.random = mulberry32(seed);
const world = new World(424242 + seed);
seedCommons(world, 0);
let accept: ((c: Conn) => void) | null = null;
const game = createGame(world, { onConnection: (fn) => { accept = fn; } }, { devTools: true, sandbox: false, market: !classic }, 10);
// what the bot's money went on, by ledger line, over the whole run
const spent = new Map<LedgerCat, number>();
const credit = world.credit.bind(world);
world.credit = (id: string, amount: number, cat?: LedgerCat) => {
  if (id === 'homesteader') { const c = cat ?? (amount >= 0 ? 'tax' : 'upkeep'); spent.set(c, (spent.get(c) ?? 0) + amount); }
  return credit(id, amount, cat);
};
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-GB')}`;
const t0 = performance.now();
const r = await playMarket(game, accept!, 11, minutes, argv.includes('--log') ? (m, what) => console.log(`  ${m.toFixed(1)} min  ${what}`) : undefined);
const p = world.players.get('homesteader')!;
const owned = [...world.parcels.values()].filter((q) => q.owner === p.id);
console.log(`${classic ? 'CLASSIC' : 'MARKET'} seed ${seed}, ${minutes} min (${(minutes / 8).toFixed(1)} game days), start ${usd(classic ? START_MONEY : LAND_TUNING.startMoney)}${classic ? '' : ` + ${LAND_TUNING.homestead}×${LAND_TUNING.homestead} homestead`}`);
console.log(`  treasury low ${usd(r.low)} at minute ${r.lowAt}; end ${usd(p.money)}; residents ${r.residents}`);
console.log(`  hourly: ${r.hourly.filter((_, i) => i % 6 === 0).map(usd).join(' ')}`);
console.log(`  land: ${owned.length} parcels, ${owned.reduce((a, q) => a + q.w * q.h, 0)} tiles, bought for ${usd(-(spent.get('land') ?? 0))}; empty-land tax ${usd(-(spent.get('landtax') ?? 0))}`);
console.log(`  ranks: ${r.ups.map((m, i) => (m === undefined ? '' : `${RANKS[i + 1].name} ${m} min`)).filter(Boolean).join(', ') || 'none'}`);
console.log(`  ledger over the run: ${[...spent.entries()].sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k} ${usd(v)}`).join(', ')}`);
console.log(`  (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
console.log(`LANDBOT ${JSON.stringify({ classic, seed, minutes, low: r.low, lowAt: r.lowAt, end: Math.round(p.money), residents: r.residents, ups: r.ups, land: -(spent.get('land') ?? 0), landtax: -(spent.get('landtax') ?? 0) })}`);
process.exit(0);
