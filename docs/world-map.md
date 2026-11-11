# World map and parcel management (design)

UTD card 666cb653. Rich: "world map where we can really zoom out and manage the parcels, combine, separate etc".

In one paragraph: a **map mode** (Tab, the top-bar **map** chip, or zooming out past the normal limit) swaps the 3D
city for a flat, north-up map of the whole world. The ground is drawn from a compact **per-chunk land-use summary**
(one byte per tile, run-length coded) that the server caches per sector of 8×8 chunks and sends only for sectors whose
version the client does not have. Chunks nobody has changed are not sent at all: the client draws them from the seed,
as the server generates them. Parcels are drawn from the parcel list every client already has, as owner-coloured
union outlines with names. On your own land the map manages parcels: **combine** adjacent parcels, **split** one along
a line you drag, **rename** and **colour** it, and read its stats (area, buildings, population, jobs, book value).

## 1. Map mode

| | |
| --- | --- |
| Toggle | **Tab**, the **map** chip, or scrolling, pinching or pressing − past the 3D limit (`DIST_MAX` 220). Zooming back in below 150 returns to 3D at the tilt you left. Every letter key was taken (tools, camera, H N T M I O); Tab is free and is what many games use for a map. Esc leaves the map too (after dropping a cut, then the selection). `?map` opens on it. |
| Camera | the ordinary `CameraRig`, eased to north-up (yaw 0) and straight down (`MAP_PITCH` 1.565), with the zoom range widened to `MAP_DIST_MAX` 6000 (about 9000 tiles across on a 16:10 window). Near and far planes follow the distance. |
| Rendering | a separate `Scene` (`render/worldmap.ts` `MapView`): the main scene is not rendered at all, so no buildings, agents, shadows or fog cost anything. Everything is `MeshBasicMaterial`, unlit, not tone mapped. |
| Streaming | the chunk subscription set becomes empty: no chunk geometry, agents or traffic bytes arrive while the map is up. Leaving the map subscribes again as usual. |
| Navigation | the game's scheme (main 7e2280e): scroll and pinch zoom about the cursor, + and − zoom, a drag pans (left, with 5 px of slop before a press stops being a click, as the select tool; right drag too), Shift+scroll and WASD pan, and the "scroll pans" setting applies. Rotation is off: Alt+scroll, middle and Alt drag, Q E R F do nothing, so the map stays north-up. A click selects, shift-click adds. Spectators (a read-only showcase) can open the map (`map` is a read-only intent) but get no editing controls. |

### Ground: sectors and levels of detail

The world is cut into **sectors** of 8×8 chunks (256×256 tiles). Each sector is one textured quad. Its texture is built
on the CPU. A **cell** is one textured quad with a 256² texture at one of three levels, picked from the zoom: L0 covers
one sector at a texel per tile, L1 4×4 sectors at a texel per 4×4 tiles, L2 16×16 sectors at a texel per 16×16 tiles.
L0 is used while a tile is less than a pixel across (`levelFor`), L1 up to 4 tiles a pixel, L2 beyond. Painting costs
one terrain sample per texel of untouched land (four, averaged and muted towards one tint, at L2, where the lakes are
smaller than a pixel and would otherwise speckle; about 13 ms for a whole cell in Node, more in a busy browser) plus
a copy of the summary bytes, so cells are painted a few rows at a time within a 6 ms budget a frame, coarsest first and
nearest the view centre first; the coarser cells stay underneath as a backdrop until the finer ones are done. At most
80 cells a level are drawn (else the coarser level shows), and 160 are kept. When a sector's summary changes only the
chunks whose bytes differ are repainted, in every cell over them (a 32×32, 8×8 or 2×2 texel patch), then uploaded once.

Colours: grass, sand and water as the 3D ground; roads dark grey; track brown; runways grey; zones in their tool
colours (homes green, shops blue, industry amber, offices violet), civic red, transport slate, leisure deep green. A
building's level shades its zone colour darker, so towers read as dark cores; an empty zoned lot is the pale zone
colour; a site under construction is hatched.

### The summary (shared/src/worldmap.ts)

