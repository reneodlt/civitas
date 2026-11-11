import { TICKS_PER_DAY, TICKS_PER_HOUR, LifeStage, hash2, mod, SKILLS, EDU, POLICY, overQualified, WEATHER_TUNING } from '@msimcity/shared';
import type { Citizen } from '../world';

/**
 * Citizen lives: ages, health, households and friendships. Everything here is either a tunable or a pure helper;
 * the daily life step that uses them lives in Simulation (it needs trip planning). Life updates run once per game
 * day per citizen (staggered by id over the day), plus a few cheap counters where trips advance.
 */
export const LIFE = {
  /** game days per year of age: one game week is about a year */
  daysPerYear: 7,
  adultAge: 18,
  /** retirement age is retireAge + retireSpread * hash, per citizen */
  retireAge: 62, retireSpread: 6,
  /** newcomers arrive aged newcomerMin..newcomerMax (triangular, hash-seeded) */
  newcomerMin: 18, newcomerMax: 45,
  /** citizens loaded from a world saved before lives existed get ages in this range */
  legacyMin: 18, legacyMax: 60,
  /**
   * couples living together: chance per game day of deciding on a baby (times 0.6..1.4 per household). The baby
   * arrives once the home has a free bed; until then (at most babyWaitDays) the home holds its next free bed.
   */
  birthPerDay: 0.03, birthMinAge: 20, birthMaxAge: 45, maxChildren: 3, babyWaitDays: 10,
  /** chance per day a single adult looks for a partner among colleagues or neighbours */
  partnerPerDay: 0.015, partnerAgeGap: 12,
  /** chance per day an adult still living with a parent moves out (when a home with a spare bed is near) */
  moveOutPerDay: 0.015, moveOutMaxAge: 35, moveOutRadius: 30,
  /** friendships: cap, chance per day with a colleague, chance per other guest when two are at the same venue */
  maxFriends: 5, workFriendPerDay: 0.012, venueFriendEvening: 0.03, venueFriendDay: 0.012,
  /** a family waiting for a bed (partner moving in, a baby) holds the home's last free bed from newcomers this long */
  familyHoldDays: 2,
  /**
   * people living alone leave town now and then (more when unhappy), which frees beds in a full city; crowding
   * (a family in the same home waiting for a bed) multiplies the chance
   */
  leaveBasePerDay: 0.012, leaveUnhappyPerDay: 0.03, leaveUnhappyBelow: 45, leaveCrowdedMul: 4,
  /** when someone goes out in the evening: chance each idle friend nearby joins (at most 2), and a child at home */
  friendJoins: 0.35, friendJoinRadius: 30, childJoins: 0.5,
  /** retirees: daily pension, extra daytime outings, walking speed */
  pension: 30, retireeOutingMul: 2.5, retireeWalk: 0.8,
  /** walkers who are children render at this scale (client) */
  childScale: 0.7,
} as const;

/** Health conditions, a small bit set on the citizen. */
export const Cond = { Flu: 1, Injury: 2, Chronic: 4 } as const;
export const ACUTE = Cond.Flu | Cond.Injury;
export const COND_NAMES: [number, string][] = [[Cond.Flu, 'flu'], [Cond.Injury, 'injury'], [Cond.Chronic, 'chronic illness']];

