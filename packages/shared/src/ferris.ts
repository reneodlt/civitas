/**
 * The funfair's Ferris wheel (docs/leisure.md, buildings/attractions.ts kind 'funfair'). The building's recipe draws only
 * the A-frame legs and the axle; the client's wheel pass (client/src/render/wheels.ts) draws the rim, spokes and gondolas
 * turning, and the first-person view rides one of the gondolas above the real town (render/leisureRooms.ts). Both read
 * these numbers, in the 3×3 recipe's own tile units: x across the frontage, y up, z toward the road (+z), centred on the
 * footprint. The wheel turns in the x-y plane about an axle along z.
 */
export const FERRIS = {
  /** the hub (axle centre) in the recipe's frame */
  hubX: -0.3, hubY: 1.62, hubZ: -0.75,
  /** rim radius: the gondolas' pivots run round this */
  r: 1.15,
  /** gondolas round the rim */
  gondolas: 12,
  /**
   * How far a gondola's floor hangs below its pivot, and its size (across the plane, along the axle, tall), tiles. The
   * lowest gondola's floor clears the ground by hubY - r - hang (0.05); a rider's eye sits well below the rim's cross-ties.
   */
  hang: 0.42, cabW: 0.26, cabD: 0.3, cabH: 0.34,
  /** seconds a full turn takes while running, and seconds to wind up or down when the fair opens or closes */
  period: 150, ramp: 8,
  /** how far apart the A-frame's feet stand either side of the axle, along z */
  legSpread: 0.38,
} as const;
/** The kind id of the funfair (buildings/attractions.ts), for the wheel pass to find its placements. */
export const FUNFAIR_KIND = 250;
