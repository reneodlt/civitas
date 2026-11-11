import { CHUNK_SIZE } from './constants';
import { LAND_TUNING } from './tuning';
import { AVERAGE_VALUE_WEIGHTS, ValueKind, VALUE_CELL, VALUE_CELLS, VALUE_CELLS_PER_CHUNK, VALUE_SLOTS, combineValue } from './value';

/**
 * Land priced by what is near it (docs/multiplayer-land.md section 3, M2), shared so the server (authoritative, it
 * charges) and the client (the buy rectangle's preview) work out the same price from the same bytes. Browser-safe.
 *
 * The server's value field (server/src/sim/value.ts) keeps the eleven kinds per 4×4 cell. Each cell's **land value** is
 * the published value's formula (combineValue, the average household) with the green and quiet terms left out: open,
 * quiet country is what wilderness is made of, and with them in a field of grass would be the dearest land in the
 * world. So the land value is 1 in open country and with nothing near, above 1 near jobs, shops, stops, services and
 * culture, and below 1 under smell, noise, hazard or disorder.
 *
 * A tile's price is LAND_TUNING.base × exp(gain × (land value − 1)), clamped to [min, max], and it travels as one byte
 * per cell on a log scale between min and max (about 1.5% a step): the `landPrice` message carries a chunk's 64 bytes,
 * and both sides price a rectangle from those bytes alone (landPriceOf). A chunk with no field (nothing near) is
 * WILD_PRICE_BYTE: the base price.
 */

/** The weights of the land value: the average household's, without green and quiet. */
export const LAND_VALUE_WEIGHTS: Float64Array = (() => {
  const w = Float64Array.from(AVERAGE_VALUE_WEIGHTS);
  w[ValueKind.Green] = 0; w[ValueKind.Quiet] = 0;
  return w;
})();

/** The land value of one cell from its kind bytes (VALUE_KIND_COUNT of them from `off`); null is nothing near (1). */
export const landValueOfCell = (b: ArrayLike<number> | null, off: number) => combineValue(b, off, LAND_VALUE_WEIGHTS);

/** A tile's price in dollars for a land value. */
export function tilePriceOfValue(v: number): number {
  const T = LAND_TUNING;
  return Math.max(T.min, Math.min(T.max, T.base * Math.exp(T.gain * (v - 1))));
}
/** A tile price as its byte (log scale between LAND_TUNING.min and max) and back. */
export function priceByte(price: number): number {
  const T = LAND_TUNING, p = Math.max(T.min, Math.min(T.max, price));
  return Math.round((255 * Math.log(p / T.min)) / Math.log(T.max / T.min));
}
export function priceOfByte(b: number): number {
  const T = LAND_TUNING;
  return T.min * Math.pow(T.max / T.min, b / 255);
}
/** The byte of land with nothing near: the base price. */
export const wildPriceByte = () => priceByte(tilePriceOfValue(1));

/**
 * A chunk's price bytes (one per 4×4 cell, VALUE_CELLS_PER_CHUNK of them, row by row) from its value-field bytes
 * (VALUE_SLOTS a cell), or every cell at the wild price when the chunk has no field.
 */
export function landPriceBytes(field: ArrayLike<number> | undefined, out = new Uint8Array(VALUE_CELLS_PER_CHUNK)): Uint8Array {
  if (!field) return out.fill(wildPriceByte());
  for (let i = 0; i < VALUE_CELLS_PER_CHUNK; i++) out[i] = priceByte(tilePriceOfValue(landValueOfCell(field, i * VALUE_SLOTS)));
  return out;
}

/**
 * The price of a rectangle in whole dollars: the sum of its tiles' prices (water included, as before M2), at least
 * $1. `bytesOf(cx, cy)` gives a chunk's price bytes, or undefined for a chunk with none (the wild price).
 */
export function landPriceOf(r: { x: number; y: number; w: number; h: number }, bytesOf: (cx: number, cy: number) => ArrayLike<number> | undefined): number {
  const wild = priceOfByte(wildPriceByte());
  let sum = 0;
  // walk the rectangle a cell at a time: tiles in the overlap × the cell's price
  const cx0 = Math.floor(r.x / VALUE_CELL), cx1 = Math.floor((r.x + r.w - 1) / VALUE_CELL);
  const cy0 = Math.floor(r.y / VALUE_CELL), cy1 = Math.floor((r.y + r.h - 1) / VALUE_CELL);
  for (let gy = cy0; gy <= cy1; gy++) for (let gx = cx0; gx <= cx1; gx++) {
    const tx0 = Math.max(r.x, gx * VALUE_CELL), tx1 = Math.min(r.x + r.w, gx * VALUE_CELL + VALUE_CELL);
    const ty0 = Math.max(r.y, gy * VALUE_CELL), ty1 = Math.min(r.y + r.h, gy * VALUE_CELL + VALUE_CELL);
    const n = (tx1 - tx0) * (ty1 - ty0);
    const kx = Math.floor((gx * VALUE_CELL) / CHUNK_SIZE), ky = Math.floor((gy * VALUE_CELL) / CHUNK_SIZE);
    const b = bytesOf(kx, ky);
    const lx = gx - kx * VALUE_CELLS, ly = gy - ky * VALUE_CELLS;
    sum += n * (b ? priceOfByte(b[ly * VALUE_CELLS + lx]) : wild);
  }
  return Math.max(1, Math.round(sum));
}

/** Whether a rectangle is a free homestead for a player whose allowance is `homestead` tiles a side (absent: none left). */
export const isHomestead = (r: { w: number; h: number }, homestead: number | undefined) => !!homestead && r.w <= homestead && r.h <= homestead;
/**
 * What a purchase costs a player: the price, or nothing for a first purchase that fits in the homestead, or for a bigger
 * first purchase the share of the price beyond homestead² tiles.
 */
export function landCost(r: { w: number; h: number }, price: number, homestead: number | undefined): number {
  if (!homestead) return price;
  if (isHomestead(r, homestead)) return 0;
  const area = r.w * r.h, free = Math.min(area, homestead * homestead);
  return Math.max(1, Math.round((price * (area - free)) / area));
}
