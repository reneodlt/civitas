import { TICKS_PER_DAY, TICKS_PER_HOUR } from './constants';
import { ValueKind, VALUE_KIND_COUNT } from './value';
import { Value } from './motivation';
import { hash2 } from './noise';
import { SECTOR_TILES } from './worldmap';

/**
 * Campaigns on planning applications (docs/multiplayer-land.md section 6, M6). The definitions both sides read: the
 * claim table of the `plan` campaign target, the tuning of reach, leaflets, public meetings, turnout claims, spending caps
 * and credibility, and how a claim is checked against the truth. The server (sim/campaigns.ts) runs them; the client's
 * planning panel offers the claims and shows the spend and credibility.
 *
 * Every claim names a value (whom it speaks to: the voter's weight on it scales the nudge, as adverts' themes do) and a
 * test against the truth: a nuisance or amenity kind of the M1 field rising past a mark or staying under one, the
 * published value falling or holding, or a plain fact (the building stands, an offer was made, the plan was amended).
 * Before the vote the test reads the plan's expected impact on the voters' homes (planImpact); after a plan is built it
 * reads the field as measured over the homes of the zone, and the claimant's credibility follows.
 */

/** A claim's test against the truth. */
export type ClaimTest = 'low' | 'high' | 'falls' | 'holds' | 'built' | 'offer' | 'amended';
/** The published value (combineValue with the average household's weights) as a "kind" for price claims. */
export const PRICE_KIND = VALUE_KIND_COUNT;
export interface PlanClaim {
  /** the motivation value it speaks to (docs/motivation.md section 3) */
  value: number;
  /** For (1), Against (-1), or a turnout claim (0: the campaign picks its side) */
  side: 1 | -1 | 0;
  /** the words: {place} the most affected neighbourhood's name, {n} the jobs, {day} when the vote is */
  text: string;
  /** the kind it is about (a ValueKind, or PRICE_KIND), or null for a plain fact */
  kind: number | null;
  test: ClaimTest | null;
}
/** The claim table (section 6 "Campaigning on a plan"), by value: For, then Against; then the odour-free promise, "We listened" and the turnout claim. */
export const PLAN_CLAIMS: PlanClaim[] = [
  { value: Value.Money, side: 1, text: 'Lower bin charges for {place}', kind: ValueKind.Services, test: 'built' },
  { value: Value.Money, side: -1, text: 'House prices will fall', kind: PRICE_KIND, test: 'falls' },
  { value: Value.Family, side: 1, text: 'A new park for {place}', kind: ValueKind.Green, test: 'offer' },
  { value: Value.Family, side: -1, text: 'Fumes by the school', kind: ValueKind.Smell, test: 'high' },
  { value: Value.Status, side: 1, text: '{n} skilled jobs', kind: null, test: 'built' },
  { value: Value.Status, side: -1, text: 'Who\'d want to live next to a tip?', kind: ValueKind.Eyesore, test: 'high' },
  { value: Value.Roots, side: 1, text: 'Local jobs for local people', kind: null, test: 'built' },
  { value: Value.Roots, side: -1, text: 'Keep {place} green', kind: ValueKind.Eyesore, test: 'high' },
  { value: Value.Time, side: 1, text: 'Recycling on your doorstep', kind: null, test: 'built' },
  { value: Value.Time, side: -1, text: 'Lorries on our streets all day', kind: ValueKind.Traffic, test: 'high' },
  { value: Value.Adventure, side: 1, text: 'The cleanest plant in the region', kind: ValueKind.Smell, test: 'low' },
  { value: Value.Family, side: 1, text: 'Odour-free: you won\'t know it\'s there', kind: ValueKind.Smell, test: 'low' },
  { value: Value.Roots, side: 1, text: 'We listened: a changed plan', kind: null, test: 'amended' },
  { value: Value.Roots, side: 0, text: 'Have your say: vote by {day}', kind: null, test: null },
];
export const PLAN_CLAIM = {
  odourFree: PLAN_CLAIMS.findIndex((c) => c.text.startsWith('Odour-free')),
  fumes: PLAN_CLAIMS.findIndex((c) => c.text === 'Fumes by the school'),
  weListened: PLAN_CLAIMS.findIndex((c) => c.test === 'amended'),
  turnout: PLAN_CLAIMS.findIndex((c) => c.side === 0),
};
export const isTurnoutClaim = (i: number) => PLAN_CLAIMS[i]?.side === 0;
/** The claim's words for this plan. */
export function planClaimText(i: number, names: { place?: string; n?: number; day?: string }): string {
  const c = PLAN_CLAIMS[i];
  if (!c) return '';
  return c.text.replace('{place}', names.place ?? 'the neighbourhood').replace('{n}', String(names.n ?? 0)).replace('{day}', names.day ?? 'the deadline');
}