One byte per tile: bits 0-3 the class (`MapClass`), bits 4-6 the level (0-7), bit 7 under construction. Classes:
grass, sand, water, road, track, airfield, residential, commercial, industrial, office, civic, transport, leisure.
`mapByte(tile, aux)` is the one function both sides use. A chunk's 1024 bytes are run-length coded as (run-1, byte)
pairs and base64'd: a built-up district chunk is about 1 KB on the wire. The coarser **detail levels** keep one byte
per 4×4 or 16×16 tiles, each block's most common byte (`downsample`; roads drop out, zones stay): 64 or 4 bytes a chunk,
75 and 15 bytes on the wire. The client asks at the level its view draws.

### Wire

```
client  { t: 'map', s: [sx, sy, ver, sx, sy, ver, …], l? }       sectors in view, the version held (0: none), at most 512; detail level l
server  { t: 'mapSector', sx, sy, v, l?, c: [[cx, cy, rle], …] } only for sectors whose version differs; c lists modified chunks
```

The client asks for the sectors in view when the view moves and every 3 s while the map is up (less often for a wide
view: 3 s for every 40 sectors). The server keeps a version per sector (`server/src/worldmap.ts` `MapSummaries`),
bumped by `Net.flush` for every tile, aux and sub change it sends, and a cache of the encoded message per sector and
level, rebuilt on the first request after a change. A request for
unchanged sectors costs a version compare each. Nothing is pushed, so the server holds no per-client map state. Chunks
not listed are untouched: the client samples `makeTerrainSampler(seed)`, the server's own generator, for them.

### Overlays

- **Parcels**: a faint fill in the parcel's colour (its own if set, else the owner's), a ribbon of constant screen
  width round each owner's land (`unionOutline` per owner, as in 3D) and a thinner one between that owner's estates
  and lone parcels. The ribbons are rebuilt when the zoom changes by more than 15%.
- **Labels** (HTML, never overlapping, biggest first): owner names over each owner's land when zoomed far out, estate
  and parcel names nearer, and line names (bus, rail, metro) at the middle of each route.
- **Lines**: bus paths, rail and metro routes as ribbons in the line colour.

## 2. Parcel management

The parcel model stays **rectangles**: every parcel is `x, y, w, h` and the per-tile parcel id says which one owns a
tile. Purchases, adjacency, islanding, `recountRoads` and every reader of `parcelAt` keep working unchanged.

