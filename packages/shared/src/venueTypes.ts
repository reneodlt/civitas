/**
 * Every kind of outing a leisure place offers, in a fixed order: the index is the seed of each citizen's taste for it
 * (server simulation pickLeisure), so new types go on the end and the first five keep the tastes they always had.
 * The five originals are the size ladders; the rest are the free-time places of buildings/attractions.ts (docs/leisure.md).
 * No imports: the catalogue's validation (buildings/validate.ts) reads it before anything is compiled.
 */
export const VENUE_TYPES = [
  'park', 'cinema', 'theatre', 'sports', 'library',
  'playground', 'skatepark', 'allotments', 'fishing', 'reserve',
  'lido', 'tennis', 'bowling', 'icerink', 'rollerdisco', 'climbing', 'trampoline', 'karting',
  'funfair', 'farm', 'aquarium', 'planetarium', 'science', 'observatory',
  'gallery', 'pottery', 'concert', 'dancehall',
  'arcade', 'boardgames', 'escape',
] as const;
export type VenueType = typeof VENUE_TYPES[number];
/** Outings that need nobody on the payroll to open: the parks and the free places of the Play and green collection. */
export const UNSTAFFED_VENUES: readonly VenueType[] = ['park', 'playground', 'skatepark', 'allotments'];