/** Tunables (section 6: channels, guards, credibility). Strengths are belief per game day of exposure, before scaling. */
export const CAMPAIGN = {
  /** a plan campaign's artwork (cheaper than an advert's: a notice is short and the words come from the table) */
  artCost: 60,
  /** reach runs once a game hour for open applications that have campaigns */
  passTicks: TICKS_PER_HOUR,
  /** a voter sees a poster within this many tiles of their home or of a tile of their commute */
  seeReach: 2,
  /** at most this many posters of one campaign count in one pass */
  seenPerPass: 4,
  /** per slot size, a day's exposure */
  strength: { panel: 0.22, poster: 0.26, hoarding: 0.3, billboard: 0.38, banner: 0.3, screen: 0.55 } as Record<string, number>,
  /** a worn poster works less, a wrecked one backfires (the condition curve of docs/adverts.md section 6) */
  backfireAt: 0.8, backfire: 0.3,
  /** TV spots on the city channels: a day of evening airtime; households with a set (share) are reached a little */
  tvCost: 600, tvStrength: 0.1, tvShare: 0.85,
  /** leaflets and doorsteps: per household on the roll, a strong nudge to its adults */
  leafletCost: 6, leafletStrength: 0.45,
  /** a public meeting: hire a hall near the zone (a marquee when none is near), speak at the other side's for less */
  meetingCost: 300, marqueeCost: 450, speakCost: 120, meetingStrength: 0.7,
  /** a resident on the roll attends with this chance; the meeting is at this hour (or before the vote, if sooner) */
  meetingAttend: 0.4, meetingHour: 19, hallReach: 24,
  /** when both sides speak, a side's nudge is × (lo + span × how true its claim is) */
  meetingTrueLo: 0.4, meetingTrueSpan: 1.2,
  /** a turnout claim: turnout among those leaning its way rises by gain × the nudge, at most `turnoutMax` */
  turnoutGain: 1.5, turnoutMax: 0.5,
  /** the spending cap per side: this share of the plan's cost (the building and its conditions), at least `capMin` */
  capShare: 1, capMin: 1000,
  /** no new campaigning (campaigns, posters, leaflets, meetings, TV) in the last game hour before the vote */
  lastTicks: TICKS_PER_HOUR, lastHourOn: true,
  /** credibility per player per sector: 1 at first, multiplies their campaigns there */
  credMin: 0.3, credMax: 1.5, credGain: 0.08, credLoss: 0.25, credFly: 0.15,
  /** residents live with an approved plan this long before its claims are judged */
  truthAfter: 2 * TICKS_PER_DAY,
  /** the tests: a kind "stays low" when it rises less than lowAt, "is high" when it rises by highAt; prices fall by priceFall */
  lowAt: 0.04, highAt: 0.08, priceFall: 0.03,
  /** area claims (about a parcel): a kind is "high" there at areaHigh and more, "low" at areaLow and less */
  areaHigh: 0.06, areaLow: 0.03,
  /** a false claim about someone else's land found running: taken down, and the poster pays this to the land's owner */
  falseFine: 500,
  /** fly-posting over someone else's poster: the cost, a day's limit, and the chance a pass finds one */
  flyCost: 40, flyPerDay: 3, flyFind: 0.2,
  /** contrarians (docs/motivation.md section 8): campaigns move them the other way */
  contrarian: 0.06,
  /** area opinion (section 6 "Opinion about areas"): a parcel's reputation per kind fades with this half-life (game days) and moves homeScore by up to this */
  areaHalfLife: 3, areaTerm: 0.15,
  /** an area claim's poster adds this to its parcel's reputation (-1..1) a day, at most six posters counted */
  areaPerPoster: 0.05,
};