export const HEALTH = {
  /** baseline health drifts toward base - agePenalty per year over 40 - chronic, at `pull` of the gap a day */
  base: 96, agePenaltyFrom: 40, agePenalty: 0.55, chronicPenalty: 14, pull: 0.08,
  /** daily wear by workplace (factories and building sites hurt) */
  wearIndustrial: 0.45, wearYard: 0.3, wearFire: 0.15,
  /** per game hour held up in traffic since the last life step, capped */
  trafficPerHour: 0.8, trafficCap: 2.5,
  /** a staffed hospital within SERVICE_RADIUS: daily boost and faster recovery */
  hospitalBoost: 0.5, hospitalRecovery: 1.5,
  /** daily cost of being ill */
  fluCost: 2.5, injuryCost: 1.5, chronicCost: 0.3,
  /** flu: base chance per day plus a seasonal wave once a game year; household members with flu multiply it */
  fluBase: 0.002, fluSeason: 0.045, fluHousehold: 4, fluDaysMin: 2, fluDaysMax: 5,
  /** the year phase (shared seasonOf) the flu wave peaks at: mid-winter (W5); it was 0.15, early spring, before seasons (SEASONFX=0 keeps that) */
  fluPeak: 0.9, fluPeakOld: 0.15,
  /** injury: chance per working day in a factory / on a building site */
  injuryIndustrial: 0.012, injuryYard: 0.009, injuryDaysMin: 3, injuryDaysMax: 8,
  /** chronic illness: chance per day per 5 years over 50 */
  chronicFrom: 50, chronicPer5y: 0.0012,
  /** acute illness: chance a shift is skipped; below this health every shift is skipped and they stay home */
  sickSkip: 0.85, staysHomeBelow: 25,
  /** a doctor's visit: boost, how much of the remaining illness it cures, how long it takes */
  doctorBoost: 6, doctorCure: 0.4, doctorMinTicks: Math.round(0.6 * TICKS_PER_HOUR), doctorMaxTicks: Math.round(1.5 * TICKS_PER_HOUR),
  /** deaths of old age: yearly chance oldAgeQ at oldAgeFrom, rising by oldAgeGrowth a year; poor health adds per day */
  oldAgeFrom: 75, oldAgeQ: 0.035, oldAgeGrowth: 1.11, poorHealthBelow: 15, poorHealthPerDay: 0.012, frailBelow: 30, frailPerDay: 0.0015,
} as const;

const DAY = TICKS_PER_DAY;
/** Game day as a fraction (ticks / day). */
export const dayOf = (tick: number) => tick / DAY;
export const ageOf = (c: Citizen, tick: number) => (dayOf(tick) - c.born) / LIFE.daysPerYear;
export const retireAgeOf = (id: number) => LIFE.retireAge + LIFE.retireSpread * hash2(id, 215);
export function stageFor(id: number, age: number): number {
  return age < LIFE.adultAge ? LifeStage.Child : age >= retireAgeOf(id) ? LifeStage.Retired : LifeStage.Adult;
}
/** A hash-seeded age between lo and hi, peaked in the middle (sum of two hashes), so ages are not uniform. */
export const seededAge = (id: number, lo: number, hi: number) => lo + (hi - lo) * (hash2(id, 211) + hash2(id, 213)) / 2;

/** Seasonal flu wave, 0..1, once a game year; some years are worse than others. */
export function fluWave(day: number, peak: number = HEALTH.fluPeak): number {
  const years = day / LIFE.daysPerYear, year = Math.floor(years), phase = years - year;
  const severity = 0.5 + hash2(year, 977);
  const w = Math.max(0, Math.cos(2 * Math.PI * (phase - peak)));
  return Math.min(1, severity * w ** 6);
}

/** Yearly chance of dying of old age, as a chance per game day; plus poor health. */
export function deathChance(age: number, health: number, thermal = 0): number {
  let p = 0;
  // `thermal` (0..1, W5): a heatwave or cold snap today raises the old-age part for the elderly
  if (age >= HEALTH.oldAgeFrom - 10) p += Math.min(0.9, HEALTH.oldAgeQ * HEALTH.oldAgeGrowth ** (age - HEALTH.oldAgeFrom)) / LIFE.daysPerYear * (thermal > 0 && age >= WEATHER_TUNING.thermalAge ? 1 + WEATHER_TUNING.thermalDeath * thermal : 1);
  if (health < HEALTH.poorHealthBelow) p += HEALTH.poorHealthPerDay;
  else if (health < HEALTH.frailBelow) p += HEALTH.frailPerDay;
  return p;
}

/** Where health drifts to at a given age. */
export function healthTarget(age: number, cond: number): number {
  return HEALTH.base - Math.max(0, age - HEALTH.agePenaltyFrom) * HEALTH.agePenalty - (cond & Cond.Chronic ? HEALTH.chronicPenalty : 0);
}

// ---- money and daily counters ------------------------------------------------------------------

