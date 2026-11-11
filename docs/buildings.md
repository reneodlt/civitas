# Building catalogue

Every building kind is data. One file per kind family under `packages/shared/src/buildings/` describes what the simulation needs (capacity, wages, costs, parking, shifts, tech) and what the renderer draws (model recipes). A compile step validates it and writes flat tables that the game reads at tick time. Adding a design, a level or a kind means editing data files only.

## Files

| File | What it holds |
| --- | --- |
| `schema.ts` | The types: `KindDef`, `LevelDef`, `Design`, `Op`, `Attributes`, and the compiled shapes |
| `palette.ts` | Named colours (`PALETTE`) and window classes (`WINDOW_CLASSES`) a recipe may use |
| `codes.ts` | `Zone` (the family codes engine code refers to by name, which are also their base kinds' ids), `KIND_FLAG` bits, table layout, id limits |
| `helpers.ts` | Helper ops (`crane`, `flag`, `chimneyStack`), the `crane` and `site` helper models, and `repeat()` |
| `facade.ts` | Facades: cell grids per wall, the feature helper ops (`door`, `balcony`, ...), the window layouts the shader draws and the window collision rule (see "Facades") |
| `designs/` | Designs contributed outside the family files (AI trials, the brief's examples), appended to their kind and level by `catalogue.ts` |
| `residential.ts`, `commercial.ts`, `industrial.ts`, `office.ts`, `civic.ts`, `transport.ts`, `leisure.ts` | The kinds, one file per family. `transport.ts` also holds the draft bus depot, the first sub-kind (docs/sub-kinds.md) |
| `terminal.ts` | The airport terminal (8×7), the worked example of a multi-tile structure (docs/airport.md) |
| `rail.ts` | The rail halt (4×2), rail station (6×3) and freight yard (6×3): transport-hub sub-kinds with a platform or loading dock along the back row (docs/rail.md) |
| `motorway.ts` | The motorway connection (2×3, kind id 21): the road gateway newcomers, leavers, visitors and inter-city freight use (README "Gateways") |
| `harbour.ts` | The harbours (kind ids 24-28): jetty, marina, fishing harbour, ferry pier and cargo port, transport-hub sub-kinds whose back rows stand over water (`footprint.wet`), their berth slots (`HARBOUR_BERTHS`) and the draft Harbours ladder, two designs per kind (docs/boats.md section 5) |
| `metro.ts` | The metro entrance (1×1, kind id 22) and metro station (2×1, kind id 23): the surface half of an underground station, whose platform is a run of tiles in the under layer beneath the door; the "Underground" ladder, drafts until the Showcase and London place them (docs/underground.md) |
| `residential-merged.ts`, `commercial-merged.ts`, `office-merged.ts`, `industrial-merged.ts`, `zonekit.ts` | Merged lots: the bigger zone kinds growth assembles from neighbouring lots (see "Merged lots"), and the recipe parts they are drawn with |
| `block-interior.ts` | Block interiors: the deep plots that grow back into a block's landlocked middle and the communal garden (see "Block interiors") |
| `education.ts`, `edukit.ts` | The education ladder (kind ids 101-108: nursery, primary, secondary, sixth form, FE college, university campus, research institute, halls of residence), two designs each, and the recipe parts they share (playground, pitch, cupola, clock, lamp and bench and tree scatter at hashed offsets). Sub-kinds of the library family (code 14), civic and not leisure; placed in the Showcase (docs/education.md sections 3 and 14) |
| `landmark-drafts.ts` | Draft landmarks for contributors (kind ids 230-249; the template, a town hall clock tower and a war memorial; role presets in `landmark-roles.ts`): viewer only, never placed (docs/landmarks.md) |
| `landmarks-london.ts` | London landmarks (kind ids 91-100): the Gherkin, the Shard, the Walkie Talkie, One Canada Square, the Royal Opera House, and ids 96-100 reserved for the second five (see "Landmarks") |
| `landmarks-london-3.ts` | London's four universities (kind ids 111-114): UCL, Imperial College, King's College and the LSE, landmarks that work as universities (see "Landmarks", docs/education.md section 14) |
| `landmarks-london-4.ts` | Piccadilly Circus (kind id 116): the Piccadilly Lights round a curved corner, the Criterion, the Shaftesbury Memorial Fountain with Eros and the Underground stairs; a theatre-family venue with six big screens (see "Landmarks", docs/adverts.md section 9) |
| `bigscreens.ts` | The big screens corner (kind id 117): the cinema ladder's top rung, a corner block with six big screens round its curve, for any city (docs/adverts.md section 9) |
| `adslot.ts` | Ad slots (docs/adverts.md): the `adslot` frames, the default slots, and `screenArc`, which the `screens` op expands into |
| `media.ts` | The broadcasters (kind ids 130-132): the local TV studio, broadcast centre and media centre, placed sub-kinds of the office family whose `newsRadius`, `newsTier` and `newsHelicopters` the news reads (docs/media.md) |
| `remembrance.ts` | Death and remembrance (kind ids 150-154): the funeral director (an office-family placed kind whose staff drive the hearse) and the resting places, a ladder of the park family whose designs carry their `plots` (docs/remembrance.md) |
| `utilities.ts` | The power network (kind ids 160-166, docs/utilities.md): the substation, grid supply point and power depot (the `grid` ladder) and the wind turbine, solar farm, gas and coal power stations (the `power` ladder), placed civic sub-kinds of the transport-hub family whose `utility`, `supply`, `nodeRadius`, `nodeCapacity`, `importCap`, `fuel`, `availability`, `pollution` and `crews` shared/src/utilities.ts reads |
| `refuse.ts` | The refuse grades (kind ids 217-221, docs/multiplayer-land.md M4): open tip, lined landfill, recycling centre, composting and digester site, energy-from-waste plant, the `refuse` ladder, placed 2×2 civic sub-kinds of the transport-hub family like the power plants. Their `refuse` attribute names the grade; what each grade does (capacity, landfill share, smoke, sales, nuisance per home) is in `shared/src/refuse.ts` `REFUSE_GRADES` |
| `catalogue.ts` | The list of kinds the compile step reads |
| `validate.ts`, `compile.ts` | Validation and the pure catalogue-to-tables compiler |
| `compiled.ts` | Generated: typed tables, tool maps and the manifest. Committed like source |
| `recipes.ts` | Generated: every design as primitive ops with colours resolved. Committed like source |

Never edit `compiled.ts` or `recipes.ts` by hand.

## How it runs

- `npm run buildings:compile` validates the catalogue and rewrites `compiled.ts` and `recipes.ts` when their content changes. `--check` reports stale output without writing.
- `npm run dev` and `npm run build` run the compile first.
- The Vite plugin in `packages/client/vite.config.ts` also compiles when Vite starts and whenever a catalogue file is saved. Vite's hot reload then refreshes the city and `/viewer.html`. A broken catalogue shows in the Vite error overlay and leaves the last good output in place.
- The server picks up the regenerated `compiled.ts` through `tsx watch`, so client and server always read the same tables.
- `npm run buildings:check` is the snapshot test. It compares the tables with the values hard-coded before the catalogue existed, and every model's vertices and geometry bytes with the old `models.ts`. It also checks that the generated files are fresh, that validation rejects the mistakes it should, and that no part covers a window ("Facades").

## What the game reads

Hot paths never touch catalogue objects. They read typed arrays indexed by `kindId * 8 + level`. A kind id is the catalogue's numeric id for a kind; base kinds' ids equal their tile codes, sub-kinds take 16 and up (docs/sub-kinds.md):

| Table | Type | Wrapper |
| --- | --- | --- |
| `CAPACITY_TABLE` | `Int16Array` | `capacityOf(id, level)` |
| `WAGE_TABLE` | `Float32Array` | `wageOf(id, level)` |
| `UPKEEP_TABLE` | `Float32Array` | `upkeepOf(id, level)`, `CIVIC_UPKEEP[id]` |
| `COST_TABLE` | `Float32Array` | `CIVIC_COST[id]` |
| `WORK_TABLE` | `Int16Array` | `workOf(id, level)` |
| `PARK_SURFACE_TABLE`, `PARK_UNDERGROUND_TABLE` | `Int16Array` | `parkingOf(id, level, underground)`, `LOT_CAPACITY` |
| `KIND_FLAGS_TABLE` | `Uint8Array` | `isGrowableId`, `isCivicId`, `isServiceId`, `isWorkplaceId`, `isParkingId` |
| `FOOTPRINT_TABLE` | `Uint8Array`, 4 bytes per kind id | `footprintOf(id)`, `isMultiTile(id)` in `structures.ts` |
| `TOP_LEVEL_TABLE`, `DESIGN_COUNT_TABLE` | `Uint8Array` | `variant(id, level, pick)` in `models.ts` |
| `KIND_FAMILY_TABLE`, `FAMILY_BASE_TABLE` | `Uint8Array` | `familyOf(id)`, `kindIdOf(code, sub)`, `subFor(id)` in `tile.ts` |

The kind-code functions from before sub-kinds (`capacity`, `wageFor`, `upkeepFor`, `constructionWork`, `parkingCapacity`, `isGrowable`, `isCivic`, `isService`, `isWorkplace`) remain as wrappers: a family code means its base kind. Engine code reads a tile's kind with `kindIdAt(x, y)` and a building's with `Building.id`.

Level 0 is an empty zoned lot or a civic site still under construction; its numbers come from the kind's `lot` block. Levels above a kind's top level repeat the top level.

`MANIFEST` carries everything else as plain JSON for tooltips, the tool list and the viewer; each entry has its `kindId` and its family `code`. `KIND_NAMES` and `OCCUPATIONS` (both by kind id), `KIND_ID` (string id to kind id), the tool list in `ui.ts`, the shortcut keys in `input.ts`, the tool maps in `net.ts` and the facade tints in `chunkView.ts` all come from it.

The simulation still uses `WORK_PER_LEVEL`, `CIVIC_WORK` and `VENUE_CAPACITY_PER_LEVEL` directly. The catalogue's `work` and `visitorCapacity` values match them, and `buildings:check` fails if they drift. Switching the simulation to `constructionWork()` is a later change.

## A kind

```ts
export const police: KindDef = {
  id: 'police', name: 'police station', code: Zone.Police, family: 'civic',
  flags: { civic: true, service: true, workplace: true },
  windows: 'civic',
  tool: { id: 'police', key: '8', label: 'Police station', color: '#3454a8' },
  occupation: { name: 'police officer', rotate: true, shifts: [...], cycles: [...] },
  lot: { wage: 20 },
  levels: [{
    capacity: 12, wage: 20, cost: 400, upkeep: 20, work: 300, parking: { surface: 4, underground: 10 },
    designs: [{ name: 'station with a navy band and radio mast', height: 0.63, ops: [...] }],
  }],
};
```

| Field | Meaning |
| --- | --- |
| `id`, `name` | Stable id and the lower-case name used in sentences |
| `code` | Family code, 1 to 15: the 4 kind bits written into the tile word |
| `kindId` | Optional numeric id. Leave it out on a family's base kind (its id is its code). A sub-kind sharing a code sets 16 to 255; placing it writes the id into the tile's sub byte (docs/sub-kinds.md) |
| `family` | `residential`, `commercial`, `industrial`, `office`, `civic`, `transport` or `leisure`; decides which attributes are required |
| `flags` | `growable` (grows on zoned land), `civic` (placed, staffed, paid upkeep), `service` (covers nearby homes), `workplace` (employs citizens, needs `occupation`), `parking` (a lot), `leisureReady` |
| `windows` | Window class for boxes marked `true`: `home`, `shop`, `office`, `civic`, `factory` or `none` |
| `tool` | Tool id (also the tech feature that unlocks it), shortcut key, label and swatch colour |
| `occupation` | Job name, weighted shifts, work/rest cycles and whether rosters rotate |
| `tints`, `lotTint` | Facade tints picked per tile by hash, and the ground tint of an empty lot |
| `lot` | Numbers reported at level 0 |
| `levels` | Level 1 first (or `minLevel`), up to level 7. Numbers set on the kind are defaults for every level |
| `minLevel` | Optional, growable kinds only. The level the first entry of `levels` is (default 1). A merged zone kind starts higher: a mid-rise is level 4 and nothing less. Table slots below it repeat its first level and have no designs |
| `footprint` | Optional `{ w, h, door: [dx, dy] }` for a structure bigger than one tile; see below. Default 1×1 |
| `draft` | Optional. A work-in-progress kind: compiled into every table, but its tool shows only with `?dev` and only a dev server places it |
| `group`, `tier` | Optional. The size ladder this kind is a rung of (`groups.ts`) and its place on it, 1 = smallest. See "Groups and tiers" |
| `blurb`, `howTo` | Required on a grouped kind: a sentence or two for the size picker and the viewer, and how to place it well |

Per level: `capacity` (residents or jobs), `wage` (per 8-hour shift, required for workplaces), `upkeep` (per day, required for civic and parking kinds), `cost` (placement price, required unless growable; growable zones pay `ZONE_COST` per tile), `work` (builder work units), `parking.surface` and `parking.underground`, `feature` (a tech feature gating growth to this level, such as `level2`), `attrs` and `designs`.

## Attributes

Attributes merge kind, then level, then design, so the last one wins. Unknown keys are allowed and appear in the viewer. These are required by family:

| Family | Required | Example |
| --- | --- | --- |
| industrial | `pollution`, `noise`, `goodsType` | a refinery is `goodsType: 'fuel', pollution: 5` |
| commercial | `commerceType`, `visitorCapacity`, `openHours` | a café is `commerceType: 'café', openHours: [6, 19]` |
| residential | `style`, `rentBand` | level 3 is `style: 'apartments', rentBand: 'high'` |
| leisure | `venueType`, `leisureValue`, `radius`, `visitorCapacity`, `openHours`, `ticket`, `stay` | a cinema is `venueType: 'cinema', openHours: [12, 24], ticket: 8, eventNights: [4, 5], eventStart: 19.5` |

Gateways (any family): `gateway` (`motorway`, `rail`, `bus`, `air`, later `sea`), `gatewayModes` (how newcomers travel on from the gate: `car`, `foot`, `taxi`), `arrivalsPerHour` and, for a seaport, `needsWater`. `shared/src/gateways.ts` turns them into `GATEWAY_OF[kindId]`, which the server's `sim/gateways.ts` reads; a kind becomes a gateway by carrying them. The motorway connection, rail halt and station, bus depot and airport terminal do.

The leisure family's attributes drive behaviour; the other families' are not read by the simulation yet (they exist so land value and pollution cards can). `shared/src/leisure.ts` turns each leisure kind, level and live design into a flat record the simulation reads: who it appeals to (`dayAppeal`, `eveningAppeal`, `retireeAppeal`, `childAppeal`), when it is open, how many it holds, the ticket, how long a visit lasts, event nights (`eventNights` as weekdays, 0 = Monday, from `eventStart`), its `leisureValue` (need restored per visit and weight in the leisure coverage of homes within `radius`) and, for parks, `upgradeVisits` (daily visits that make it grow a level) and the client scatter (`paths`, `trees`, `benches`). Validation also checks the leisure rules: a known `venueType`, a park has no staff and a venue does, event nights are weekdays with a start hour, and opening comes before closing. Leisure kinds use codes 10-14. `LEISURE_CODES` lists the family codes that hold leisure kinds, for spatial lookups; `isLeisure` and `leisureAt` take kind ids.

## Model recipes

A design is a list of ops. Each op is a tuple of the op name and the same arguments as the matching `Kit` call in `render/kit.ts`. A tile is 1 by 1 with its centre at x=0, z=0 and the ground at y=0. +z faces the road. Heights in the current set run from 0.3 for a parking lot to 3.7 for the tallest office tower.

| Op | Arguments |
| --- | --- |
| `box` | w h d x y z colour [window class or `true`] [{ name, facade }]; base at y. See "Facades" |
| `roof` | w h d x y z colour [alongZ] [{ name }]; pitched prism, ridge along x unless alongZ |
| `door`, `garage`, `balcony`, `baywindow`, `porch`, `awning`, `cornice`, `dormer` | features placed by cell on a facade box; see "Facades" |
| `cyl` | rTop rBot h x y z colour [segments, default 8] |
| `cone` | r h x y z colour [segments, default 8] |
| `wheel` | r w x y z colour; a cylinder lying along x |
| `taper` | wBot dBot wTop dTop h x y z colour [{ win, shift }]: a box whose top is another rectangle (0×0 for a pyramid), centred over the base or `shift`ed by [dx, dz]; base at y. Tapering towers, leaning shards, a slab that widens upwards. `win` gives its near-vertical faces the legacy window grid |
| `lathe` | x y z colour profile [{ seg, twist, stripe, every, width, axis, win }]: a solid of revolution; `profile` is [r, dy, r, dy, ...] from the base up (r 0 for a point; an open top is capped). `twist` turns the rings that many degrees per tile of height, and `width` facets in every `every` take the `stripe` colour, so a twisted lathe has spiral bands. `axis` 'x' or 'z' lays it on its side (a barrel vault) |
| `crane` | x y z mastHeight |
| `flag` | x y z colour |
| `chimneyStack` | x y z h r [body colour, default `chimney`] |
| `screens` | x y z r from to cols rows h [bezel colour]: a bank of big screens round a curve (docs/adverts.md section 9). `cols` × `rows` flat `screen` ad slots on the facets of a dark bezel cylinder of radius r about (x, z), from `from` to `to` degrees (0 faces the front, 90 the right, -90 the left), foot at y, h tall. A column's angle must divide 360 and `from`, so the panels sit flush on the facets; never facing the back. Nothing stands proud of r, so a wall the curve meets tangentially keeps its windows |

A colour is a `PALETTE` name or a `0xRRGGBB` number. Only boxes carry windows, and only window faces light up at night. Data files are TypeScript, so `repeat(n, (i) => [...])` or `.flatMap` can build rows of identical parts. The compile step flattens them into plain arrays.

`height` is the top of the model. The crane over an upgrading building sits there. Each tile picks one live design of its kind and level by hash, so the first live designs keep their order. Adding a live design reshuffles which design stands on which tile for that kind and level.

## Facades

Without a facade, the shader draws a box's windows on one fixed grid of 7 × 5 cells per tile in model coordinates. That grid knows nothing about the wall's size, its storeys or the parts in front of it, so a door, balcony or bay window placed by coordinates almost always lands across a window. A **facade** lays a wall's windows out by storey and bay instead, and the helper ops below place doors, balconies and the rest **by cell**, so nothing ever covers a window.

```ts
['box', 0.56, 0.5, 0.5, 0, 0, 0, 'brick', true, { name: 'house', facade: { storeys: 2, bays: 3 } }],
['door', 'house', 'front', 1],          // ground floor, middle bay
['balcony', 'house', 'front', 1, 0, 2], // under the first-floor windows, across bays 0-2
```

A box takes an optional last element `{ name?, facade? }` after its window class (write `true` for the kind's class). A roof takes `{ name? }` after its alongZ flag, so dormers can name it. Old tuples stay valid, and a box without a facade draws exactly as before.

| Facade field | Meaning |
| --- | --- |
| `storeys` | Rows of cells: the box height (less `top`) split evenly. Aim for 0.2 to 0.3 tiles a storey |
| `bays` | Columns of cells on the front and back walls, between the margins. Aim for cells 0.12 to 0.2 tiles wide |
| `sideBays` | Columns on the left and right walls. Default: `bays` scaled by depth ÷ width, at least 1. `0` leaves the side walls blank |
| `ground` | The front wall's ground storey: `windows` (default), `door` (a door in bay ⌊bays/2⌋), `shopfront`, `garage` or `plain`. Boxes with shop windows default to `shopfront` |
| `margin` | Plain wall at both ends of every wall, in tiles (default 0). Corner piers, or room for a turret |
| `top` | A plain band at the top of the box, in tiles (default 0). A parapet, an attic band, or room under a carport roof |

Walls are `front` (+z, the road), `right` (+x), `back` (−z) and `left` (−x). Bays count from 0 at the **left as seen from outside that wall**. Storeys count from 0 at the ground.

**Feature helper ops.** `part` is a box's `name`, or its index in the design's ops (0-based, as written). Each expands at compile time into ordinary boxes and roofs placed from the cell grid, and changes the cells it sits on:

| Op | Arguments | What it does to the cells |
| --- | --- | --- |
| `door` | part face bay [colour=`door`] | A door and a step in that ground-floor cell; the cell draws no window |
| `garage` | part face bay | A roller door drawn in that ground-floor cell (no geometry) |
| `balcony` | part face storey fromBay toBay [rail=`dark`] [slab=`stone`] | A slab on the floor line under `storey` (1 or more) with a railing; those cells become glazed doors |
| `baywindow` | part face storey bay [roof=`slate`] | A glazed bay projecting from that cell, with its own front and side lights; the wall cell behind draws nothing |
| `porch` | part face fromBay toBay [roof=`slate`] [posts=`white`] | A canopy on two posts over those ground-floor bays, on the first floor line (the eaves of a one-storey box) |
| `awning` | part face fromBay toBay [colour=`awning`] | A canopy without posts over those ground-floor bays, for shopfronts |
| `cornice` | part storey [colour=`stone`] | A band round the box on that storey's floor line; `storey = storeys` caps the top of the wall |
| `dormer` | roofPart n [body=`white`] | n dormers with windows along a roof's front slope (its right slope when the ridge runs along z) |

Validation refuses a feature that names no box or roof, a feature on a box without a facade, an unknown wall, a bay or storey outside the grid, a balcony on the ground floor, a facade with no window class, a bad facade field and two parts with one name.

**How the shader aligns windows.** The kit (`render/kit.ts`) builds a facade box with one quad per cell: margins, cells, the top band, the roof and the floor. Every vertex carries `aFac` (u and v across its cell from 0 to 1, the cell's mode, the wall) and `aCell` (bay, storey, and the cell's width and height in tiles). The window shader (`render/materials.ts`) draws one window centred in each cell from those coordinates, sized from the cell. A window narrower than its cell keeps a sensible shape: sashes, arches and glazed doors are squeezed across when a cell is wide. Cell modes are window, plain (margins, top band, behind a door or a bay), glazed door, shopfront, garage and bay pane (`CELL` in `facade.ts`). Every other part gets zeros, which the shader reads as the legacy grid, so facade-free models render and snapshot exactly as before. `facade.ts` mirrors the shader's window layouts in `RECT`; keep the two in step.

**The windows check.** `buildings:check` ("windows") computes every window the shader draws on every wall of every windowed box: from the cells for a facade box, from the fixed grid for the rest. It then reports any other part whose near side lies within 0.03 tiles of that wall (or pokes out of it) and whose outline overlaps a window's frame, sill or signboard. A part that hides a whole cell, such as a wing built against the wall, is not a collision. A balcony railing may cross the lower third of the glazed doors behind it, and an awning may hang over the top of a signboard. The message names the design, the part and the windows:

```
FAIL window collision in 1:1 BAD: door box over a window (original, draft), a facade design:
    op 2 ["box",0.09,0.16,0.02,0.17,0.04,0.2,"door"] covers 1 window(s) on the front wall of op 0 box 'house': front storey 0 bay 2
```

It fails for designs that use facades, for drafts and for any new design. The original catalogue predates facades, so its known collisions are listed without failing (`scripts/window-baseline.ts`); `npm run buildings:check -- --windows` prints them all. Fixing one means giving its wall a facade and placing its door by cell, then deleting its line from the baseline. The cottage, the bungalow with carport, the brick townhouse, the duplex and the brick walk-up are fixed this way; their re-snapshotted geometry is recorded in `FACADE_FIXED` in the check. Designs kept as a "before" for comparison carry an author ending in `(raw)` and are listed too.

## Brief for AI designers

Copy this section into the prompt of a model designing buildings. It is complete on its own.

**What you write.** One TypeScript object per design, added to a `designs/*.ts` file:

```ts
{ kind: 'residential', level: 2, design: { name: 'short description', height: 0.74, draft: true, author: '<your model id>', ops: [ /* parts */ ] } },
```

`kind` is `residential`, `commercial` or `industrial`; `level` is 1, 2 or 3. `height` is the top of the tallest part. Keep `draft: true`: drafts show in `/viewer.html` (filter by Designer) and are never placed in the city.

**Space.** A design stands on one tile: x and z from −0.5 to 0.5, centred on 0, ground at y = 0. The front (+z) faces the road. Keep walls within ±0.45 and overhangs within ±0.5. Usual heights: level 1 homes 0.45-0.7, level 2 homes 0.55-0.75, level 3 homes 1.2-1.8; shops 0.4-0.65, 0.65-0.95, 1.9-2.3; factories 0.35-0.6, 0.95-1.3, 1.6-2.1.

**Parts.**

| Op | Arguments |
| --- | --- |
| `box` | w h d x y z colour [windows] [{ name, facade }]: w along x, h up, d along z; centred on x, z; **base at y** |
| `roof` | w h d x y z colour [alongZ] [{ name }]: a pitched prism with its base at y; ridge along x, or along z with `true` |
| `cyl` | rTop rBot h x y z colour [segments]: base at y |
| `cone` | r h x y z colour [segments]: base at y |
| `chimneyStack` | x y z h r [colour] |
| `door`, `garage`, `balcony`, `baywindow`, `porch`, `awning`, `cornice`, `dormer` | the facade helpers in the table above |

Windows: write `true` as the box's window class to get the kind's windows (homes: sashes, shops: a shopfront on the ground floor and sashes above, factories: strip windows high up). Only boxes with windows get windows; plain boxes are solid. One class is not a window: `fire` makes the whole box glow, faintly by day and fully from dusk, flickering on a phase of its own per building and per part (the pioneer camp's fire pit, lanterns and festoon bulbs, `camp.ts`). Two more are lights, not windows: `beacon`, a red aviation light that flashes on a period and phase of its own per building and per light, and `sign`, a lit logo or screen that comes on at a dusk time of its own per building (the broadcasters' masts and logos, `media.ts`).

Colours: `cream white pale stone brick grey dark slate terracotta glass glassDark corrugated rust chimney yellow navy red crossRed brown sand signBlue awning door steel plant roofGrey tan green silver charcoal timber mint boxBlue boxOrange boxGreen flare lawn lawnDark gravel pond hedge court gold marquee plum`, or a `0xRRGGBB` number.

**Facades.** Give every box with windows a facade and a name: `{ name: 'house', facade: { storeys, bays } }`. Choose `storeys` so a storey is 0.2-0.3 tiles tall (one tall storey of 0.3-0.4 for a factory hall) and `bays` so a cell is 0.12-0.2 tiles wide. Optional: `sideBays` (0 = blank sides), `ground` (`windows`, `door`, `shopfront`, `garage`, `plain`), `margin` (plain wall at each end of every wall), `top` (plain band at the top). Walls are `front` (+z), `right` (+x), `back` (−z), `left` (−x); bays count from 0 at the left as seen from outside; storeys from 0 at the ground.

**The rules.**

1. Every part rests on the ground or on the part below it: its `y` is exactly the top (`y + h`) of what it stands on. Nothing floats, nothing is buried.
2. Every part stays in the tile (walls within ±0.45, overhangs within ±0.5).
3. Never draw a door, window, glass panel, balcony, bay window, canopy, awning or band as a box on a wall with windows. Use `door`, `garage`, `balcony`, `baywindow`, `porch`, `awning` and `cornice`; they line up with the cells and never cover a window.
4. Anything built against a wall with windows (a wing, a shed, a garage, a turret, a carport) must cover whole cells or stand on plain wall. Keep that wall plain with `sideBays: 0`, `margin` or `top`, or move the part clear of the wall by at least 0.03.
5. Put the main door on the front wall. A shop's ground floor is a shopfront; give it an `awning`. A factory gets `garage` doors and a `door`.
6. A roof's base sits on the top of its box and overhangs it by no more than 0.04 a side. Chimneys stand on the roof or the box below it.
7. `balcony` needs storey 1 or higher. `porch` and `awning` sit on the first floor line, or the eaves of a one-storey box.
8. Check your work: `npm run buildings:check` must pass. It names any part that covers a window.
9. Part names are single words (`still-house`, not `still house`); a `dormer` needs its roof to carry `{ name }`.
10. Heights include caps: a `chimneyStack` adds about 0.07 above its `h`, a cornice at `storey = storeys` about 0.03.
11. `sideBays` blanks **both** side walls; a part within 0.03 of a windowed wall collides even in front of a garage cell, so keep props 0.04 clear.
12. Taste (from the review of the first 324 AI designs): use `brick` for brick walls and `slate` for dark roofs (`red`, `terracotta`, `navy` and `glassDark` read as saturated crimson or cobalt on walls); give every design its own silhouette, not box + awning + roof again; nothing on a roof may overhang its edge; `cyl` towers have no windows, so wrap them in windowed boxes or keep them small; vary dark industrial walls.
13. To check a scratch file before it joins the tree: `npx tsx packages/shared/scripts/check-drafts.ts <file>` (also catches floating parts and parts outside the tile).

**A house** (residential level 2):

```ts
{ kind: 'residential', level: 2, design: { name: 'brick semi with a bay and a balcony', height: 0.74, draft: true, author: '<your model id>', ops: [
  ['box', 0.56, 0.5, 0.5, 0, 0, 0, 'brick', true, { name: 'house', facade: { storeys: 2, bays: 3 } }],
  ['roof', 0.62, 0.22, 0.56, 0, 0.5, 0, 'slate'],
  ['door', 'house', 'front', 1],
  ['baywindow', 'house', 'front', 0, 0],
  ['balcony', 'house', 'front', 1, 2, 2],
  ['cornice', 'house', 1],
  ['box', 0.07, 0.16, 0.07, -0.18, 0.56, -0.12, 'chimney'],
] } },
```

**A shop** (commercial level 1): a shopfront under an awning, a flat above with its own door at the side.

```ts
{ kind: 'commercial', level: 1, design: { name: 'corner shop with a flat above', height: 0.56, draft: true, author: '<your model id>', ops: [
  ['box', 0.64, 0.48, 0.52, 0, 0, -0.06, 'cream', true, { name: 'shop', facade: { storeys: 2, bays: 3, sideBays: 2 } }],
  ['box', 0.68, 0.04, 0.56, 0, 0.48, -0.06, 'dark'],
  ['awning', 'shop', 'front', 0, 2, 'awning'],
  ['door', 'shop', 'right', 1, 'green'],
  ['cornice', 'shop', 1, 'green'],
  ['box', 0.12, 0.1, 0.12, 0.18, 0.52, -0.18, 'plant'],
] } },
```

**A factory** (industrial level 1): one tall storey, two loading doors and a door, a gatehouse office standing clear of the hall's wall.

```ts
{ kind: 'industrial', level: 1, design: { name: 'brick works with loading doors', height: 0.62, draft: true, author: '<your model id>', ops: [
  ['box', 0.76, 0.36, 0.6, 0, 0, -0.04, 'brick', true, { name: 'hall', facade: { storeys: 1, bays: 4, sideBays: 3 } }],
  ['roof', 0.8, 0.16, 0.64, 0, 0.36, -0.04, 'corrugated'],
  ['garage', 'hall', 'front', 1],
  ['garage', 'hall', 'front', 2],
  ['door', 'hall', 'front', 0],
  ['box', 0.2, 0.2, 0.16, 0.28, 0, 0.38, 'grey', 'office', { name: 'office', facade: { storeys: 1, bays: 2, sideBays: 1, ground: 'door' } }],
  ['chimneyStack', -0.26, 0.36, -0.2, 0.26, 0.05],
] } },
```

All three are in the catalogue as drafts by `docs example` (`designs/examples.ts`), so `/viewer.html` shows them and `buildings:check` keeps them valid.

## Multi-tile structures

A kind may cover several tiles by declaring a footprint:

```ts
footprint: { w: 2, h: 2, door: [0, 1] },
```

| Field | Meaning |
| --- | --- |
| `w`, `h` | Size in tiles, 1 to 8 each, before rotation: `w` along x, `h` along z (the depth back from the road) |
| `door` | The tile the simulation knows the building by, `[dx, dy]` from the back-left corner. It must be on the front row (`dy = h - 1`), because the front faces the road the door touches |
| `marks` | Optional. Significant parts drawn in the placement preview and on hover (below) |
| `wet`, `fairwayClearance` | Optional, harbours only (docs/boats.md section 5). `wet` is how many back rows stand over water (1 to h - 1); they must be open water on the player's land and the rest dry, so the last dry row is a quay. `fairwayClearance` (1 narrow, 2 river, 3 open) asks for 1, 3 or 5 rows of open water behind the whole back edge. `chunkView` draws water under the wet rows, and bulldozing leaves the water |

### Footprint marks

`marks` lists parts of the footprint worth showing: where vehicles or trains use it, where planes park, which edge is the platform. They are drawn as flat coloured strips over the footprint outline and turn with it. Coordinates are unrotated footprint coordinates: x from 0 to `w` across, y from 0 to `h`, with y = `h` the front (the road side).

```ts
footprint: { w: 8, h: 7, door: [4, 6], marks: [
  { kind: 'apron', at: { edge: 'back', depth: 4 }, label: 'apron' },       // a band four rows deep behind the building
  { kind: 'stand', at: [2, 2], label: 'stand 1' },                         // one tile
  { kind: 'gate', at: { edge: 'back' }, label: 'airside edge' },           // a line on the whole back edge
] },
```

| Field | Meaning |
| --- | --- |
| `kind` | `door`, `gate`, `platform`, `apron`, `stand`, `dock`, `quay` or `berth`; picks the colour (door green/red, gate orange, platform blue, apron grey, stand yellow, dock teal, quay pale stone, berth blue) |
| `at` | A tile `[dx, dy]`, or `{ edge: 'front' \| 'back' \| 'left' \| 'right', from?, to?, depth? }`: a strip along an edge. `from` and `to` are tile indexes along that edge, inclusive, default the whole edge. `depth` is how many tiles it reaches inward; leave it out for a thin line on the boundary |
| `label` | Short text shown on hover (in the preview every label shows; over a placed structure only the mark under the cursor) |

A `door` mark is added from `door` automatically (an arrow from the door tile towards the road: green when a road is in front, red when not), so only declare other kinds. `placedMarks(placed)` in `structures.ts` returns the marks turned into world tile space. Validation refuses an unknown kind, a tile or edge range outside the footprint, or a `depth` deeper than the footprint; `buildings:check` also turns every multi-tile kind through all four rotations and checks each mark stays on the footprint with the door mark on the door tile.

The model recipe is authored in tiles for the whole footprint: x runs from `-w/2` to `w/2`, z from `-h/2` to `h/2`, centred on x=0, z=0, with +z towards the road. A 2×2 hall's plinth is `['box', 1.96, 0.04, 1.96, 0, 0, 0, 'stone']`. The renderer places it unscaled at the footprint centre and turns it to face the road, so heights and details keep their meaning. `buildings:check` fails a recipe whose boxes, roofs, cylinders or cones reach outside the footprint.

The player clicks the door tile. Until they press Z or C the footprint rotates to face the road next to it; after that it keeps the orientation they chose (Z anticlockwise, C clockwise) and the door's outward neighbour must be a road. Either way it must fit on clear, buildable land they own. The simulation sees one building at the door, so capacity, wages, parking, shifts and the people panels come from the level numbers exactly as for a 1×1 kind. Only civic kinds are placed bigger than 1×1; zones grow bigger by merging lots (see "Merged lots"). How the tiles are stored and kept in step is in `docs/aux-layer.md`.

The worked example is `terminal.ts`: the airport terminal on kind code 15, 8×7 with the door on the middle of the front row. Its two designs (a glass hall with jet bridges, a regional terminal with boarding stairs) draw the apron and its gate stands in the back four rows, where the flight schedule parks planes. Open `/viewer.html` to see it on the turntable. In the city it needs the Aviation technology; with `?dev` on a dev server the tool is unlocked for testing. Pick **Airport terminal (8×7)** (key J) and click a tile beside a road. The runway that makes it an airport is painted, not a catalogue kind (docs/airport.md). The earlier draft 2×2 test hall that held code 15 was retired.

## Worked example: a news kiosk

The catalogue already contains this one as a draft, so it shows in the viewer but never in the city. It is a new commercial level-1 design added with data only.

1. Open `packages/shared/src/buildings/commercial.ts` and add a design to the level-1 `designs` array:

   ```ts
   { name: 'news kiosk with a striped canopy', height: 0.34, draft: true,
     attrs: { commerceType: 'kiosk', openHours: [6, 20], visitorCapacity: 2 }, ops: [
       ['box', 0.9, 0.02, 0.9, 0, 0, 0, 'stone'],                 // paved forecourt
       ['box', 0.3, 0.24, 0.24, -0.12, 0.02, -0.08, 'green', true], // the booth, with shop windows
       ['box', 0.34, 0.03, 0.28, -0.12, 0.26, -0.08, 'dark'],     // roof slab
       ...repeat(4, (i) => ['box', 0.085, 0.02, 0.14, -0.248 + i * 0.085, 0.22, 0.1, i % 2 ? 'cream' : 'green']),
       ['box', 0.26, 0.07, 0.02, -0.12, 0.27, 0.075, 'yellow'],  // sign
       ['box', 0.12, 0.12, 0.06, 0.16, 0.02, 0.12, 'signBlue'],  // newspaper stand
       ['box', 0.1, 0.02, 0.07, 0.16, 0.14, 0.12, 'white'],
       ['cyl', 0.012, 0.012, 0.18, 0.3, 0.02, -0.2, 'steel', 5], // post with a red board
       ['box', 0.1, 0.12, 0.02, 0.3, 0.2, -0.2, 'red'],
   ] },
   ```

2. Save. With `npm run dev` running, the Vite plugin recompiles and `/viewer.html` reloads. Open `http://<lan-ip>:5173/viewer.html#d=2:1:4` to see it on the turntable, at night with lit windows, and with its attributes. Without the dev server, run `npm run buildings:compile`.
3. Run `npm run buildings:check`. The snapshot models stay as recorded (50 byte-identical to the pre-catalogue models, 5 re-snapshotted after facade fixes) and the draft is reported as viewer-only.
4. When it looks right, delete `draft: true`. Commercial level 1 then has five live designs. Tiles pick by hash, so about a fifth of level-1 commercial tiles show the kiosk and some of the rest swap to a different existing design. Run `npm run buildings:check` again: the existing models are still byte-identical, since only the pick changes.

A new level works the same way: append a `LevelDef` and set `feature` to the tech feature that gates it.

A new kind needs a family code and, when its code already has a base kind, a free `kindId` from 16 (docs/sub-kinds.md); then a family file entry in `catalogue.ts`, and a `tool` if players should place or zone it. The tool appears in the tool list, gets its shortcut key, and is accepted by the server through the tool maps, with no engine edits. A kind whose behaviour is new, such as a leisure venue that citizens visit, still needs simulation code for that behaviour. Two spots are not data yet. The parking tool keeps one special case in `net.ts`, because a lot is painted and paved at once instead of built by builders. The building panel's colour swatch comes from the kind's tool colour in the manifest.

## Validation

`buildings:compile` refuses to write output when any of these hold:

- A required field is missing: id, name, code, family, flags, windows, levels, designs, capacity, work, parking, `wage` on a workplace, `cost` on a placed kind, `upkeep` on civic and parking kinds, an occupation on a workplace, or a family's required attributes.
- An id, kind id, tool id or tool key is used twice, two base kinds share a code, or a tool key is reserved: 1, 2, 3, X, Z or C (Z and C turn a footprint being placed).
- A kind code is outside 1 to 15, a sub-kind's `kindId` is outside 16 to 255, a sub-kind's family code has no base kind, or a kind has more than 7 levels.
- A recipe uses an unknown op, the wrong number of arguments, a non-number, an unknown palette name or an unknown window class, or a facade or feature mistake ("Facades").
- A level `feature` that no tech node unlocks, or a level whose designs are all drafts.
- A footprint edge outside 1 to 8, a door off the front row, or a footprint bigger than 1×1 on a kind that is neither civic nor a growable sub-kind. A car park bigger than one tile is civic and built by builders; the painted surface lot stays 1×1. A growable kind bigger than 1×1 (a merged lot) must be a sub-kind with no tool: the zone's base kind stays 1×1 so zoning stays per tile.
- A `minLevel` outside 1 to 7, on a kind that is not growable, or with more levels than fit below 7.
- A ladder mistake: an unknown `group`, tiers that do not run 1..n, rungs of one group on different family codes, a rung without a tool, `blurb` or `howTo`, two shortcut keys in one group, or a tier attribute out of range. A ladder whose every rung is a draft is a mistake too, unless its group sets `draft: true` in `groups.ts` (the Underground ladder does until U8 undrafts its rungs).

**The showcase.** A new kind or feature lands with its showcase placement and tour stop, or `npm run demo:check` fails. A landmark goes in its own city's demo instead. See docs/demo.md, "Keeping it complete".

## Groups and tiers

A building family can come in sizes. Kinds with the same `group` form a **ladder**; `tier` orders them, smallest first. The tool bar shows each ladder once (Health, Police, Fire, Builders, Parking, Parks, Cinemas, Theatres, Sport, Libraries, and Education while it is a draft). Choosing it, or pressing the family's old key (0 health, 8 police, 9 fire, Y builders, P parking, G parks, V theatres, B sport, L libraries), opens a size picker beside the tool bar: one card per rung with a snapshot, the footprint, what it holds, its coverage, pace or reach, the cost, the upkeep, the build work and the technology it needs. Locked rungs are greyed and name the tier that opens them. Picking a card makes that rung's kind the active tool, so placement, Z/C rotation and the footprint preview work as for any building, and the picker remembers the last size per ladder in the browser.

| Ladder | Rungs (footprint) |
| --- | --- |
| Health | GP surgery (1×1) · health centre (2×1) · walk-in centre (2×2) · hospital (1×1, the original) · community hospital (3×2) · general hospital with a helipad (3×4) · teaching hospital (4×4) |
| Police | police box (1×1) · neighbourhood post (1×1) · police station (the original) · divisional station with a car pound (2×2) · police headquarters with a radio mast and training yard (3×3) |
| Fire | fire post (1×1) · fire station (the original) · large station with a drill tower (2×2) · fire and rescue headquarters (3×3) |
| Builders | handyman's workshop (1×1) · builders' yard (the original) · builders' depot with a crane and lorries (2×2) · construction company with a batching plant (3×2) |
| Parking | kerbside bays (1×1) · parking lot (the original, painted) · multi-storey (2×2, four decks) · park and ride (3×3) |
| Parks | park (1×1, the original three levels) · lakeside park (3×3) · botanical garden (4×4) |
| Cinemas | café cinema (1×1) · cinema (the original) · multiplex (2×2) |
| Theatres | studio theatre (1×1) · theatre (the original) · opera house (3×3) |
| Sport | sports hall (the original) · leisure centre with a pool (2×2) · arena (3×3) · stadium with floodlights (4×4) |
| Libraries | library (the original) · central library (2×2) · museum (3×2) |
| Media | local TV studio (1×1) · broadcast centre (2×2) · media centre with a news helipad and a dish array (3×2): placed sub-kinds of the office family, kind ids 130-132 (`media.ts`, docs/media.md) |
| Cemeteries | churchyard (2×2) · municipal cemetery (3×3) · garden cemetery (4×4) · crematorium (3×2): park-family leisure places of low appeal (quiet green space), each design with its plot layout; a `stages` ladder, as the crematorium is smaller and cheaper than the garden cemetery (`remembrance.ts`, docs/remembrance.md). The funeral director (1×1) has its own tool |
| Power grid | substation (1×1) · grid supply point (2×2) · power depot (2×1): stages of the power network, kind ids 160-162 (`utilities.ts`, docs/utilities.md) |
| Power stations | wind turbine (1×1) · solar farm (2×2) · gas power station (3×3) · coal power station (4×4): kind ids 163-166 |
| Education (draft) | nursery (1×1) · primary school (2×2) · secondary school (3×3) · sixth-form college (2×2) · FE college (3×2) · university campus (6×6) · research institute (3×3) · halls of residence (2×2). A ladder of stages, not of sizes (see below) |
| Harbours (draft) | jetty (1×2) · ferry pier (2×2) · marina (4×4) · fishing harbour (4×3) · cargo port (8×6), each with its back rows over water (docs/boats.md section 5) |

Every rung of a ladder shares its family code, so the simulation treats it as part of the same service: a GP surgery takes doctor's visits and counts as hospital cover, a police box sends patrols, a handyman's builders look for sites. What changes per rung is data:

| Number | Where | Read by |
| --- | --- | --- |
| staff, wage, cost, upkeep, build work, parking | the level, as for any kind | the tables; a site's work is the rung's `work` (net.ts) |
| `serviceRadius`, `serviceStrength` | attributes | coverage: per family the strongest staffed station that reaches a home counts (a police box is 0.4, an HQ 1.5), summed; happiness reads the whole part, growth and tax tolerance all of it |
| `patrolRate` | attributes | patrols, fire call-outs and ambulances per hour, × a station's |
| `workRate` | attributes | work per builder per tick, × a yard crew's (`Citizen.kind` is the builder's workplace) |
| `visitorCapacity`, `radius`, `leisureValue`, `eventSize` | attributes | leisure: how many it holds, which homes count it, and how much harder an event night pulls (shared/src/leisure.ts) |

`shared/src/tiers.ts` turns these into flat arrays by kind id (`SERVICE_RADIUS_OF`, `SERVICE_STRENGTH_OF`, `PATROL_RATE_OF`, `WORK_RATE_OF`) and lists the ladders (`LADDERS`, `ladderOf`, `tierSummary`). Kinds without the attributes get the pre-tier values (SERVICE_RADIUS, 1, 1, 1), so the original kinds behave exactly as before and the snapshot is unchanged. Each new rung has its own tech feature (its tool id): small rungs come with the original kind's node, bigger ones need Steel frame, Regional services, Metropolitan services, Medical school, Industrialised building, Big nights out or Landmarks. The handyman and the park need nothing.

**Stage ladders.** The Education group sets `stages: true` (`groups.ts`): its tiers run in the order a pupil moves up (nursery 1 … halls 8), so what a rung holds and what it costs may drop from one rung to the next (a sixth form is smaller than the secondary school below it). `buildings:check` skips the "never shrinks" checks of holds and cost for it and keeps the rest (one family code, build work growing with the footprint, every rung placing in all four rotations, a tech node per rung). Its picker count is the `pupilCapacity` attribute (`tierSummary`, `holds: 'pupils'`). The education kinds are civic sub-kinds of the library family (code 14) with no `service` flag, so coverage, happiness and tax tolerance never read them, and no `leisureAt` spec exists for them, so the leisure loops pass them by. Their attributes are `stage` (the number a citizen's `study` field holds), `pupilCapacity`, `eveningPlaces`, `catchment` (tiles by road, 0 = the whole city), `ages`, `teachersShare`, `postgradShare` and `beds` (docs/education.md). They are drafts: the tools show only with `?dev`.

To add a rung: give a kind in the right family code a free `kindId`, `group`, the next `tier`, a tool with no key, `blurb`, `howTo`, its numbers and tier attributes, and at least two designs; list it in `catalogue.ts` and add its tool id to a tech node's `unlocks`. `npm run buildings:check` ("groups and tiers") checks the original kinds stay one rung each with the default numbers, that tiers run 1..n on one family code, that what a rung holds, its cost, coverage, patrols, pace, reach and event pull never shrink up the ladder, that build work grows with the footprint, that every rung places (multi-tile ones in all four rotations) and that every new rung has a tech node. `/viewer.html` groups by ladder (**Group by: Ladders**), shows a ladder table in the spec sheet, and **Ladder line-up** puts every size on the turntable side by side.

## Merged lots

Zoned lots are 1×1 and grow to level 3 on their own tile. From level 1 a growing building may instead **merge** with neighbouring lots of its zone and owner into a bigger kind, and those climb to level 7. They are sub-kinds of the zone's family code (ids 70-89, docs/sub-kinds.md; 86-89 are the deep plots of "Block interiors"), growable, with a footprint and a `minLevel`, and no tool: nobody places them. `shared/src/zones.ts` lists them per family (`GROW_FORMS`) for the growth step, and gives `firstLevelOf`, `topLevelOf`, `isMergedKind`, `venueCapacityOf` and `pollutionOf`.

| Zone | Kind (id) | Footprint | Levels | Holds (per level) | Designs |
| --- | --- | --- | --- | --- | --- |
| Residential | terrace row (70) | 2×1 | 2-3 | 18, 26 residents | four brick houses, a semi-detached pair, a mews; a Georgian terrace, modern townhouses |
| | mid-rise apartments (71) | 2×2 | 4 | 64 | courtyard block with an arched gateway, stepped mid-rise with a roof garden |
| | perimeter block (72) | 3×2 | 5 | 114 | stone block round a court with a corner turret, brick mansion block with bays |
| | residential tower (73) | 2×2 | 6-7 | 96, 120 | slab tower, twin-core tower; slender glass tower, stepped tower with sky gardens |
| | tower estate (74) | 3×3 | 6-7 | 216, 270 | two towers on a podium, a crescent round a park; three towers, a tower with a pool deck |
| Commercial | high-street parade (75) | 2×1 | 2-3 | 14, 20 jobs | four shopfronts, a pub and bakery; a clock-turret block, a glazed arcade |
| | department store (76) | 2×2 | 4-5 | 44, 52 | rotunda store, supermarket with a car park; atrium store, fashion house |
| | shopping centre (77) | 3×3 | 5-6 | 100, 120 | mall with anchors and a car park, retail park; mall with a deck and a tower, domed centre |
| | hotel tower (78) | 2×2 | 6-7 | 60, 72 | porte-cochère hotel, art-deco hotel; glass tower with a sky bar, sail-shaped resort (hotel workers on three shifts) |
| Office | business centre (79) | 2×1 | 2-3 | 36, 52 | glass entrance hall, converted warehouse; glass pair, columned chambers |
| | office tower (80) | 2×2 | 4-5 | 112, 136 | glass tower on a podium, stepped stone tower; twin towers with a bridge, diagrid tower |
| | corporate headquarters (81) | 3×3 | 6-7 | 310, 360 | campus round a lake, a ring with a helipad tower (6); two supertalls (7) |
| Industrial | workshop row (82) | 2×1 | 2-3 | 26, 38 | roller-door workshops, a brick yard; light-industrial units, a bottling works |
| | distribution centre (83) | 2×2 | 3-4 | 76, 92 | warehouse with docks, a cold store; a truck-yard depot, a high-bay warehouse with a gantry |
| | factory complex (84) | 3×3 | 5 | 210 | sawtooth halls with stacks and tanks, a car plant with a test track |
| | heavy plant (85) | 4×4 | 6-7 | 380, 420 | steelworks, chemical plant (pollution 8); power station, refinery (pollution 9) |

Numbers follow two rules that `buildings:check` ("merged lots") enforces. Capacity per tile at a level is never below anything of the family at a lower level, so a merge can always hold everyone it takes in. Build work is 60 × level × tiles × 0.6. Parking, wages and `visitorCapacity` (read by the simulation through `venueCapacityOf`, so a store hosts far more café and shop visitors than a corner shop) are set per kind and level. Every level has at least two designs.

**The merge rule** (`growth`, `planMerge` and `mergeOccupants` in `server/src/sim/simulation.ts`):

- A growable building beside a road, mostly occupied (70%), wins the usual demand roll. When its kind can still grow in place, it tries a merge first half the time; at its kind's top level it always looks.
- The merged kind must be at least as big as the building's own footprint (and a different kind). Its level is one up from the building's, or the kind's first level, at most two up. The owner needs the level's technology. Residential level 3 and up wants a service nearby, as before.
- **Ambition**: a hash of the building's 7×7-tile neighbourhood makes it low-rise (up to level 3), mid-rise (5) or high-rise (7), and a per-lot hash nudges that a level either way. Merges and in-place upgrades of merged kinds stop there, so streets mix sizes and not every block turns into towers.
- Kinds, quarter turns and offsets of the footprint around the building are tried from hash-seeded starting points, so neighbouring lots choose different shapes. A placement fits when its door faces a road and every tile is a lot of the same zone and owner that is empty or no taller than the building: a 1×1 lot, or a smaller merged building lying wholly inside. No tile may be a road, water, a site or part of another merge planned in the same pass. The new kind must hold everyone already living or working there. The footprint then goes through the shared placement rule (`planStructure`), with the merged lots seen as empty lots.
- `World.mergeLots` writes the structure (aux bytes, sub byte and family code on every tile) and opens one site at the door for the whole footprint, marked `merge`. In the same step everyone who lived or worked in the merged buildings moves to the new door, along with their parked cars. The site keeps them on through construction (`syncBuilding` does not evict at a merge site), and when it completes the building holds them all. `World.mergeStats.evicted` counts anyone it could not take; the capacity rule keeps that at zero.
- Bounded work: the demand roll comes first; at most 24 merge searches and 8 merges per growth pass; one pass over the citizens per growth pass, whatever the number of merges; at most two merges being built at once per parcel.
- A merged building upgrades in place to its kind's top level like any zone, using the kind's build work. One that loses its road shrinks a level now and then, and below its first level it falls back into empty lots.

**Bulldozing** any tile of a merged building breaks it back into empty lots of its zone (`World.removeStructure`), evicting its people as bulldozing a home does. **Tech**: Masonry opens level 2, Steel frame level 3, and the new High-rise node (construction tier 5, after Deep foundations) opens levels 4-7. **Elsewhere**: a merged works sends freight in proportion to its jobs (a 1×1 lot's level); a merged home takes newcomers one chance per dozen beds; `/viewer.html` shows each merged kind with its footprint and levels.

## Block interiors

A block between roads is typically 4×4 tiles: the twelve edge tiles have frontage and grow buildings, the 2×2 in the middle has none, and lots grow only beside a road. `shared/src/buildings/block-interior.ts` holds the kinds that use the middle and `server/src/sim/blocks.ts` the rules.

| Kind (id) | Footprint | Levels | Holds (per level) | Designs |
| --- | --- | --- | --- | --- |
| deep-plot house (86) | 1×2 | 2-4 | 18, 26, 32 residents | house with a back wing, backland cottage; townhouse round a light well, mansion flats with a roof garden; mansion block round a garden court, apartments with side balconies |
| deep-plot shop (87) | 1×2 | 2-4 | 14, 20, 22 jobs | shop with a stockroom and loading bay, pub with a beer garden; market hall, small supermarket with a service yard; store with a top-lit hall, glass arcade |
| deep-plot office (88) | 1×2 | 2-4 | 36, 52, 56 | office with an annexe, front office with a coach house; atrium office, chambers with a glass rear block; slab on a stone base, converted mill |
| deep-plot works (89) | 1×2 | 2-4 | 26, 38, 46 | workshop with a fenced yard, garage with a spray shop; sawtooth works with a gantry, bakery with silos; crane-bay works, cold store |
| communal garden (90) | 2×2 | 1 | - | orchard lawn with a shed, allotments with a greenhouse, play garden, pergola and lily pond |

**Deep plots** are merged lots (see "Merged lots", ids 70-89) one tile wide and two deep, so their front faces the road and their back reaches into the middle. Levels 2-3 have the numbers of the family's 2×1 form and level 4 half those of its 2×2 form, which keeps the merged-lot rules (capacity per tile, build work, tech gates). `GrowForm.deep` marks them, and `planMerge` accepts one only when every tile behind the door is landlocked (no road on any side, `deepBackOk`): a deep plot never takes a lot with frontage of its own. As with every merge, the tiles must be lots of the building's zone and owner, so **an interior lot is built on only by the owner of the building beside it**, and access is that building's door. Bigger merges (a perimeter block, a shopping centre, a works, a heavy plant) take landlocked lots too.

**Interior zoning.** Zoning a stroke also zones the bare landlocked tiles beside it that the player owns when every zoned neighbour of such a tile is the stroke's zone and there are at least two of them (`interiorLots`; ZONE_COST each, with a toast). Zoning the four sides of a block therefore readies its middle. A mixed block's middle stays bare. Residential middles of garden blocks (below) are left bare.

**Communal gardens.** A garden block is a 2×2 middle of empty land (bare, or empty residential lots) whose twelve-tile ring is all residential. Every growth pass (`plantGardens`, sim tick offset 19) looks beside each built home for such a middle and plants it with chance 0.35 when:

- every ring tile is a built home (level 1 or more), and
- **land rule:** the four middle tiles belong to one owner who also owns at least one of the homes round it. The garden stays that owner's land; it is planted complete, costs nothing and has no upkeep. Unowned land is never planted.

The garden is a 2×2 park-family structure (civic, no tool, never placed by a player) whose quarter turn is hash-seeded per block, and its design is the anchor's hash pick, so neighbouring blocks differ. Its leisure spec has `blockOnly`: `leisureCoverage` counts it (leisure value 3, a small park) only for homes whose door is on its ring, so it lifts those homes' leisure coverage, their daily leisure top-up and the "park nearby" happiness part, and nobody else's. `pickLeisure` never sends anyone there (no road reaches it). The tooltip shows how many residents and homes share it. Deep plots never grow into a garden block's middle; a merge that takes in the whole garden (a 3×3 tower estate) may, and a garden is bulldozed like any structure (the residents plant it again while the block still qualifies). A mixed or non-residential block's empty middle stays empty.

**Seeded towns.** `seedCommons`, `seedCity` (test cities and the demos' grid town) and the demos' rezoned blocks pre-build every tile of a block, the middle included. `settleInteriors` then settles each landlocked middle by the same rules: emptied, planted as a garden when the homes round it stand, else taken into deep plots from the frontage at the seed level (2-4; below 2 the lots stay empty for growth). It uses hashes only, so a demo seeds the same town twice. No seeded door is left without a road (`demo:check` used to note 548-568 in the grid town). A built=3 district now has 1,228 beds instead of 1,248.

Nothing new is persisted: the kinds live in the sub layer like every merged lot, so older saves load unchanged.

## Landmarks

**Contributing a landmark?** `docs/landmarks.md` is the self-contained brief (scale, footprints, every op, the viewer, the checks, the review rubric); new landmarks start as drafts in `landmark-drafts.ts` (kind ids 230-249, viewer only, `npm run landmarks:check`). This section describes the London set.

A **landmark** is a recognisable real building: the Gherkin, the Shard, Big Ben. Each is an ordinary placed civic kind (a site, builders, staff, upkeep) that works as an existing role, so the simulation needs nothing new: the towers are office-family kinds (family code 4: office jobs, office visitors and the office car-ownership rate), the Royal Opera House a theatre-family venue (code 12, with the theatre attributes and its own event nights). What makes it a landmark is metadata on the kind:

| Field | Meaning |
| --- | --- |
| `landmark: true` | Validation then requires the civic flag, a tool, at least one tag, a rung of a `collection` group and a tool unlocked only by a `locked` tech node |
| `tags: ['london']` | Lower-case labels, copied to the manifest. `/viewer.html?tag=london` (or the Tag row) shows only those kinds; any code can list a city's kinds with `MANIFEST.filter((k) => k.tags?.includes('london'))` |
| `group: 'london'`, `tier` | A rung of the London collection (`groups.ts`, `collection: true`): the tool bar shows one **London** button in a **Landmarks** section, and its picker lists the buildings in tier order. A collection is not a size ladder: rungs may be any family, and the never-shrinks checks skip it |

**Unlocking: to be decided.** Every landmark tool is unlocked by the tech node `lnd1` "London landmarks" (`tech.ts`), which is `locked`: the tech tree shows it with the text "How these unlock is still to be decided", it cannot be earned, and the server refuses to buy it. So a live game never places a landmark. Sandboxes (test cities and demos: `GameConfig.sandbox` gives every player `ALL_TECH_IDS`), the Commons, the dev "unlock everything" action and a `?dev` client on a dev server (which skips tech locks) can. When the real rule is decided (a population, a district's jobs, a scenario goal), give `lnd1` a condition and drop `locked`, or split it into one node per landmark.

**Kind ids.** London uses 91-100: 91 the Gherkin, 92 the Shard, 93 the Walkie Talkie, 94 One Canada Square, 95 the Royal Opera House (`landmarks-london.ts`); 96 Big Ben and the Houses of Parliament (`bigben`: government offices), 97 the London Eye (`londoneye`: a sports-family venue, rides day and evening), 98 the Tower of London (`toweroflondon`), 99 Buckingham Palace (`buckingham`) and 100 Tower Bridge (`towerbridge`), the last three daytime attractions of the library family with a ticket (`landmarks-london-2.ts`, appended to `LONDON_LANDMARKS`); collection tiers 1-10 in id order. Footprints stay within 4×4 so each fits among the London demo's streets, which are laid round them (docs/demo.md "London"; the Tower is 4×3, Tower Bridge 1×4). **The universities** are 111-114 (`landmarks-london-3.ts`, collection tiers 11-14): UCL's Wilkins Building (`ucl`, 4×3), Imperial's Queen's Tower (`imperial`, 3×3), King's Strand building (`kings`, 4×3) and the LSE's Centre Building (`lse`, 3×3), each a civic family-14 kind that works as a university rung (the `stage`, `pupilCapacity`, `ages`, `teachersShare` and `postgradShare` attributes of docs/education.md, so `shared/src/education.ts` reads them as it reads kinds 101-108), unlocked by the locked node `lnd2` "London universities" as the others are by `lnd1`. Group tiers may now run to 16 (`validate.ts`; it was 12). **Piccadilly Circus** is 116 (`landmarks-london-4.ts`, collection tier 15, tool `piccadilly` in `lnd1`): a theatre-family venue (the Criterion Theatre, four event nights a week) whose London Pavilion corner carries six big screens, the Piccadilly Lights (docs/adverts.md section 9). The generic **big screens corner** (117, `bigscreens.ts`) is not a landmark: it is the cinema ladder's fourth rung, unlocked with Landmarks (`cul5`), and stands in the showcase.

**Moving parts.** A recipe stands still, so what moves or lights up is drawn by the client in `render/landmarks.ts` from constants the recipe file exports (`LONDON_EYE`, `BIG_BEN`, `TOWER_BRIDGE`), placed as chunkView places the structure: the Eye's wheel and 32 capsules turn (one turn in 3 game hours, only while open, capsules hanging level; rim lights by night, mostly blue and white, a show colour now and then); Big Ben's four dials light at dusk and show the game's time; Tower Bridge's bascules rise a few times a day for a red-sailed Thames barge (shown only where water lies either side). Everything follows the game clock, so every client sees the same; each instance hashes its own phase, opening hours, light colours and lift times. The building viewer shows the same parts on the turntable. `msc.landmarks.fixedHours = h` pins the time they show, for screenshots.

**Tower Bridge.** In the London demo it is a real road crossing: a bascule-style bridge (shared/src/bridges.ts, docs/structures.md section 3) laid by the scenario's `bridges` entry, drawn as this kind's model centred on the span (chunkView) with its leaves and barge (render/landmarks.ts), and driven at its deck height; barriers on its approaches stop the traffic for every lift (shared/src/bridges.ts basculeLiftAt, the schedule the leaves keep). A bridge's `landmark` counts as placed for the landmark rule below. Placed with its own tool it is still a structure on its own dry tiles whose deck carries no traffic.

**Scale.** About 33 m to a tile: the Shard (310 m) is the tallest thing in London at 9.6 tiles, One Canada Square 7.2, the Gherkin 5.5, the Walkie Talkie 5 (the merged supertall is 8). A landmark has one design (it is one building, not a type; `buildings:check` waives the two-designs rule for landmarks), and the window lighting still varies per instance. Curved and faceted shapes use the `taper` and `lathe` ops.

**Checks.** `buildings:check` places every landmark in all four rotations through the civic tool and keeps its model inside the footprint; `demo:check` fails a landmark that stands in no city demo (`showcaseProblems`: landmarks belong in their city, not the showcase).

**World landmarks.** The same recipe style covers ten more cities, each one collection group and one kind-id block, composed by `landmarks-world.ts` from the per-city files: New York 121-128 (`landmarks-new-york.ts`: the Empire State Building, the Chrysler Building, the Statue of Liberty, One World Trade Center, the Brooklyn Bridge, the Flatiron, Rockefeller Center, Radio City); Paris 133-138 (the Eiffel Tower, the Arc de Triomphe, Notre-Dame, the Louvre, the Opera Garnier, Sacre-Coeur); Rome 141-146 (the Colosseum, St Peter's, the Pantheon, the Trevi Fountain, the Altare della Patria, Castel Sant'Angelo); Cairo 155-159 (the Great Pyramid, the Sphinx, the Pyramid of Khafre, the Cairo Tower, the Mosque of Sultan Hassan); Dubai 167-171 (the Burj Khalifa, the Burj al Arab, the Dubai Frame, the Museum of the Future, the Jumeirah Mosque); Shanghai 172-176 (the Oriental Pearl Tower, the Shanghai Tower, the Jin Mao, the World Financial Center, the Yu Garden); Beijing 177-182 (the Forbidden City, the Temple of Heaven, the Great Wall, Tiananmen, the CCTV Headquarters, the Summer Palace); Rio de Janeiro 183-187 (Christ the Redeemer, Sugarloaf, the cathedral, the Maracana, the Sambadrome); Sydney 188-191 (the Opera House, the Harbour Bridge, Sydney Tower, St Mary's); San Francisco 192-196 (the Golden Gate Bridge, the Transamerica Pyramid, Coit Tower, the Ferry Building, Alcatraz); Barcelona 197-200 (the Sagrada Familia, Casa Batllo, Camp Nou, Torre Glories); Kuala Lumpur 201-204 (the Petronas Towers, the KL Tower, Merdeka 118, the Batu Caves); Toronto 205-208 (the CN Tower, Casa Loma, the Royal Ontario Museum, Old City Hall); Seattle 209-212 (the Space Needle, Pike Place Market, the Columbia Center, the Smith Tower); Agra 213-216 (the Taj Mahal, the Agra Fort, Fatehpur Sikri, the Itimad-ud-Daulah). Each is tagged `world` and its city, a rung of a collection group named for the city (one tool-bar button per city in the Landmarks section), and every tool is unlocked by the locked tech node `wld1` "World landmarks" exactly as London's are by `lnd1`: they stand only in sandboxes and `?dev` clients until the unlock rule is decided. None of their cities has a demo yet, so `demo:check` exempts them by `LONDON_EXEMPT` with that reason (london-kinds.ts). Like London's, each works as an existing role — office towers, theatre venues, library-family attractions, stadiums — with one fixed design per kind; unlike London's, none has moving parts yet (render/landmarks.ts). Every world-landmark design is authored by `kimi-2.8-preview` (the design `author` field, filterable in the viewer), except the Paris set, which also carries a `claude-haiku-5-5` design per building (`landmarks-paris-haiku.ts`, marked `draft` so the city never places it), for comparison against kimi's. Paris, New York and San Francisco also carry a `claude-fable-5-1` draft design per building (`landmarks-paris-fable.ts`, `landmarks-new-york-fable.ts`, `landmarks-san-francisco-fable.ts`), wired into each kind's `designs` the same way, so those three cities compare kimi's eye against Fable's on every landmark. To compare models, `/compare.html` lays the authors across the top against the buildings down the side, one rendered cell per design.

## More than 16 kinds

The tile stores the kind in 4 bits, and all sixteen values are taken. Past that, a kind is a **sub-kind**: it shares a family code with that family's base kind and has a kind id of its own from 16 to 255, stored in the per-chunk sub layer (one byte per tile, persisted and streamed like the aux layer). A tile with sub byte 0 is its family's base kind, and base kinds' ids equal their codes, so every existing tile keeps its meaning and no tile word changes. The compiled tables are indexed by kind id. The scheme, the API and why it beat packing into the aux byte or a server-side record are in `docs/sub-kinds.md`. The first sub-kind is the draft bus depot (id 16, family code 15 beside the airport terminal): `/viewer.html` shows it, and with `?dev` on a dev server the **Bus depot (3×2)** tool (key K) places it.

## The wind turbine's rotor (card c3a3e2b3)

The kit's `turbine` helper (`buildings/utilities.ts`) now builds only the tower: a foot, a tapered tower with a red band, a
door, a service platform and an aviation light in the `beacon` class. The nacelle, hub and blades that used to be stepped
boxes are drawn and turned by the client's rotor pass (`render/rotors.ts`, docs/utilities.md 4.5). Where a tower stands and
how tall it is live in `shared/src/rotors.ts` (`TURBINE_TOWERS`), which the kit and the pass both read; the pass finds a
turbine by its design key (`165:1:0`, `165:1:1`, `ROTOR_MOUNTS`), so a new turbine design adds its tower there.