/** Fixed per citizen from hashes (docs/motivation.md section 8): how far campaigns move them, and whether the other way. */
export const susceptibility = (id: number) => 0.3 + 0.7 * hash2(id, 311);
export const isContrarian = (id: number) => hash2(id, 312) < CAMPAIGN.contrarian;
/** Whether household `hh` has a television (reached by TV spots). */
export const hasTv = (hh: number) => hash2(hh, 321) < CAMPAIGN.tvShare;

/** A poster's condition from its wear: 1 fresh, 0 at backfireAt, negative past it (a wrecked poster puts people off). */
export const posterCondition = (wear: number) => Math.max(-CAMPAIGN.backfire, Math.min(1, 1 - wear / CAMPAIGN.backfireAt));

/** The map sector of a tile (docs/world-map.md: 256×256 tiles): credibility is kept per player per sector. */
export const sectorOfTile = (x: number, y: number): [number, number] => [Math.floor(x / SECTOR_TILES), Math.floor(y / SECTOR_TILES)];

/**
 * How true a claim is, 0-1, from what it is about: `change` the rise of its kind over the homes of the zone (0-1; for
 * PRICE_KIND the share the published value fell), `facts` the plain facts. 0.5 and over counts as true.
 */
export function claimTruth(claim: PlanClaim, change: number, facts: { built: boolean; offer: boolean; amended: boolean }): number {
  const cl = (v: number) => Math.max(0, Math.min(1, v));
  switch (claim.test) {
    case 'low': return cl(1 - change / (2 * CAMPAIGN.lowAt));
    case 'high': return cl(change / CAMPAIGN.highAt / 2 + (change >= CAMPAIGN.highAt ? 0.5 : 0));
    case 'falls': return cl(change / CAMPAIGN.priceFall / 2 + (change >= CAMPAIGN.priceFall ? 0.5 : 0));
    case 'holds': return cl(1 - change / (2 * CAMPAIGN.priceFall));
    case 'built': return facts.built ? 1 : 0;
    case 'offer': return facts.offer ? 1 : 0;
    case 'amended': return facts.amended ? 1 : 0;
    default: return 0.5;
  }
}

/** A plan campaign as the planning panel shows it. */
export interface PlanCampaignDTO {
  /** the advert campaign's id (its posters rent like any campaign's) */
  id: number; owner: string;
  /** 1 For, -1 Against */
  side: 1 | -1;
  claim: number; text: string;
  /** posters up, TV until (tick), households leafleted, distinct voters reached */
  posters: number; tv?: number; leaflets: number; reached: number;
}
/** What the panel shows of the campaigning on one application (PlanAppDTO.camp). */
export interface PlanCampaignsDTO {
  campaigns: PlanCampaignDTO[];
  /** spent by side [For, Against] and the cap per side */
  spent: [number, number]; cap: number;
  /** a public meeting: when, where, the hall's name, and the campaigns speaking; done once held */
  meeting?: { at: number; x: number; y: number; hall: string; speakers: number[]; done?: boolean };
  /** credibility in the site's sector of the applicant and the affected mayors (1 is neutral) */
  cred: Record<string, number>;
  /** no new campaigning from this tick (the last game hour), when the guard is on */
  closesAt?: number;
}
