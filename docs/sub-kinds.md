# Sub-kinds: more than 16 building kinds

The tile word keeps a building's kind in 4 bits, and all 16 values are taken (0 none, 1-4 the zones, 5-8 police, fire, hospital and yard, 9 parking, 10-14 leisure, 15 the airport terminal). Gateways, a stadium, landmarks, utilities and incidents all need more kinds. Sub-kinds give every building a **kind id** of its own, from the catalogue, while the 4 bits become a coarse **family code** that fast paths keep using.

Code: `shared/src/tile.ts` (`kindIdOf`, `familyOf`, `subFor` and the id-indexed lookups), `shared/src/buildings/compile.ts` (the id-indexed tables), `server/src/world.ts` (the sub layer, `Building.id`, `kindIdAt`), `server/src/store.ts` (format v6), `server/src/net.ts` (wire and placement), `client/src/world.ts` (mirror). The worked example is the draft bus depot in `shared/src/buildings/transport.ts`.

## The rule

A fourth per-chunk byte layer, the **sub layer**, sits beside the tile words, the parcel ids and the aux layer. One byte per tile, 1 KB per chunk.

```ts
kindIdOf(code, sub) = sub !== 0 && KIND_FAMILY_TABLE[sub] === code ? sub : FAMILY_BASE_TABLE[code]
```

- Every family code has one **base kind**, and the base kind's id **equals its code**. A tile with sub byte 0 is its family's base kind.
- Every tile written before sub-kinds existed has sub byte 0, so it means exactly what it meant. No tile word is migrated.
- A **sub-kind** shares a family code with its base and takes an id from 16 to 255. Placing one writes the family code into the tile word and the id into the sub byte.
- A sub byte that names a kind of a different family is ignored: the tile reads as its own family's base kind. A stale byte can never turn a shop into a bus depot.

Because base ids equal codes, everything already stored by kind code stays valid: `Citizen.kind`, `Site.kind`, `ParcelStats.jobsByKind`, `OCCUPATIONS`, `CIVIC_COST`, `KIND_NAMES` and the recipe keys were indexed by code and are now indexed by id with the same numbers.

## Kind ids and family codes