/** Keep the 7-day ledger on the current day, clearing the slots of days that passed. */
function rollLedger(c: Citizen, day: number) {
  if (c.ledgerDay === day) return;
  if (day < c.ledgerDay || day - c.ledgerDay >= 7) { c.in7.fill(0); c.out7.fill(0); }
  else for (let d = c.ledgerDay + 1; d <= day; d++) { const k = mod(d, 7); c.in7[k] = 0; c.out7[k] = 0; }
  c.ledgerDay = day;
}
export function noteIncome(c: Citizen, amount: number, tick: number) {
  const day = Math.floor(tick / DAY);
  rollLedger(c, day);
  c.in7[mod(day, 7)] += amount;
}
export function noteSpend(c: Citizen, amount: number, tick: number) {
  const day = Math.floor(tick / DAY);
  rollLedger(c, day);
  c.out7[mod(day, 7)] += amount;
}
export function week(c: Citizen, tick: number): { income: number; spend: number } {
  rollLedger(c, Math.floor(tick / DAY));
  let income = 0, spend = 0;
  for (let i = 0; i < 7; i++) { income += c.in7[i]; spend += c.out7[i]; }
  return { income, spend };
}
/** Today's trips and traffic counters; reset lazily when the first event of a new day arrives. */
export function today(c: Citizen, day: number) {
  if (c.statsDay !== day) { c.statsDay = day; c.tripsToday = 0; c.trafficTicksToday = 0; }
}

// ---- leisure need -------------------------------------------------------------------------------

/**
 * The leisure need. `c.leisure` is how satisfied it is, 0..1 (1 = just had a good day out). It drains every game
 * day and is topped up by each visit (by the place's leisure value: a bar counts as `barValue`) and, a little every
 * day, by living near parks. The need is 1 - leisure: bored people go out more often, and it shows in happiness.
 */
export const LEISURE = {
  /** lost per game day; retirees and children (no job, more free time) lose a little less */
  drainPerDay: 0.2, drainFreeMul: 0.8,
  /** restored per visit, per point of the place's leisure value (cinema 4 -> +0.28) */
  perValue: 0.07,
  /** a bar, café or restaurant visit counts as this much leisure value */
  barValue: 2.5,
  /** daily top-up per point of park leisure value within reach of home, capped below the drain */
  parkPerDay: 0.018, parkCap: 0.16,
  /** the coverage score of a home is the sum of the leisure values of places in reach, capped; tiers at these scores */
  coverageCap: 16, tierSome: 3, tierGood: 7,
  /** outing chance multiplier: lo when satisfied, lo + span when the need is total */
  outingLo: 0.6, outingSpan: 0.9,
  /** where newcomers start (plus up to `startSpread` by hash) */
  start: 0.45, startSpread: 0.35,
} as const;
/** 0..2: none, some, good leisure within reach of a home with this coverage score. */
export const leisureTier = (score: number) => (score >= LEISURE.tierGood ? 2 : score >= LEISURE.tierSome ? 1 : 0);
export const leisureNeed = (c: Citizen) => 1 - Math.max(0, Math.min(1, c.leisure));
/** One visit to a place of this leisure value. */
export function noteLeisureVisit(c: Citizen, value: number) {
  c.leisure = Math.min(1, Math.max(0, c.leisure) + value * LEISURE.perValue);
}
/** The daily drain, less what parks near home give back. */
export function leisureDay(c: Citizen, parkValue: number) {
  const free = c.stage !== LifeStage.Adult || !c.job;
  const back = Math.min(LEISURE.parkCap, parkValue * LEISURE.parkPerDay);
  c.leisure = Math.max(0, Math.min(1, Math.min(1, c.leisure) - LEISURE.drainPerDay * (free ? LEISURE.drainFreeMul : 1) + back));
}

// ---- happiness -----------------------------------------------------------------------------------

/**
 * Moods other modules give a citizen for a while, read by happinessParts: sim/death.ts sets one on each mourner ("grieving",
 * "waiting to bury a loved one") that answers null once the grief is over. Keyed by the citizen object, so every world keeps its own.
 */
export const MOODS = new WeakMap<Citizen, (tick: number) => { label: string; delta: number } | null>();

/**
 * coverage: distinct services in reach; parks: the summed leisure value of parks in reach of home; kids: a parent's
 * children at school (sim/families.ts homeParts): school 1 every one has a place, -1 one has none; meals: free school meals
 */
