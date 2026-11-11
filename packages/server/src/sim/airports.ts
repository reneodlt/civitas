import {
  Zone, TICKS_PER_DAY, LANDING_FEE, deriveAirports, airportFor, airportDay, flightPassengers, timetable,
  type Airport, type AirportLink, type AirfieldEnv, type AirportInfo, type Flight, type Placed,
} from '@msimcity/shared';
import type { World } from '../world';
import { weatherNow, type WeatherHold } from './weatherfx';
import { WEATHER_TUNING, TICKS_PER_HOUR } from '@msimcity/shared';

/** One plane landing at one of the city's airports, with the passengers it brings. */
export interface Arrival { airport: Airport; terminal: Placed; owner: string | null; flight: Flight; passengers: number; departing: number }

const REBUILD_EVERY = 10;

/**
 * The server's airports (shared/src/airport.ts). Descriptors come from the same `deriveAirports()` the client
 * runs on its loaded chunks, so both sides run the identical schedule (shared/src/flights.ts) with nothing on the
 * wire. Here the schedule earns money: every touchdown credits the terminal's owner a landing fee.
 */
export class Airports {
  links: AirportLink[] = [];
  /**
   * Called once per landing. index.ts hooks it to the gateways (sim/gateways.ts): a share of the arriving passengers
   * are newcomers, added to the terminal gateway's arrivals for the hour. Departing travellers are not simulated.
   */
  onArrival: ((a: Arrival) => void) | null = null;
  private last = -1;
  /** landings held by storm or fog (docs/weather.md W4): they touch down when it lifts, or divert after WEATHER_TUNING.holdMaxHours */
  private held: { link: AirportLink; f: Flight; at: number }[] = [];
  private holding: 'storm' | 'fog' | null = null;
  /** set by game.ts: a hold starting or lifting, for the news (sim/news.ts weather) */
  onHold: ((e: WeatherHold) => void) | null = null;
  /** counters since start: landings held, landed late, diverted */
  weatherStats = { held: 0, late: 0, diverted: 0, holds: 0 };
  private stats = new Map<number, { day: number; fees: number; passengers: number }>();
  readonly env: AirfieldEnv;

  constructor(private w: World) {
    this.env = { tile: (x, y) => w.peekTile(x, y), aux: (x, y) => w.auxAt(x, y), sub: (x, y) => w.subAt(x, y) };
  }

  /** The tick the flight schedule is measured in: the same day + fraction the clients interpolate from 'stats'. */
  get flightTick() { return this.w.day * TICKS_PER_DAY + (this.w.tick % TICKS_PER_DAY); }

  /** Finished terminals, as structures. */
  terminals(): Placed[] {
    const out: Placed[] = [];
    // family code 15 holds every transport hub; only the airport kind itself is a terminal (a bus depot shares the code)
    for (const b of this.w.builtOf(Zone.Hub)) { if (b.id !== Zone.Airport) continue; const s = this.w.structureAt(b.x, b.y); if (s) out.push(s); }
    return out.sort((a, b) => a.ax - b.ax || a.ay - b.ay);
  }
  rebuild() { this.links = deriveAirports(this.terminals(), this.env); }
  /** Operational airports. */
  get airports(): Airport[] { return this.links.filter((l) => l.airport).map((l) => l.airport!); }

  /** Run once per simulation tick: refresh the descriptors now and then and settle every landing since last time. */
  tick() {
    const now = this.flightTick;
    if (this.last < 0 || this.w.tick % REBUILD_EVERY === 0) this.rebuild();
    const from = this.last < 0 ? now : this.last;
    this.last = now;
    if (now <= from || now - from > TICKS_PER_DAY) return;
    const hold = this.links.some((l) => l.airport) || this.held.length ? weatherNow(this.w).hold : null;
    for (const link of this.links) {
      const ap = link.airport;
      if (!ap) continue;
      for (let day = Math.floor(from / TICKS_PER_DAY); day <= Math.floor(now / TICKS_PER_DAY); day++) {
        for (const f of timetable(ap, day)) if (f.tTouchdown > from && f.tTouchdown <= now) {
          if (hold) { this.held.push({ link, f, at: this.w.tick }); this.weatherStats.held++; } else this.land(link, f);
        }
      }
    }
    this.weatherHold(hold);
  }
  /** Storm and fog (docs/weather.md W4): held landings divert after holdMaxHours; when it lifts the rest land, late. */
  private weatherHold(hold: 'storm' | 'fog' | null) {
    const maxAge = WEATHER_TUNING.holdMaxHours * TICKS_PER_HOUR;
    if (this.held.length) {
      const keep: typeof this.held = [];
      for (const h of this.held) {
        if (this.w.tick - h.at > maxAge) this.weatherStats.diverted++;
        else if (!hold) { this.land(h.link, h.f); this.weatherStats.late++; } else keep.push(h);
      }
      this.held = keep;
    }
    if (hold === this.holding) return;
    const was = this.holding;
    this.holding = hold;
    const t = this.links.find((l) => l.airport)?.terminal;
    if (!t) return;
    if (hold) this.weatherStats.holds++;
    this.onHold?.({ what: 'flights', reason: hold ?? was!, lifted: !hold, x: t.doorX, y: t.doorY, owner: this.w.parcelAt(t.doorX, t.doorY)?.owner });
  }

  /** Passengers a flight brings into the city (the gateways card will spawn them). */
  arrivalsFor(f: Flight): number { return flightPassengers(f).arriving; }

  private land(link: AirportLink, f: Flight) {
    const ap = link.airport!, p = link.terminal;
    const owner = this.w.parcelAt(p.doorX, p.doorY)?.owner ?? null;
    const fee = LANDING_FEE[f.type];
    if (owner) this.w.credit(owner, fee, 'fees');
    const day = Math.floor(this.flightTick / TICKS_PER_DAY);
    let s = this.stats.get(ap.id);
    if (!s || s.day !== day) { s = { day, fees: 0, passengers: 0 }; this.stats.set(ap.id, s); }
    const pax = flightPassengers(f);
    s.fees += owner ? fee : 0;
    s.passengers += pax.arriving;
    this.onArrival?.({ airport: ap, terminal: p, owner, flight: f, passengers: this.arrivalsFor(f), departing: pax.departing });
  }

  /** Tooltip detail for the terminal whose door is at (x, y), or undefined when there is none. */
  describe(x: number, y: number): AirportInfo | undefined {
    const s = this.w.structureAt(x, y);
    if (!s || s.kind !== Zone.Airport) return undefined;
    const link = this.links.find((l) => l.terminal.ax === s.ax && l.terminal.ay === s.ay) ?? airportFor(s, this.env);
    const info: AirportInfo = { status: link.status, gates: link.airport?.gates ?? 2, runwayLen: link.runway?.len };
    const ap = link.airport;
    if (!ap) return info;
    const d = airportDay(ap, this.flightTick);
    const st = this.stats.get(ap.id);
    const today = Math.floor(this.flightTick / TICKS_PER_DAY);
    return {
      ...info, flightsPerHour: ap.flightsPerHour, flightsToday: d.flights, landedToday: d.landed, departedToday: d.departed,
      gatesInUse: d.gatesInUse, gates: d.gates, nextArrival: d.nextArrival, nextDeparture: d.nextDeparture,
      passengersToday: st && st.day === today ? st.passengers : 0, feesToday: st && st.day === today ? st.fees : 0, landingFee: LANDING_FEE.narrowbody,
    };
  }
}