- **Combine** (select a parcel, shift-click the others, then Combine). All parcels must be yours (anyone's in a
  sandbox, but all one owner's), and joined edge to edge. Pairs whose union is a rectangle no longer than
  `MAX_PARCEL_EDGE` (48) on either side are **merged** into one parcel: the lower id keeps its name and settings, the
  other's tiles take its id and it is removed. Whatever is left as more than one parcel becomes an **estate**: a
  named group (`Parcel.group`, a fresh id). Members of an estate share name, colour and tax rate: setting one sets
  all. The map and the 3D outline draw an estate as one shape. Combining a parcel with an estate member joins the
  whole estate.
- **Split** (Split, then drag across the parcel). The cut is straight along a tile boundary, horizontal when the drag
  is mostly horizontal, at the drag's mean position. Both parts must keep at least one dry tile, and the cut may not
  pass through a building (any structure with tiles on both sides). The part on the west or north keeps the id; the
  other part is a new parcel named "<name> (east)" and so on, with the same owner, colour and tax rate, outside any
  estate. **Leave estate** takes one parcel out of its estate (an estate of one is dissolved).
- **Rename**, **colour** (eight swatches plus the owner's colour), **tax rate** as in the parcel panel.
- **Stats**: area, buildings, population, jobs filled, road tiles, book value and tax yesterday, for the parcel and
  for its estate.

Why an estate instead of non-rectangular parcels: a polygon parcel would change `ParcelDTO`, the purchase rules'
`owned` rectangles, the 3D outline, `recountRoads` and every save. A group keeps storage and rules as they are,
needs two optional fields, and still lets a player treat an L-shaped holding as one place.

**Book value** = land at `LAND_PRICE_PER_TILE`, roads at `ROAD_COST`, each placed building at its cost
(`CIVIC_COST`), each grown building at its zoning (`ZONE_COST` a tile) plus its builder work to its level at
`CONSTRUCTION_FEE`. It is what the parcel cost to make, not a market price (there is no market yet).

### Validation

`shared/src/parcelops.ts` holds `planCombine` and `planSplit`, pure functions over the parcel list and a
`ParcelEnv` (water, structure doors). The server runs them with the world's tiles and is the authority. The client
runs them for the preview with what it has: map summaries for water, and no structure check (the server refuses a
cut through a building and says which). A preview is green or red with the reason in the status line.

### Wire and persistence

```
client  { t: 'parcelOp', op: 'combine', ids: number[] }
        { t: 'parcelOp', op: 'split', id, axis: 'x' | 'y', at }     cut at x = at (or y = at)
        { t: 'parcelOp', op: 'ungroup', id }
        { t: 'parcel', id, name?, taxRate?, color? }                 color -1 clears it
```

`Parcel` and `ParcelDTO` gain `group?` and `color?`; `ParcelStats` gains `buildings` and `value`. Snapshots store
parcels whole, so no version bump: older saves load with neither field. Local mode runs the same `Net`, so it works
there unchanged; `npm run local:check` covers the seam. The tile changes of a combine or split go out as ordinary
tile deltas and the parcels message carries the changed and removed parcels.

## 3. Showcase

The showcase's South railway and Riverside lands are combined into the **Riverside estate** at seeding, through
`planCombine` (their union is 70×26, past the 48-tile limit, so it is an estate, not a merge). The tour has a
**World map** stop that opens the map over the whole town (`view: 'map'`), and `SHOWCASE_FEATURES` has `world-map`:
the stop in the scenario and an estate of two or more parcels in the seeded world.

## 4. Costs

`npm run parcels:check` measures the wire (Node, this machine, October 2026):

| World | View | First answer | Bytes | Cached / unchanged |
| --- | --- | --- | --- | --- |
| 8×8-district test city (36 chunks) | all of it, full detail | 7 ms | 37 KB, 1 KB a chunk | 0.5 ms |
| 2048×2048 tiles all built on (4096 chunks, 64 sectors, a street every 5 tiles and dense lots) | all of it, full detail | 250 ms | 8.0 MB, 2 KB a chunk | 0.6 ms; versions held: nothing sent |
| the same | a byte per 4×4 tiles | 123 ms | 300 KB | |
| the same | a byte per 16×16 tiles (what a view that wide asks for) | 72 ms | 62 KB | |

Untouched chunks cost nothing on the wire, and a sector nobody touched is a 45-byte answer once. The client's map frame
(headless Chrome on Metal, 1440×900, a machine under heavy load from other jobs, load average 10-26, so wall-clock
frames are noisy; CPU is the time inside `MapMode.frame`):

| World and view | CPU per frame, mean / p95 | Frame interval, mean / p95 | Draw calls |
| --- | --- | --- | --- |
| 8×8 test city (80,000 people), whole city at dist 300 | 3.6-4.3 / 1.2-9 ms | 22-23 / 33-67 ms | 20 |
| the same, zoomed right out (dist 6000, 9000 tiles across) | 0.4-0.7 / 0.5-1.9 ms | 17.0 / 16.8 ms (vsync) | 16 |
| the same, panning 10 tiles a frame at dist 900 (cells painting as they come in) | 3.4-12.6 / 9-57 ms | 22-33 / 67-100 ms | 41-43 |
| London (194 parcels of 25 boroughs, 9,187 buildings), whole city | 4-12 / 19-30 ms | 27-39 / 83-183 ms | 20-24 |
| London zoomed right out | 0.4-3.4 / 0.2-7 ms | 16.7 / 16.8 ms (vsync) | 16 |

Before chunk-level repainting, a live city's changing sectors rebuilt whole cells every few seconds (8×8 city: 18 ms
mean, 82 ms p95). For scale, the 3D view of the Showcase on the same machine at the time took from a third of a second
to several seconds a frame.

## 5. Follow-ups

- ~~Selling or transferring parcels between players, on the map.~~ Built: the land market, `docs/multiplayer-land.md`
  "Built: M7 land market" (listings, offers, covenants, leases and neighbour pacts in the parcel panel; the For sale
  layer and the market box on the map; `client/src/landmarket.ts`).
- Dragging a pact's strip freely (today it is a band along the shared edge, a set number of tiles each side).
- A minimap inset in 3D mode, from the same sector textures.
- Splitting an estate along a line through several members at once.
- A push of sector changes while the map is up (now a 3 s poll).