| Kind id | Kind | Family code |
| --- | --- | --- |
| 1-4 | residential, commercial, industrial, office | 1-4 (zones) |
| 5-8 | police station, fire station, hospital, builders' yard | 5-8 |
| 9 | parking lot | 9 |
| 10-14 | park, cinema, theatre, sports hall, library | 10-14 (leisure) |
| 15 | airport terminal | 15 (transport hubs, `Zone.Hub`) |
| 16 | bus depot | 15 |
| 17 | bus stop (docs/transit.md) | 15 |
| 18 | rail halt (docs/rail.md) | 15 |
| 19 | rail station (docs/rail.md) | 15 |
| 40-45 | GP surgery, health centre, walk-in centre, community hospital, general hospital, teaching hospital (size ladders, docs/buildings.md) | 7 |
| 46-49 | police box, neighbourhood police post, divisional police station, police headquarters | 5 |
| 50-52 | fire post, large fire station, fire and rescue headquarters | 6 |
| 53-55 | handyman's workshop, builders' depot, construction company | 8 |
| 56-58 | kerbside bays, multi-storey car park, park and ride | 9 |
| 59-60 | lakeside park, botanical garden | 10 |
| 61-62 | café cinema, multiplex | 11 |
| 63-64 | studio theatre, opera house | 12 |
| 65-67 | leisure centre, arena, stadium | 13 |
| 68-69 | central library, museum | 14 |
| 20 | freight yard (docs/rail.md) | 15 |
| 21 | motorway connection (README "Gateways") | 15 |
| 22 | metro entrance, a 1×1 stair kiosk (docs/underground.md) | 15 |
| 23 | metro station, a 2×1 hall (docs/underground.md) | 15 |
| 24-28 | jetty, marina, fishing harbour, ferry pier, cargo port: harbours with their back rows over water (docs/boats.md section 5) | 15 |
| 101-108 | nursery, primary school, secondary school, sixth-form college, further-education college, university campus (6×6), research institute, halls of residence: the education ladder, drafts until the Showcase places them (docs/education.md section 3) | 14 |
| 70-74 | terrace row, mid-rise apartments, perimeter block, residential tower, tower estate (merged lots, docs/buildings.md) | 1 |
| 75-78 | high-street parade, department store, shopping centre, hotel tower | 2 |
| 79-81 | business centre, office tower, corporate headquarters | 4 |
| 82-85 | workshop row, distribution centre, factory complex, heavy plant | 3 |
| 160-166 | substation, grid supply point, power depot, gas power station, coal power station, wind turbine, solar farm: the power network (docs/utilities.md; 160-209 are the utilities' block) | 15 |
| 217-221 | adventure playground, skate park, allotments, fishing lake, nature reserve: the Play and green places (docs/leisure.md) | 10 |
| 222-229 | lido, tennis club, bowling alley, ice rink, roller disco, climbing centre, trampoline park, go-kart track: Active fun | 13 |
| 250-255 | funfair, city farm, aquarium, planetarium, science centre, observatory: Days out | 14 |
| 118, 119, 129, 140 | art gallery, pottery studio, concert hall, dance hall: Arts and games | 12 |
| 147-149 | family arcade, board-game café, escape room: Arts and games | 11 |

Ids 24-28 are the harbours, 29-31 are reserved for a sea lock, a boatyard and a lifeboat station (docs/boats.md), and 32-39 are left for the transport cards; the size ladders took 40-69 in one block so each family's rungs sit together, the merged zone lots took 70-89 (70-85 used), and the education kinds took 101-108 (91-100 are the London landmarks, 109-115 stay free for education, 111-114 being the London universities; docs/education.md). 116 is Piccadilly Circus and 117 the big screens corner (docs/adverts.md section 9). 130-132 are the media centre's broadcasters (docs/media.md) and 133-139 left for its later phases; 160-209 are the utilities (docs/utilities.md section 2: power 160-171, water 172-181, gas 182-187, internet 188-192, mobile 193-198, London utility landmarks 199-209). The free-time places (docs/leisure.md) took the last free ids outside those blocks: 217-229, 250-255, 118, 119, 129, 140 and 147-149. The byte is now nearly full: what is left free is reserved (29-39, 109-115, 133-139, the drafts' 230-249). `KIND_ID` in `compiled.ts` maps catalogue string ids to kind ids (`KIND_ID['bus-depot'] === 16`) for code that means one exact kind.

## The catalogue

A `KindDef` keeps `code`, now read as its family code, and gains an optional `kindId`. Leave `kindId` out on a family's base kind; its id is its code. A sub-kind sets it:

```ts
export const busDepot: KindDef = {
  id: 'bus-depot', name: 'bus depot', code: Zone.Hub, kindId: 16, family: 'transport',
  flags: { civic: true, workplace: true }, draft: true,
  footprint: { w: 3, h: 2, door: [1, 1] },
  tool: { id: 'busdepot', key: 'K', label: 'Bus depot (3×2)', color: '#e0a92e' },
  ...
};
```

Validation (`buildings:compile` refuses to write otherwise):

- each family code has at most one base kind (no `kindId`, or `kindId` equal to the code);
- a sub-kind's `kindId` is 16 to 255 and unique;
- a sub-kind's family code has a base kind, so sub byte 0 always means something.

The compile step indexes every table by kind id: `CAPACITY_TABLE` and the other level tables by `kindId * 8 + level`, `KIND_FLAGS_TABLE`, `TOP_LEVEL_TABLE` and `FOOTPRINT_TABLE` by id. Two new tables connect ids and codes: `KIND_FAMILY_TABLE` (id to family code) and `FAMILY_BASE_TABLE` (family code to base id). The manifest carries `kindId` and `code` for every kind, tool maps give tool id to kind id, and recipe keys are `kindId:level:design`. Rows 0-15 are byte-identical to the tables before sub-kinds; `npm run buildings:check` compares them with the original snapshot and checks the id and sub round trips.

## Reading kinds in code

| Need | Use |
| --- | --- |
| The kind on a tile | `World.kindIdAt(x, y)`, `ClientWorld.kindIdAt(x, y)`, or `kindIdOf(zoneOf(t), sub)` |
| The kind of a building | `b.id` (`Building.id`). `b.zone` is the family code |
| Numbers by kind | `capacityOf`, `wageOf`, `upkeepOf`, `workOf`, `parkingOf`, `CIVIC_COST[id]`, `CIVIC_UPKEEP[id]` |
| Behaviour flags | `isGrowableId`, `isCivicId`, `isServiceId`, `isWorkplaceId`, `isParkingId`, `isLeisure(id)` |
| Names, occupations, catalogue entry | `KIND_NAMES[id]`, `OCCUPATIONS[id]`, `kindManifest(id)` |
| What to write when placing | `familyOf(id)` into the tile word, `subFor(id)` into the sub layer (0 for a base kind) |

The old kind-code functions (`capacity`, `wageFor`, `upkeepFor`, `constructionWork`, `parkingCapacity`, `isGrowable`, `isCivic`, `isService`, `isWorkplace`) stay as wrappers. A family code means its base kind (sub 0); an id of 16 or more passes through. Engine code calls the id variants.

`Zone.X` names both a family code and the base kind's id, since they are the same number. Which one a comparison means depends on the operand:

- `b.zone === Zone.Fire` or `zoneOf(t) === Zone.Parking` asks about the **family**. The building index, service coverage, patrol dispatch, parking lots, freight and visitor targets, and the health wear of a job all work by family, so a future sub-kind of the fire family dispatches fire engines.
- `b.id === Zone.Airport` or `Placed.kind === Zone.Airport` asks for **that exact kind**. Flights, runways and the airport tooltip check the id, because a bus depot shares family 15 but is not an airport.
- `Citizen.kind` is the workplace's kind id. The shift, wage and payroll come from the id; wear, injuries and vehicle class use `familyOf(c.kind)`.

Hot paths stay typed-array lookups. `Building.id` is set once, when the tile changes, so per-citizen work reads a property and one table entry, never a map.

## Structures

Every tile of a multi-tile structure carries the family code in its word and the kind id in its sub byte, as it carries the kind and the aux byte. `structureAt(x, y, aux, tile, sub)` resolves the anchor's kind id and takes the footprint for that id, so the bus depot's 3×2 footprint and the airport's 8×7 footprint share family 15 without confusion. `PlaceEnv` and `AirfieldEnv` gain a `sub(x, y)` accessor. `World.placeStructure` writes the sub byte on every footprint tile, and `removeStructure` clears it with the aux byte.

## Storage and wire

- **World.** `Chunk.sub` is a `Uint8Array(1024)`. `World.setTile(x, y, packed, sub?)` writes the sub byte in the same call; without `sub` it keeps the byte while the family code stays and clears it when the code changes, the tile is cleared or it is paved. So bulldozing, rezoning and laying a road need no special case.
- **Snapshot.** Format v6 stores each modified chunk's sub layer as base64, only when it is not all zero. v5, v4 and v3 worlds upgrade in place with sub 0 everywhere, so every building keeps its kind and the citizens keep their homes and jobs.
- **Chunk message.** `ChunkDTO.sub` is base64 of the 1024 bytes, omitted when all zero. Every chunk without a sub-kind costs nothing extra.
- **Deltas.** `{ t: 'sub', u: [x, y, sub, ...] }`, only for tiles whose sub byte changed, sent after the `aux` stream and before the `tiles` quads of the same tick, so a client applying the tile words already knows the kind. Placing or bulldozing the 3×2 depot sends one 18-number message; construction progress sends tile quads only.
- **Citizen frames.** The 4-bit kind in the wire flags carries the workplace's family code, so it fits past 16 kinds and the client's colours keep working.

## Why a sub layer

Three designs were weighed.

- **A second per-chunk byte layer (chosen).** The kind sits on the tile, beside the aux byte, so the renderer, the client's airport derivation and the placement preview read it from loaded chunks exactly as the server does, with no extra request. It costs 1 KB per chunk in memory, nothing on disk or on the wire while a chunk has no sub-kind, and a typed-array read per lookup. Old worlds upgrade by adding zeros.
- **Packing into free aux ranges.** The aux byte is already taken on every structure tile (anchor and part bytes) and on airfield strips, so a multi-tile sub-kind would need two values in one byte. The free ranges (`0x01`-`0x3f`, `0xd8`-`0xff`) are also reserved for road classes and graded height, and 103 values is a small id space.
- **A server-side per-building record with ids in chunk payloads.** Buildings live in a server map, so the client would need a second stream to learn ids, and every shared derivation that now runs from tiles alone (structures, airports, the preview) would need that record too. It would be a second source of truth to keep in step with the tiles, and empty lots and sites would need records as well.

## Limits and next steps

- Kind ids run to 255, the sub byte's range. Past that, the sub byte becomes a per-family index: a 4096-entry `(code << 8 | sub)` table resolves to a 16-bit id, and no stored byte changes meaning.
- The bus depot is a draft. It is visible in `/viewer.html` and placeable with `?dev` on a dev server, on unclaimed land too. It hires bus mechanics and costs upkeep, but no buses run yet; that is the gateways card.
