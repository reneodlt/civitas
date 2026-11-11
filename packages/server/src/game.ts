import { TICK_MS, ALL_TECH_IDS, ECONOMY_TUNING } from '@msimcity/shared';
import type { World } from './world';
import { Simulation } from './sim/simulation';
import { Airports } from './sim/airports';
import { Rail } from './sim/rail';
import { Metro } from './sim/metro';
import { Ferry } from './sim/ferry';
import { Harbours } from './sim/harbours';
import { Finance } from './sim/finance';
import { LandMarket } from './sim/land';
import { Issues } from './sim/issues';
import { Fires } from './sim/fires';
import { Adverts } from './sim/adverts';
import { News } from './sim/news';
import { Planning } from './sim/planning';
import { Utilities } from './sim/utilities';
import { Net, type GameConfig } from './net';
import type { ConnSource } from './transport';
import { TickWindow } from './tickstats';
import type { PhaseStats } from './perf/phases';
import { historyOf } from './history';

export type { GameConfig };

/**
 * One running game, whatever hosts it: index.ts on the server (WebSockets, a JSON file, setInterval) or a local-mode
 * worker (a MessagePort, IndexedDB, its own clock; docs/local-mode.md). Pure: no Node APIs. The host makes or loads the
 * World, picks the transport and the config, and calls `loop()` once every TICK_MS.
 */
export interface Game {
  world: World;
  sim: Simulation;
  /** planes: landing fees from the shared flight schedule, and terminal tooltips (sim/airports.ts) */
  airports: Airports;
  /** railways (sim/rail.ts): trains are the 'rail' mode of the transit registry, which plans riders and collects fares */
  rail: Rail;
  /** underground railways (sim/metro.ts): the 'metro' mode of the transit registry, its tunnels and platforms */
  metro: Metro;
  /** river buses (sim/ferry.ts): the 'ferry' mode of the transit registry, its routes on the water and piers */
  ferry: Ferry;
  /** harbours (sim/harbours.ts): their lanes and the 'harbours' message, the catch, ship calls, the cargo port's gateway */
  harbours: Harbours;
  /** the overdraft, administration and the recovery plan (sim/finance.ts): interest and the count at midnight */
  finance: Finance;
  /** land and money on a shared world (sim/land.ts, docs/multiplayer-land.md M2): prices by value, the empty-land tax, abandoned land */
  land: LandMarket;
  /** issue bubbles and the problems list (sim/issues.ts): a slice of the buildings looked at each tick */
  issues: Issues;
  /** house fires and the engines sent to them (sim/fires.ts) */
  fires: Fires;
  /** campaigns, rented ad slots and their rent (sim/adverts.ts, docs/adverts.md) */
  adverts: Adverts;
  /** the news story log (sim/news.ts, docs/media.md): stories from fires, ranks, openings and new lines, and who covers them */
  news: News;
  /** planning notices, the residents' vote and road closure notices (sim/planning.ts, docs/multiplayer-land.md M5) */
  planning: Planning;
  /** utilities (sim/utilities.ts, docs/utilities.md): the power networks, the hourly solve, bills, faults and repair vans */
  utilities: Utilities;
  net: Net;
  /** tick time over the last minute (300 loops), for the stats message, /healthz and the client's perf readout */
  tickWin: TickWindow;
  /** the tick's phase timings, work counters, worst ticks and long-tick traces (perf/phases.ts; the same object as sim.perf) */
  perf: PhaseStats;
  /** simulation ticks per loop (SIM_STEPS on the server: fast-forward; local mode's speed later) */
  steps: number;
  /** one simulation tick and its frame to clients, without the loop's bookkeeping (fast-fills) */
  step(): void;
  /** the main loop body: `steps` ticks, one frame to clients, tick-time stats; returns the elapsed ms */
  loop(): number;
}

/** ECON=name=value,... overrides ECONOMY_TUNING (shared/src/tuning.ts) for an offline economy run. */
export function tuneEconomy(spec: string) {
  for (const kv of spec.split(',').filter(Boolean)) { const [k, v] = kv.split('='); if (k in ECONOMY_TUNING) (ECONOMY_TUNING as Record<string, number>)[k] = Number(v); }
}

