import { VALUE_KINDS, VALUE_KIND_COUNT } from './value';

/**
 * Issue bubbles, the problems list and the data overlays (docs/audit-2026-10.md section 4.4, server/src/sim/issues.ts,
 * client/src/render/issues.ts, client/src/problems.ts). Shared so both sides agree on the codes and the wording.
 */

/** What is wrong with a building or lot: one 3-bit code per tile (the door tile of a structure); 0 is nothing. When several hold,
 * the first of on fire, no burial space, no road, no builders, unstaffed, no customers, parking full, very unhappy is shown (server/src/sim/issues.ts).
 * No burial space (docs/remembrance.md) marks a mortuary or funeral director where bodies wait for a plot.
 * On fire is set the moment a fire starts and cleared when it is out (server/src/sim/fires.ts), not on the issues' round. */
export const Issue = { None: 0, NoRoad: 1, NoBuilders: 2, Unstaffed: 3, ParkingFull: 4, NoCustomers: 5, Unhappy: 6, Fire: 7, NoBurial: 8 } as const;
export type IssueCode = (typeof Issue)[keyof typeof Issue];
/** in the problems panel's order: a fire first, it is the one that will not wait */
export const ISSUE_CODES = [7, 8, 1, 2, 3, 4, 5, 6] as const;

export interface IssueText {
  /** the panel's group heading and the tooltip's line */
  title: string;
  /** one line: what it means and what fixes it */
  explain: string;
}
export const ISSUE_TEXT: Record<number, IssueText> = {
  [Issue.NoRoad]: { title: 'No road', explain: 'Nothing grows or opens without a road beside it. Lay a road along the lot, or zone the lot next to one.' },
  [Issue.NoBuilders]: { title: 'No builders', explain: 'Builders are at work elsewhere but none has come to your sites for an hour and you have no builders\' yard, or none has come to this one for two days. Place a builders\' yard (another, if yours is busy), check a road links it, or raise this site\'s priority.' },
  [Issue.Unstaffed]: { title: 'Unstaffed', explain: 'Fewer than half the staff it needs are at work. It needs homes nearby (people to hire) and a road to reach it.' },
  [Issue.ParkingFull]: { title: 'Parking full', explain: 'Drivers find it full and park at the kerb, slowing the street. Put a parking lot within ten tiles, or Deep foundations for parking underneath.' },
  [Issue.NoCustomers]: { title: 'No customers', explain: 'Nobody came all of yesterday. Customers need homes in reach by road; check the street links up.' },
  [Issue.Fire]: { title: 'On fire', explain: 'A fire is burning. The nearest staffed fire post or station within 14 tiles sends an engine; with none in reach it burns down. A fire post (Emergency services) is cheap.' },
  [Issue.NoBurial]: { title: 'No burial space', explain: 'The dead are waiting here because no churchyard, cemetery or crematorium in reach has room: their families grieve longer. Build a cemetery or a crematorium (Remembrance), within 80 tiles.' },
  [Issue.Unhappy]: { title: 'Very unhappy', explain: 'Far unhappier than the rest of your town. Each home says what hurts most and what helps; hover a resident for the rest.' },
};

/**
 * Why a very unhappy home is unhappy: the largest complaint of its unhappiest resident that the player can do something
 * about (sim/life.ts happinessParts labels; loneliness and being over-qualified are left out), sent with the problems list
 * (message `problems`, r). 0 is none known.
 */
