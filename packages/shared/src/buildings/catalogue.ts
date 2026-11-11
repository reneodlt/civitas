import type { KindDef } from './schema';
import { EXTRA_DESIGNS } from './designs';
import { residential } from './residential';
import { pioneerCamp } from './camp';
import { commercial } from './commercial';
import { industrial } from './industrial';
import { office } from './office';
import { police, fire, hospital, yard } from './civic';
import { parking, busDepot, busStop } from './transport';
import { park, cinema, theatre, sports, library } from './leisure';
import { terminal } from './terminal';
import { railHalt, railStation, freightYard } from './rail';
import { motorwayStub } from './motorway';
import { metroEntrance, metroStation } from './metro';
import { HARBOURS } from './harbour';
import { CIVIC_TIERS } from './civic-tiers';
import { PARKING_TIERS } from './parking';
import { LEISURE_TIERS } from './leisure-tiers';
import { RESIDENTIAL_MERGED } from './residential-merged';
import { COMMERCIAL_MERGED } from './commercial-merged';
import { OFFICE_MERGED } from './office-merged';
import { INDUSTRIAL_MERGED } from './industrial-merged';
import { BLOCK_INTERIOR } from './block-interior';
import { LONDON_LANDMARKS } from './landmarks-london';
import { LANDMARK_DRAFTS } from './landmark-drafts';
import { WORLD_LANDMARKS } from './landmarks-world';
import { bigScreens } from './bigscreens';
import { EDUCATION } from './education';
import { MEDIA } from './media';
import { REMEMBRANCE } from './remembrance';
import { POWER } from './utilities';
import { REFUSE_SITES } from './refuse';

/**
 * Every building kind. This is source data: only the compile step
 * (`npm run buildings:compile`) reads it. The game reads the generated
 * compiled.ts and recipes.ts. Add a family file and list its kinds here.
 */
const BASE: KindDef[] = [residential, commercial, industrial, office, police, fire, hospital, yard, parking, park, cinema, theatre, sports, library, terminal, busDepot, busStop, railHalt, railStation, freightYard, motorwayStub, metroEntrance, metroStation,
  // the pioneer camp (Audit #1, camp.ts): kind id 120, a residential sub-kind placed like a structure (the tool bar puts it after Residential)
  pioneerCamp,
  // harbours (docs/boats.md section 5): kind ids 24-28, back rows over water
  ...HARBOURS,
  // size ladders (groups.ts): the smaller and bigger rungs around the kinds above
  ...CIVIC_TIERS, ...PARKING_TIERS, ...LEISURE_TIERS,
  // the big screens corner (docs/adverts.md section 9): kind id 117, the cinema ladder's top rung, six big screens round its corner
  bigScreens,
  // merged lots (zones.ts): bigger zone kinds that growth assembles from neighbouring lots
  ...RESIDENTIAL_MERGED, ...COMMERCIAL_MERGED, ...OFFICE_MERGED, ...INDUSTRIAL_MERGED,
  // block interiors: deep plots growing back into a block's landlocked middle, and the communal garden (block-interior.ts)
  ...BLOCK_INTERIOR,
  // education (docs/education.md section 3): kind ids 101-108
  ...EDUCATION,
  // broadcasters (docs/media.md N1): kind ids 130-132, placed sub-kinds of the office family
  ...MEDIA,
  // death and remembrance (docs/remembrance.md): kind ids 150-154, the funeral director (office family) and the resting places (park family)
  ...REMEMBRANCE,
  // utilities (docs/utilities.md section 2): kind ids 160-166, the power network's nodes, depot and plants, placed sub-kinds of the transport-hub family
  ...POWER,
  // refuse grades (docs/multiplayer-land.md section 5, M4): kind ids 217-221, placed sub-kinds of the transport-hub family
  ...REFUSE_SITES,
  // landmarks (docs/buildings.md "Landmarks"): real buildings in a city's collection, placed only where their locked tech is given
  ...LONDON_LANDMARKS,
  // world landmarks (docs/buildings.md "Landmarks"): real buildings in cities around the world, one collection per city
  // (landmarks-world.ts composes the per-city files, which document the kind-id blocks)
  ...WORLD_LANDMARKS,
  // draft landmarks (docs/landmarks.md, landmark-drafts.ts): kind ids 230-249, viewer only, never in the city
  ...LANDMARK_DRAFTS];

/** The catalogue with extra designs (designs/index.ts) appended to their kind+level; the family files stay untouched. */
export const CATALOGUE: KindDef[] = BASE.map((k) => {
  const extra = EXTRA_DESIGNS.filter((e) => e.kind === k.id);
  if (!extra.length) return k;
  return { ...k, levels: k.levels.map((l, i) => {
    const add = extra.filter((e) => e.level === (k.minLevel ?? 1) + i).map((e) => e.design); // merged zone kinds start above level 1
    return add.length ? { ...l, designs: [...l.designs, ...add] } : l;
  }) };
});
export { HELPER_MODELS } from './helpers';