/** Wire a loaded or freshly seeded World into a running game: the simulation, airports, rail, the metro and the protocol over `source`. */
export function createGame(world: World, source: ConnSource, cfg: GameConfig, steps = 1): Game {
  for (const id of world.parcels.keys()) world.recountRoads(id);
  world.scanRoadClasses();
  // the Commons has every technology (seed.ts, loadtest/cities.ts); top it up when the tree has grown since the world was saved
  const commons = world.players.get('sys');
  if (commons) commons.tech = [...new Set([...commons.tech, ...ALL_TECH_IDS])];
  const sim = new Simulation(world);
  const airports = new Airports(world);
  // some of every plane's passengers are moving here: they top up the terminal gateway's arrivals (sim/gateways.ts)
  airports.onArrival = (a) => sim.gateways.planeLanded(a.terminal.doorX, a.terminal.doorY, a.passengers);
  const rail = new Rail(world, sim.transit);
  sim.transit.register(rail);
  const metro = new Metro(world, sim.transit);
  sim.transit.register(metro);
  sim.transit.sandbox = sim.buses.sandbox = rail.sandbox = metro.sandbox = cfg.sandbox; // lines are anyone's to edit in a sandbox
  const ferry = new Ferry(world, sim.transit);
  sim.transit.register(ferry);
  ferry.sandbox = cfg.sandbox;
  // rail freight: deliveries from industry near a freight yard go by train when a freight line reaches a yard near the shop
  sim.freight = rail;
  rail.trucks = { spawn: (from, to, owner) => sim.spawnFreightTruck(from, to, owner) };
  sim.traffic.barrier = (x, y) => rail.barrierDown(x, y); // level crossings: traffic waits while a train passes
  sim.value.rail = rail; sim.value.airports = airports; // trains and flights are noise in the neighbourhood value (sim/value.ts)
  const harbours = new Harbours(world, sim); // hooks itself into the gateways (sea route, ships berthing) and freight (port exports)
  const finance = new Finance(world, cfg.sandbox);
  const net = new Net(world, sim, source, cfg);
  net.finance = finance;
  // the market rules (docs/multiplayer-land.md M2): asked for by the host, never on a frontier, a sandbox or a showcase
  const land = new LandMarket(world, sim.value, !!cfg.market && !cfg.sandbox && !cfg.spectate && world.start !== 'frontier');
  net.land = land;
  if (land.market) finance.landPrice = (q) => land.priceOf(q);
  net.harbours = harbours;
  net.airports = airports;
  net.rail = rail;
  net.metro = metro;
  net.ferry = ferry;
  const issues = new Issues(world, sim); // issue bubbles (sim/issues.ts): Net sends the icon planes and each player's problems
  issues.sandbox = cfg.sandbox;
  net.issues = issues;
  const fires = new Fires(world, sim, issues); // house fires (sim/fires.ts): the on-fire badge, the `fires` message, the owners' notices
  issues.burning = (x, y) => fires.burningAt(x, y);
  net.fires = fires;
  const adverts = new Adverts(world); // campaigns and rented ad slots (sim/adverts.ts): the `ads` message, rent at midnight
  adverts.cover = (x, y) => sim.areaCover(x, y);
  net.adverts = adverts;
  // the news (sim/news.ts): fed by the fires, the ranks, finished sites and new lines; nothing of its own per tick
  const news = new News(world);
  fires.onStory = (e) => news.fire(e);
  if (net.ranks) net.ranks.onStory = (e) => news.rank(e);
  world.onSiteCompleted = (s) => news.opened(s);
  net.news = news;
  // planning (sim/planning.ts, docs/multiplayer-land.md M5): votes on nuisance builds in a shared world (cfg.planning to force);
  // closure notices for protected public road wherever road protection applies (not in a sandbox)
  const planning = new Planning(world, sim, (cfg.planning ?? land.market) && !cfg.sandbox && !cfg.spectate);
  planning.news = news;
  net.planning = planning;
  // death and remembrance (sim/death.ts, docs/remembrance.md): a fire or blast harms the people inside, an incident's dead make
  // the news, the dead waiting for burial space badge their mortuary
  fires.onHarm = (e) => sim.death.harm(e);
  sim.death.onStory = (e) => news.death(e);
  sim.death.look = (x, y) => issues.fireChanged(x, y);
  issues.waiting = (x, y) => sim.death.noSpaceAt(x, y);
  sim.death.sandbox = cfg.sandbox;
  // utilities (sim/utilities.ts): the growth gate, the hourly solve and the repair vans (a mobile service of sim.mobile)
  const utilities = new Utilities(world, sim.mobile);
  utilities.sandbox = cfg.sandbox;
  sim.powerGate = (b, target) => utilities.mayGrow(b, target);
  net.utilities = utilities;
  if (net.onboarding) net.onboarding.powerHeld = (o) => utilities.heldBack(o);
  const tickWin = new TickWindow(300);
  let slow = 0, loops = 0;
  // city history for the charts (history.ts): one sample per game hour, pushed to the clients that have the panel open
  const hist = historyOf(world);
  hist.power = () => utilities.hourly;
  const sampleHistory = () => { if (hist.sample(world, sim, net.tickStats?.avg ?? 0, net.tickStats?.p95 ?? 0)) net.historySample(hist); };
  const perf = sim.perf;
  net.perf = perf;
  const systems = () => { airports.tick(); harbours.tick(); finance.tick(); land.tick(); issues.tick(); fires.tick(); adverts.tick(); planning.tick(); perf.lap('systems'); };
  const game: Game = {
    world, sim, airports, rail, metro, ferry, harbours, finance, land, issues, fires, adverts, news, planning, utilities, net, tickWin, perf, steps,
    step() {
      const t0 = performance.now();
      sim.tick(); systems(); net.flush(); perf.lap('flush'); sampleHistory(); perf.lap('history');
      perf.endTick(performance.now() - t0, world.tick);
    },
    loop() {
      const t0 = performance.now();
      for (let i = 0; i < game.steps; i++) { sim.tick(); systems(); }
      net.flush();
      perf.lap('flush');
      sampleHistory();
      perf.lap('history');
      const dt = performance.now() - t0;
      perf.endTick(dt, world.tick);
      tickWin.push(dt);
      if (++loops % 5 === 0) net.tickStats = tickWin.summary(); // once a second; sent with the next stats message
      if (dt > TICK_MS * 0.8 && ++slow % 25 === 1) console.warn(`slow tick: ${dt.toFixed(1)}ms with ${world.citizens.size} citizens`);
      return dt;
    },
  };
  return game;
}