export const MOOD_REASONS: { id: number; labels: string[]; title: string; advice: string }[] = [
  { id: 1, labels: ['no services nearby'], title: 'no services nearby', advice: 'Services in reach: a police station, fire station or clinic counts in full, a box or post for less.' },
  { id: 2, labels: ['out of work'], title: 'out of work', advice: 'Zone jobs nearby: shops, industry or offices.' },
  { id: 3, labels: ['long commute'], title: 'long commute', advice: 'Zone jobs closer to these homes, or run a bus line.' },
  { id: 4, labels: ['nothing to do'], title: 'nothing to do', advice: 'Put a park or a venue in reach.' },
  { id: 5, labels: ['short of money', 'money is tight', 'spending more than earning'], title: 'short of money', advice: 'More jobs, and better-paid ones (offices), let them earn.' },
  { id: 6, labels: ['stuck in traffic'], title: 'stuck in traffic', advice: 'Ease the streets: another road out, or a bus line.' },
  { id: 7, labels: ['no school place'], title: 'no school place', advice: 'Build a school in reach.' },
  { id: 8, labels: ['poor health', 'so-so health', 'unwell right now'], title: 'poor health', advice: 'Put a clinic in reach.' },
];
/** The reason id for a happiness part's label ("long commute (42 min)" matches "long commute"), 0 when it is not one to act on. */
export function moodReasonOf(label: string): number {
  for (const r of MOOD_REASONS) for (const l of r.labels) if (label.startsWith(l)) return r.id;
  return 0;
}

/** The data overlays the server can send (message `overlay`); congestion is the traffic message's own tint. 0 is none. */
export const Overlay = { None: 0, Coverage: 1, Leisure: 2, Happiness: 3, JobsHomes: 4, News: 5, Neighbourhood: 6 } as const;
/**
 * The Neighbourhood overlay's tabs (shared/src/value.ts, docs/multiplayer-land.md section 4): Overlay.Neighbourhood is
 * the combined value, and channel NEIGHBOURHOOD_KIND0 + k is value kind k (noise, smell, ... culture).
 */
export const NEIGHBOURHOOD_KIND0 = 7;
export const OVERLAY_COUNT = NEIGHBOURHOOD_KIND0 + VALUE_KIND_COUNT;
/** Is this overlay channel the Neighbourhood layer (the combined value or one of its kinds)? */
export const isNeighbourhoodOverlay = (ch: number) => ch === Overlay.Neighbourhood || (ch >= NEIGHBOURHOOD_KIND0 && ch < OVERLAY_COUNT);
export interface OverlayText { name: string; /** the legend's two ends */ lo: string; hi: string; /** 0 sequential (viridis-like), 1 diverging (blue-orange) */ ramp: 0 | 1; explain: string }
export const OVERLAY_TEXT: Record<number, OverlayText> = {
  [Overlay.Coverage]: { name: 'coverage', lo: 'none', hi: 'police, fire and health', ramp: 0, explain: 'Police, fire and health cover from staffed stations, on every lot' },
  [Overlay.Leisure]: { name: 'leisure', lo: 'nothing to do', hi: 'plenty to do', ramp: 0, explain: 'Parks and open venues in reach of each lot' },
  [Overlay.Happiness]: { name: 'happiness', lo: 'miserable', hi: 'happy', ramp: 0, explain: 'Mean happiness of the people living in each home' },
  [Overlay.News]: { name: 'news', lo: 'no channel', hi: 'rival channels', ramp: 0, explain: 'Where the media centres\' channels reach (docs/media.md): one channel, or two or more competing for the stories' },
  [Overlay.JobsHomes]: { name: 'jobs / homes', lo: 'needs jobs', hi: 'needs homes', ramp: 1, explain: 'Jobs minus residents within 8 tiles: orange has more people than work, blue more work than people' },
  [Overlay.Neighbourhood]: { name: 'neighbourhood', lo: 'blighted', hi: 'sought after', ramp: 1, explain: 'What is near each lot, nuisance against amenity, for the average household (docs/multiplayer-land.md); pick a kind below' },
};
VALUE_KINDS.forEach((k, i) => { OVERLAY_TEXT[NEIGHBOURHOOD_KIND0 + i] = { name: k.name, lo: k.lo, hi: k.hi, ramp: 0, explain: k.explain }; });

/** Overlay bytes: 0 is no data (water, roads, a happiness tile with nobody home); 1-255 carry the value. */
export const overlayByte = (v01: number) => 1 + Math.round(Math.max(0, Math.min(1, v01)) * 254);
export const overlayValue = (b: number) => (b - 1) / 254;
/** service coverage that fills the ramp (three families at full strength) */
export const OVERLAY_COVERAGE_FULL = 3;
/** jobs-minus-residents within the radius that reaches either end of the diverging ramp */
export const OVERLAY_JOBS_RADIUS = 8, OVERLAY_JOBS_FULL = 80;