export interface HappyInputs {
  coverage: number; tick: number; parks?: number; kids?: { school: number; meals: boolean };
  /** motivation (sim/motivation.ts bend): a multiplier per value (Value order) for the parts that value cares about; 1 for all when absent */
  bend?: readonly number[];
  /** the weather's part (shared weatherMood, docs/weather.md W4): a sunny warm day, a grey spell; absent or null for neither */
  weather?: { label: string; delta: number } | null;
}
/** Value indices (shared/src/motivation.ts Value) the parts of happiness belong to */
const MONEY = 0, FAMILY = 1, STATUS = 2, ROOTS = 3, TIME = 4, ADVENTURE = 5;
/** Contributions to happiness (points around a neutral 50), each with a label for the panel. */
export function happinessParts(c: Citizen, h: HappyInputs): { label: string; delta: number }[] {
  const parts: { label: string; delta: number }[] = [];
  // a part a citizen's values care about counts for more, one they don't for less (docs/motivation.md section 5)
  const add = (label: string, delta: number, v = -1) => {
    if (v >= 0 && h.bend) delta *= h.bend[v];
    if (Math.abs(delta) >= 0.5) parts.push({ label, delta: Math.round(delta) });
  };
  const adult = c.stage !== LifeStage.Child;
  if (c.job && c.commuteTicks > 0) {
    const min = (c.commuteTicks * 60) / TICKS_PER_HOUR;
    add(min <= 20 ? 'short commute' : `long commute (${Math.round(min)} min)`, min <= 20 ? 3 : -Math.min(15, (min - 20) / 5), TIME);
  }
  if (adult) {
    add(c.money < 15 ? 'short of money' : c.money < 60 ? 'money is tight' : c.money > 300 ? 'comfortable savings' : 'gets by', c.money < 15 ? -10 : c.money < 60 ? -3 : c.money > 300 ? 6 : 2, MONEY);
    const wk = week(c, h.tick);
    if (wk.income + wk.spend > 0) add(wk.income >= wk.spend ? 'earning more than spending' : 'spending more than earning', wk.income >= wk.spend ? 2 : -3, MONEY);
  }
  add(c.health >= 70 ? 'good health' : c.health >= 45 ? 'so-so health' : 'poor health', (c.health - 70) * 0.25);
  if (c.cond & ACUTE) add('unwell right now', -4);
  add(['no services nearby', 'some services nearby', 'good services nearby', 'every service nearby'][Math.min(3, h.coverage)], [-6, 0, 4, 8][Math.min(3, h.coverage)], FAMILY);
  const fun = Math.max(0, Math.min(1, c.leisure));
  add(fun >= 0.65 ? 'good times out' : fun >= 0.35 ? 'the odd outing' : 'nothing to do', fun >= 0.65 ? Math.min(6, (fun - 0.5) * 16) : fun >= 0.35 ? 1 : -Math.min(6, (0.35 - fun) * 18 + 1), ADVENTURE);
  if (h.parks && h.parks > 0) add('park nearby', Math.min(5, 1 + h.parks * 0.6), TIME);
  if (c.stage === LifeStage.Adult && !c.job) {
    if (SKILLS.on && c.study) add('studying', 2, STATUS); else add('out of work', -8, MONEY);
  }
  // education (sim/skills.ts): a graduate in a place far below their level, and the first days after graduating
  if (overQualified(c)) add('over-qualified', -2, STATUS);
  if (SKILLS.on && c.grad !== undefined && h.tick / DAY - c.grad < EDU.drainDays) add('graduated', 5, STATUS);
  // a parent's children at school (docs/education.md section 7), and free school meals (the E6 policy)
  if (h.kids?.school) add(h.kids.school > 0 ? 'good school nearby' : 'no school place', h.kids.school > 0 ? 3 : -4, FAMILY);
  if (h.kids?.meals) add('free school meals', POLICY.mealsMood, FAMILY);
  if (c.stage === LifeStage.Retired) add('retired', 3);
  const social = Math.min(6, c.friends.length * 2) + (c.partner ? 4 : 0);
  add(social > 0 ? (c.partner ? 'partner and friends' : 'friends') : 'lonely', social > 0 ? social : -3, ROOTS);
  const trafficMin = (c.trafficTicksLife * 60) / TICKS_PER_HOUR;
  if (trafficMin > 20) add('stuck in traffic', -Math.min(6, trafficMin / 10), TIME);
  const mood = MOODS.get(c)?.(h.tick); // grief (sim/death.ts): a family value
  if (mood) add(mood.label, mood.delta, FAMILY);
  if (h.weather) add(h.weather.label, h.weather.delta);
  parts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return parts;
}
export const happinessOf = (parts: { delta: number }[]) => Math.max(0, Math.min(100, Math.round(50 + parts.reduce((s, p) => s + p.delta, 0))));
