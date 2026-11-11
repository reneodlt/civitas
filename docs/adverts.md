# Adverts: hoardings, campaigns and the vandals

Rich, 2026-10-19: "How about if buildings / areas had allocated advertising areas (nothing extreme) that we would see our
marketing campaigns appear on, however, they are at risk of vandalism, graffiti etc. I am conscious of the refresh
performance loop though." and "let's not forget tv adverts that we might have in fpv view and or on major city
landmarks such as Times Square and/or Piccadilly Circus" (section 9). Design 2026-10-19. **Slice 1 (A1-A3 and a tutorial) is built: see "Built: slice 1"
at the end; so is a first cut of A6's big screens, with Piccadilly Circus: see "Built: the big screens"; campaigns on planning applications, area claims and fly-posting (multiplayer-land M6): see "Built: campaigns on planning applications".** It stands on `docs/motivation.md` (values and beliefs): an advert is a way to plant a belief.

Code this touches: `shared/src/adverts.ts` (new: slot sizes, themes, claims, templates, `AD` tunables),
`shared/src/buildings/` (the `adslot` op, `schema.ts`, `validate.ts`, `facade.ts`), `server/src/sim/adverts.ts` (new:
rentals, reach, wear events), `server/src/world.ts`, `server/src/snapshot.ts`, `server/src/net.ts` (intents),
`shared/src/protocol.ts`, `client/src/render/adverts.ts` (new, modelled on `render/signs.ts`), and a Campaigns panel.

## 1. The idea

Some buildings have **ad slots**: modest, believable places for a poster. A hoarding on a shop's side wall, a panel in
a bus shelter, a 48-sheet billboard above a corner shop, a banner on a stadium. Nothing extreme: no screens on every
wall and no street lit up like Times Square. The big lit screens of Times Square or Piccadilly Circus belong to a handful
of landmark junctions only (section 9).

A player runs a **campaign** (a message with a theme, a claim and a target) and rents slots to show it. Citizens who
pass a slot may take the message in, and it plants a belief (`docs/motivation.md` section 4). Whether it moves anyone
depends on whether the theme speaks to what they care about.

Posters **wear**: they fade, peel, get tagged, get torn. A worn poster works less, and a wrecked one works against the
message. Rival players can fly-post over yours. Keeping a campaign clean costs money, and it costs more in neglected
neighbourhoods.

Two kinds of screen sit beside the posters (section 9): **TV adverts**, bought as airtime from a TV studio and seen at
home (and on the living-room TV in the first-person view), and **big screens** on a few landmark junctions such as
Piccadilly Circus, where several campaigns take turns on lit, animated panels.

Citizens belong to no one, and nor does an audience: an advert reaches whoever walks past, on anyone's land. Ads are
how players compete for the same people.

## 2. Slots

### In the catalogue

A new op in the building recipe (`docs/buildings.md`), placed by facade cell like a door:

```ts
['adslot', wall, bay, storey, size]   // size: 'panel' | 'poster' | 'hoarding' | 'billboard' | 'banner'
```

| Size | Where | Tiles (w × h) | Base rent per day |
| --- | --- | --- | --- |
| `panel` | bus shelters, station platforms (`busstop`, rail and metro stops) | 0.25 × 0.35 | 2 |
| `poster` | shop side walls, pub walls, the end of a terrace | 0.35 × 0.5 | 3 |
| `hoarding` | building sites (`Site`), long ground-floor walls | 0.9 × 0.4 | 6 |
| `billboard` | on a frame above a low shop or works, at a junction | 1.0 × 0.5 | 10 |
| `banner` | stadium, arena, college and civic fronts (landmarks excluded) | 0.3 × 1.2 | 8 |
| `screen` | big-screen landmarks only (section 9): lit, animated, shared by turns | 0.6 × 0.4 to 2.0 × 1.0 | auctioned |

`validate.ts` treats a slot like a signboard for the windows check: it may not cover a window, it must sit on a wall
with a facade, and it must face a road side. Designs get slots by hand where they belong; families can also take
default slots in `zonekit.ts`/`tierkit.ts` so most commercial designs have one without editing each.

**Not every building, not every wall.** About one commercial or leisure building in three, every bus shelter, every
building site's hoarding, and no homes (question 2). A city block has a handful of slots, not dozens.

### Slot identity

A slot is `(building tile key, slot index)`, derived from the design as sign slots are (`signSource`, `shapeExtent`).
Nothing about an empty slot is stored or sent. Only a **rented** slot has state.

## 3. Campaigns

```ts
interface Campaign {
  id: number; owner: string;            // player id
  theme: number;                        // a motivation value: Money, Family, Status, Roots, Time, Adventure
  claim: number;                        // what it says, from a table per theme (below)
  target: { kind: 'parcel' | 'estate' | 'building' | 'study'; id: number | string };
  look: number;                         // template, icon and palette (section 5)
  created: number;                      // game day
}
```

The **claim table** is per theme, with wording filled in from the target's name:

| Theme | Claims |
| --- | --- |
| Money | "Low rents in {parcel}", "Smith & Co pays well", "Keep more of your wage in {parcel}" |
| Family | "Great schools in {parcel}", "Room to grow in {parcel}", "Safe streets, happy kids" |
| Status | "Get your degree at {college}", "A career at {building}", "Live in {estate}" |
| Roots | "Local jobs for local people", "{parcel}: proud since day one" |
| Time | "Five minutes from work in {parcel}", "The 42 bus: every ten minutes" |
| Adventure | "Something new in {estate}", "Study abroad... well, across the river at {college}" |

A player has at most `AD.maxCampaigns` (8) live campaigns. Creating one costs `AD.campaignCost` (artwork and setup), and
each rented slot costs rent per game day. **Rent goes to the owner of the parcel the slot stands on** (question 1), so
high-street frontage earns its owner money even if that owner never advertises.

### Claims can be false

Nothing stops a player claiming "Great schools in Northgate" when Northgate has none. The claim plants a belief; the
truth comes later, through experience and regret (`docs/motivation.md` section 7). Families who move for the schools
find there are none, become cynical, and tell their friends. Honest campaigns compound and false ones backfire.

## 4. Reach: who sees an advert

Testing every walker and driver against every slot every tick is the thing to avoid. Instead, reach is worked out
**once per game day per rented slot**:

1. **The road index.** Each slot faces one road tile. `AdIndex` maps road tile → rented slots on it, updated on rent
   and expiry.
2. **Who passes.** Commuters' paths are already cached (`Citizen.commute` for walkers; drivers have routes in their
   `legs`). Once a day, at the citizen's `lifeStep` (which already runs once a day per citizen), walk their cached commute
   path against `AdIndex` and collect the slots they pass, at most `AD.seenPerDay` (4), nearest to home first. That's one
   pass over a path of a few dozen tiles, and only for citizens with a commute; the common case is "no slots on my
   path" and costs one map lookup per tile.
3. **Bus riders** see panels at the stops they use: the boarding and alighting stops of their transit legs.
4. **The nudge.** For each slot seen:

   ```
   effect = susceptibility × values[theme] × condition(wear) × freshness × AD.strength[size]
   ```

   It moves the citizen's belief about the target on the theme's value toward the claim's sign.
   - `condition` is section 6's wear curve: 1 when fresh, falling to 0, then **negative** past the backfire point.
   - `freshness` is saturation: `1 / (1 + seen)`, where `seen` counts days this citizen has seen this campaign (kept in
     a tiny per-citizen ring of the last 3 campaign ids and counts). Ten posters on one road are not ten times one.
   - Contrarians invert it (`docs/motivation.md` section 8).
   - After `AD.driftAfter` (6) days of exposure to one theme, the citizen's `vdrift` moves one step toward that theme.
     That is how a long campaign shifts values a little, not just beliefs.

So a Family message on a route full of parents does a lot, and the same poster on a route full of Grafters does
almost nothing. Choosing where, for whom and what to say is the game.

### What players learn

The Campaigns panel shows per campaign: slots, condition, **reached** (distinct citizens per day), **swayed** (beliefs
moved past a threshold), and **acted** (decisions where that belief tipped the score: moves, job changes, enrolments).
"Acted" comes from the `lastCall` record in `docs/motivation.md` section 7, which already names the belief that drove
a call. These are counters, so they cost nothing per tick.

## 5. Rendering

### One instanced mesh, like the name boards

`client/src/render/adverts.ts` copies the design of `render/signs.ts`:

- **One `InstancedMesh`** of quads for every visible rented slot, one draw call in total. Empty slots draw as a plain
  frame in the building model itself (part of the design), so the street looks right with no adverts at all.
- **The near tier only.** Instances exist only for chunks within `NEAR_IN` (`render/buildings.ts`), with the same
  per-slot fade as signs (`SIGN_FADE_START`, hashed jitter). Further out, the far model's frame shows the campaign's
  main colour as a flat tint (one per-instance colour, no texture), and past `FAR_AT` nothing.
- **The ad atlas.** One 2048² canvas texture. Each live campaign gets one cell, drawn once when the campaign is
  created or first seen: a template layout, the owner's colour, an icon from a fixed set and the claim's text. With
  at most 8 campaigns per player, a server with a dozen players needs about 100 cells; the atlas holds 128 at 256×128
  and reuses the cells of ended campaigns. **No canvas work after that.**
- **Wear and graffiti in the shader, not in the texture.** The same atlas has a fixed strip drawn at start-up: 16
  graffiti tags (four crews' styles, section 6), a peel and tear noise mask, and a "fly-posted" overlay. Each instance
  carries `aWear` (0-1), `aSeed` and `aFlags` (fly-posted, cleaned recently). The fragment shader:
  - fades and yellows the poster as `aWear` rises;
  - cuts tears where the noise mask is below `smoothstep` of `aWear`;
  - overlays tag `aSeed % 4 + crew × 4` once `aWear` passes a seeded point, and a second tag later;
  - lights up at night like the shop boards (`glow`), for billboards and panels only.

  So a poster visibly ages over days with no texture redraws at all.

### When the instance buffer changes

- **On a rental event** (rent, end, fly-post, clean, tear down), for that one slot: one instance's attributes.
- **On the LOD pass** (`LOD_STEP`, already run when the camera moves), when chunks enter or leave the near tier.
- **`aWear` is computed on the client**, from the rental's `placed` day, the slot's area rate and its seed (section 6).
  It's refreshed for visible instances once per game hour: a few hundred floats into one `InstancedBufferAttribute`
  with `DynamicDrawUsage`, a tiny upload. Never per frame.

Nothing about adverts runs per frame except the shader.

## 6. Wear and vandalism

### Wear is a formula

A rental stores `{ campaign, placed, seed, cleaned }`. Its wear at any moment is

```
wear = 1 - exp(-(now - max(placed, cleaned)) × rate(area) × (0.7 + 0.6 × hash(seed)))
```

The server and the client compute the same number from the same inputs, so wear never goes over the wire. The
`condition` used in reach (section 4) is `1 - wear / AD.backfireAt` clamped to `[-AD.backfire, 1]`: a poster loses
effect as it wears, and past `backfireAt` (0.8) it starts to put people off. A filthy "Move to Northgate" poster
makes people think less of Northgate.

### The area rate

`rate(area)` is per parcel, recomputed once per game day with the parcel's stats (`ParcelStats`), from things the sim
already knows:

- the share of adults out of work there;
- the share of 14-17s with no school place (the education census, `docs/education.md` section 15);
- services and leisure coverage (the same `coverage` and `leisureCoverage` used for tax tolerance), which lower it;
- the size of the slot (big billboards are harder to reach, so they wear slower; bus shelter panels faster).

A well-served neighbourhood keeps posters clean for weeks; a neglected one tags them within days. Adverts are cheap in
good areas and a money pit in bad ones, which is one more reason to look after a district.

### Crews

Each neighbourhood with a high rate has a **crew**: a hashed tag style (one of four looks in the atlas strip) chosen
from the parcel or estate id. You learn to recognise whose patch you're in. Crews aren't simulated as people (question
5); they're a look and a rate.

### Events (the only things sent)

| Event | Cause | Effect |
| --- | --- | --- |
| **Rented** | player intent | the rental record; the slot shows the campaign |
| **Ended** | rent stopped or unpaid | the slot goes empty |
| **Cleaned** | a crew visit (below) | `cleaned = now`: wear restarts |
| **Torn down** | `wear` passes `AD.tearAt` (0.95) and a daily roll | the slot is empty again; the renter is notified |
| **Fly-posted** | a rival's intent (section 7) | the rival's campaign over yours, flagged, its own `placed` |
| **Mural** | rare: a slot in a high-rate area at full wear, a daily roll of `AD.muralChance` | section 8 |

Each event is one small message on the chunk subscription (as building changes are), and they're rare: a few per
player per game day.

### Keeping clean

- **Cleaning contract** (a Campaigns panel toggle per campaign): `AD.contractCost` per slot per day halves the rate.
- **A one-off clean**: send a poster crew. A van (`FleetKind` 10, `PosterCrew`, using the fleet machinery like the
  sweepers) drives to each slot on real roads and works for a few minutes. When it gets there, the slot's `cleaned` is
  set. You can watch your crew go round, and so can your rivals.

## 7. Rivals

- **Fly-posting.** A player may post one of their campaigns over a slot rented by someone else, for
  `AD.flyPostCost`. The rival's campaign shows (with a rough, pasted-on look: `aFlags`) and gets the reach, for free,
  until the slot's renter reacts. A fly-post wears at twice the rate.
- **Taking it down.** The renter, or the owner of the parcel the slot stands on, can pay `AD.removeCost` to restore
  the slot (a crew visit, as above).
- **Limits so it never becomes griefing:** at most `AD.flyPostsPerDay` (3) per player; never over a campaign less than
  a game day old; never on a slot whose parcel owner has turned on "No fly-posting" (a parcel setting with a small
  daily cost, a steward's choice).
- **Spectate mode.** The new intents (`adCampaign`, `adRent`, `adEnd`, `adClean`, `adFlyPost`, `adRemove`) are not in
  `net.ts` `READ_ONLY`, so a showcase refuses them like any other change.

## 8. Murals

Now and then a heavily tagged wall in a neglected area becomes a **mural**: a local artist paints over the whole slot.
A mural is no one's campaign and can't be rented while it lasts (about 4 game weeks). It gives a small happiness part
to people living within 6 tiles ("a mural on the corner"), and a Roots belief bump about that parcel to people who pass
it. Neglect, now and then, gives something back. Murals are drawn from a small fixed set in the atlas strip (question
4).

## 9. Screens: TV adverts and the big lights

Posters are cheap, local and targeted by route. Screens are the other end: broad, bright, expensive, and with no
graffiti (a screen fails in its own way).

### TV adverts

- **Where the airtime comes from.** A new office-family kind, the **TV studio** (a culture tech, question 6), is the
  city's broadcaster. Its parcel owner sells airtime and takes the money, as a slot's parcel owner takes poster rent.
  With no studio, there's no TV advertising. Two studios on different players' land compete on price.
- **What a player buys.** A **spot**: one campaign, a number of evening airings per game day, for a number of days.
  A studio has `AD.tvSpots` (6) spots a day, sold to the highest bid each day, so prime time is scarce.
- **Who sees it.** Once a game day, households that were home in the evening (new: an `eveningHome` bit, set when a citizen is at
  home at 21:00 and read by the next life step) and own a TV (`hash2(hh, 321) < AD.tvShare`, 85%) are reached by each
  airing spot, at `AD.tvStrength` (about a third of a poster's), with the same `values[theme]`, susceptibility,
  saturation and contrarian rules as section 4. There's no route and no condition. TV reaches everyone a little,
  including the retired and the people who never pass your posters. It can't pick a district; posters can.
- **The first-person view.** `render/interiors.ts` already gives home rooms a TV (`Screen`, palette `'tv'`), with a
  new shot every few seconds. When the followed citizen is at home in the evening and a spot is airing, the TV cuts
  to an **ad break**: the campaign's cell from the ad atlas (section 5) as the screen's texture for a few shots, then
  back to the programme. The room is built only while the FPV is inside it, so this costs nothing otherwise. The
  citizen's thought line can follow it ("Saw an advert for Kingsway College").
- **Studio quirks.** A studio's spots have a **slot name** ("before the news", "in the match"): one in the match during
  a stadium event night (`shared/src/leisure.ts`) reaches double, mostly the Money and Adventure crowd. A studio
  that sells too many spots in a day makes viewers switch off: reach per spot falls past `AD.tvFatigue`.

### Big screens

- **Landmark kinds.** A few junction landmarks carry `screen` slots: **Piccadilly Lights** at Piccadilly Circus for the
  London demo (51.5100, -0.1347, with the Shaftesbury Memorial Fountain and its statue, between `londonMap.ts`'s
  Piccadilly and Regent Street, near the `stop-159-piccadilly` bus stop), and later **Times Square** for a New York
  scenario, which doesn't exist yet. For other cities, a generic **big screens corner** kind (a curved lit facade on a
  corner block) unlocks late in the culture or commerce track.
- **Shared by turns.** A screen has `AD.screenTurns` (6) turns. The panels cycle through the renting campaigns every
  `AD.screenSecs` (8 real seconds), driven by the world clock in the shader, so every viewer sees the same rotation
  and nothing goes over the wire. Turns are sold by daily auction among players, so the best screen in town is
  something players fight over.
- **Reach.** Screens sit on the busiest junctions, so section 4's daily path pass counts them for everyone passing,
  with `AD.strength.screen` the highest of any slot, and visitors (people arriving by rail, coach and air) count too.
- **No graffiti, but failures.** Screens don't wear. Now and then (`AD.glitchChance`) a panel fails for a game day: a
  frozen frame, a stuck colour band, or the famous blue error screen. The turn's campaign gets no reach that day and
  the renter is refunded. A small, funny moment, and a reason not to put everything on one screen.
- **Rendering.** The screen quads go in the same instanced mesh as posters, with an `aFlags` bit for "screen": the
  shader steps through a list of atlas cells by time, adds scanlines and a soft glow, and lights fully at night
  (`glow` 1). Big screens are seen from far away, so they stay in the mid tier (no fade before `FAR_AT`); there are
  only a handful in a city, so this costs nothing. At street level in the FPV they're the brightest thing in the
  shot, and they throw their colour on the fog at night as the shop boards do.

## 10. Balance and performance

- **Tick cost.** Nothing per tick. Reach runs inside `lifeStep` over a cached path. Area rates run with the daily
  parcel stats. Events are rare. Target: under 2% more sim ms per tick on the 6×6 district test, measured with
  `loadtest/ab.ts --set ads=0` and a new `loadtest/adverts.ts` probe (rents campaigns from a scripted player, prints
  reach, swayed, acted, wear and events per day).
- **Client cost.** One instanced mesh and one draw call; one 2048² texture; a few hundred floats uploaded per game hour
  while the camera rests; attribute writes per event; nothing per frame but the shader. Measure with the existing
  render stats on the London demo at street level.
- **Wire.** Rentals ride with the chunk snapshot (only rented slots: a handful per chunk) and as events after that.
  Campaigns (the look and text, a few dozen bytes each) are sent once in the welcome and on create.
- **Text is from tables, not typed.** Claims are templates filled with real names, so there's nothing to moderate on a
  shared server and nothing unbounded to draw into the atlas.
- **Old worlds**: no rentals; empty slots come from the designs. New snapshot fields are optional. No format bump.

## 11. Phased plan

| # | Subtask | Files | Depends on | Size |
| --- | --- | --- | --- | --- |
| A1 | **Slots.** The `adslot` op, sizes, validation and the windows check, default slots in the kits, empty frames in the models, the viewer showing slots | buildings/schema.ts, validate.ts, facade.ts, zonekit.ts, tierkit.ts, compiled.ts (regenerate) | none | M |
| A2 | **Campaigns and rent.** `shared/src/adverts.ts`; `Campaign`, rentals on the world, intents, rent to the parcel owner in the ledger, the Campaigns panel, snapshot | adverts.ts (both), world.ts, net.ts, protocol.ts, snapshot.ts, ui.ts | A1 | M |
| A3 | **Rendering.** `render/adverts.ts`: instanced quads, the ad atlas, near-tier fade, far tint, the wear shader with tags and tears | client render/adverts.ts, render/buildings.ts (LOD hook), materials.ts | A1, A2 | M |
| A4 | **Reach.** `AdIndex`, the daily pass in `lifeStep`, bus stop panels, the nudge into beliefs, saturation, drift, the reached / swayed / acted counters | sim/adverts.ts, sim/motivation.ts, simulation.ts | A2, motivation M4 | M |
| A5 | **Wear and rivals.** Area rates, events, tearing down, contracts, the poster crew van (`FleetKind` 10), fly-posting and removal, murals | sim/adverts.ts, fleet.ts, sim/mobile.ts, render | A3, A4 | L |
| A6 | **Screens.** The TV studio kind and tech, airtime auctions, evening reach, the ad break on the FPV TV (`interiors.ts` `Screen`); `screen` slots, the Piccadilly Lights landmark for London, the generic big screens corner, the turn rotation and glitches in the shader | buildings (office, landmarks-london), tech.ts, sim/adverts.ts, render/adverts.ts, render/interiors.ts, demo/london.ts | A4 (A3 for the shader) | L |

A1 and the motivation work (M1-M4) can go in parallel. A3 can start as soon as A2's wire shape is fixed.

**Showcase** (`docs/demo.md`): A1 adds no kinds, but every slot size should stand in the Showcase on a placed design,
and the tour gets two stops: a high street with three rented slots at three wear levels and a fly-post, and the big
screens corner at night. The TV studio, the big screens corner and Piccadilly Lights are catalogue kinds, so
`demo:check` already asks for their placements. Add
`SHOWCASE_FEATURES` entries `advert-reach` (a seeded campaign reaches a showcase commuter within `FEATURE_DAYS`) and
`advert-wear` (a run report line: events by kind after `--run 2`).

## 12. Questions for Rich

1. **Who gets the rent for a slot?**
   - **A. The owner of the parcel it stands on** (recommended): frontage becomes valuable, and stewards who don't
     advertise still earn from those who do.
   - B. The city (no one), as a cost only.
2. **Can homes carry ads?**
   - **A. No: commercial, leisure, civic fronts, bus shelters and building sites only** (recommended). Keeps it
     modest.
   - B. Yes, gable ends of terraces as `poster` slots.
3. **Free text on posters?**
   - **A. No: claims from tables, filled with real names** (recommended). Nothing to moderate.
   - B. A short line of filtered free text per campaign.
4. **Murals?**
   - **A. Yes, rare, from a fixed set** (recommended).
   - B. Not now.
5. **Should vandals be people?**
   - **A. No: a rate and a look per area** (recommended). Cheap, and neglect still shows.
   - B. Yes: teenagers out of school sometimes go out tagging, as walkers you can follow. Lovely, but a new behaviour
     to simulate and a sensitive one to get right.
6. **Where does TV come from?**
   - **A. A TV studio building whose parcel owner sells airtime** (recommended): another thing for players to own and
     compete over.
   - B. The city sells airtime, with no building.
7. **Which big-screen landmarks?**
   - **A. Piccadilly Lights in the London demo now, a generic big screens corner for every city, Times Square when
     there is a New York scenario** (recommended).
   - B. Only the generic corner, no real landmarks.

## Built: slice 1 (A1-A3 and the tutorial), 2026-10-20

What stands, and where it differs from the design above. Questions 1, 2, 3 and 5 take their recommended answers: rent
goes to the parcel owner, homes carry no ads, claims come from the table, and vandals are a rate per area.

### A1 slots

- **The op.** `['adslot', part, face, bay, storey, size, at?]` (`buildings/schema.ts`, expanded in `facade.ts`, built by
  `buildings/adslot.ts`). On a facade box it is placed by cell, like a door: centred in the bay, and in the storey (or
  standing on its floor when taller). On a plain box `bay` and `storey` are 0 and it is centred, or placed `at`
  [along, up] as fractions of the wall. It draws an empty frame (a border and blank paper) into the model, so a street
  with no adverts looks right.
- **Sizes at the models' scale.** The table in section 2 was about 2.5 times too big: a storey is about 0.25 tiles,
  which makes a tile about 15 m. The built sizes in tiles are: panel 0.12 × 0.16, poster 0.16 × 0.21, hoarding
  0.42 × 0.14, billboard 0.44 × 0.22 (a 48-sheet) and banner 0.11 × 0.29. Rents are as in the table. A slot on a small
  wall shrinks to fit and keeps its shape.
- **Rules.**
  - A slot is never on the back wall (`validate.ts`).
  - A frame may not cover a window: the compiler runs `windowCollisions` on every design's frames and refuses to
    compile one that does.
  - Facing a road side is checked when renting (`shared/src/adverts.ts adSlotOpen`). A front slot always faces one. A
    side-wall slot on a 1×1 lot needs open ground beside it (a road, empty land, a car park, a park or a bus shelter),
    not a neighbour's wall. Shelter panels and the slots of multi-tile buildings stand free.
- **Slot identity.** A slot is (door tile, index). `AD_SLOTS` in compiled.ts holds each design's slot records (face,
  size, poster centre and size in model space). Server and client find a building's design from the same hash and road
  test as the chunk view, so neither sends anything about an empty slot.
- **Default slots.** The compiler gives about one commercial or leisure design in three (hash-picked, landmarks
  excluded) a slot where one fits: 43 of 172 designs. It is either:
  - a poster in the side bay nearest the road, with the facade cells under it made plain wall like a real shop's blank
    flank, provided nothing stands in front of it; or
  - a billboard on legs over the front of a flat roof.
- **Hand-placed slots.**
  - Every bus shelter has a panel in its end pane.
  - The site fence's front became a plywood hoarding with a slot. The renderer now turns a 1×1 site to face the road,
    as it does the shell.
  - The kits gained `tierkit.adBoard` (a board on two posts) and `zonekit.billboard`. These give banners by the
    stadium's gates in both designs, a billboard at the retail park's entrance, and a new surface car park design
    (designs/adverts.ts) with a 48-sheet over its back row, on about half of all lots.
- **Checks.** buildings:check section 12 covers the records, the share, no frames on homes, the shelter and the site,
  and refusals for the back wall, an unknown size and a frame over a window. Two snapshot models were deliberately
  re-snapshotted (ADSLOT_FIXED).

### A2 campaigns and rent

- **Unlock.** Advertising is a tech: zoning track, tier 2, after Commercial zoning, at 60 residents, $250. A tech was
  chosen over a rank because every tool and panel in the game is opened by a tech feature. That way the tree previews
  it, sandboxes and the Commons get it with every other tech, spectate and administration refuse it like any other
  change, and the goal chain can wait on it as Masonry's goal does. No rank opens a feature today.
- **Campaigns.** `server/src/sim/adverts.ts`:
  - A campaign is a theme, a claim from `AD_CLAIMS` (14 claims over the six themes), filled with one of the player's
    parcel names or a workplace's sign, and a look (palette × layout × icon).
  - The artwork costs $150, and a player runs at most 8 campaigns.
- **Rent.**
  - Renting charges the first day at once, then each midnight. Both sides file it under **Billboard rent** ('adrent')
    in the ledger, a running cost; the artwork is **Advert campaigns** ('ads'), a one-off (playtest 6399a522).
  - The money goes to the owner of the parcel the slot stands on. Renting your own frontage is free, and on unclaimed
    land the money goes nowhere.
  - A rental ends at midnight if its slot has gone (the building pulled down, the site finished) or if the renter
    cannot pay or is in administration. The renter gets a toast.
  - A player may rent at most 60 slots.
- **Wire.**
  - One `ads` message carries every campaign and rental, 9 numbers each. It is sent on join and whenever they change,
    which is rare (intents and midnight).
  - The intents are `adCampaign`, `adRent` (slots by door and index, or "the n free nearest a point") and `adEnd`
    (slots, a campaign's slots, or ending the campaign).
  - Spectate refuses them: they are not in READ_ONLY. Administration refuses creating and renting.
- **Saves.** The snapshot's optional `adverts` field holds campaigns, rentals and who has posted. It is left out until
  someone advertises. Older saves load with none, and there is no format bump.

### A3 rendering

- **The mesh.** `client/src/render/adverts.ts` is one InstancedMesh (one draw call) of quads for the rented slots of
  every loaded chunk, packed per chunk like the name boards and flushed at most once a frame.
- **Distance.** Within the signs' fade (SIGN_FADE_START plus a hashed per-poster jitter) a poster shows its artwork.
  Past that the same quad shows the campaign's main colour as a flat tint, and past FAR_AT it is discarded.
- **The ad atlas.** One 2048² canvas holds a 256² block per campaign, drawn on first sight and handed back when the
  campaign ends: 56 blocks. Each block has three cells: landscape (billboards, and hoardings from its middle band),
  portrait (posters, panels) and tall (banners). The bottom row holds 16 graffiti tags in four crews' styles, drawn at
  start-up.
- **Wear in the shader.**
  - The paper fades, yellows and greys with streaks of grime from the top.
  - A first tag, then a second, appear once the wear passes seeded points, in the area's crew (hashed from the
    parcel).
  - Tears open from the edges in a seeded noise pattern, showing old paste and paper behind.
- **No per-frame work.** Wear is `adWear` from the shared formula, refreshed for every instance once a game hour. Only
  the shader runs per frame.
- **Organic variation.** Every poster has its own seed, which sets:
  - its wear rate (0.7-1.3x);
  - which tags it gets, where and how big;
  - its tear pattern;
  - a slight tilt and offset on the wall.
- **Lighting.** Billboards and shelter panels are lit at night; paper on walls is not.
- **Picking.** While the Campaigns panel is picking frames, free frames in view glow and pulse (the same mesh, a flag).

**Wear formula.** Each rental carries an age in wear units and the rate it ages at. Its wear is
`1 - exp(-age × (0.7 + 0.6 × seed))`. Once a game day the server rolls the age forward and sets the rate afresh from the
slot's area:

```
need = 0.6 × min(1, jobless / 0.3) + 0.25 × (1 - cover / 3) + 0.15 × (1 - leisureTier / 2)
rate = (0.012 + 0.388 × need^1.5) × size wear (panel 1.3, poster 1, hoarding 1.15, billboard 0.6, banner 0.7)
```

- `jobless` is the share of the parcel's resident adults out of work and not studying (one pass over the citizens at
  midnight, only while something is rented).
- `cover` (0-3) and `leisureTier` (0-2) are the simulation's own at the slot's door.

In practice a neglected street tags a poster within three days, and a well-served one keeps it clean for weeks. The
design's single `rate(area)` becomes a daily-sampled rate, so a district that improves slows its posters' wear from
that day on.

### The Campaigns panel and the tutorial

- **The panel.**
  - The **ads** chip shows once Advertising is unlocked, or while its goal is up. It opens a side card
    (`client/src/adverts.ts`).
  - The card makes a campaign: theme, claim, what it is about, colours, layout, icon, a live preview of the poster,
    and the price.
  - Each campaign card shows its frames, cost a day, the state of its posters (words and a bar per frame) and the
    buttons **Pick frames**, **Rent 3 nearest**, **Take all down** and **End**.
  - **Reach is not built** (A4 needs beliefs, docs/motivation.md). The card says so in the players' terms: "Townsfolk
    walk past without taking much in for now: people will start to notice posters, and change their minds about where
    to live and work, in a coming update."
- **The goal.**
  - "Run your first campaign" sits after "Somewhere to go" (shared/src/goals.ts). Its parts are: Advertising unlocked,
    a campaign made, two frames rented. The reward is $250.
  - Its **show me** opens the tech tree while Advertising is locked. After that it opens the Campaigns panel, starts
    picking for the first campaign and flies the camera down to street level, looking at the nearest free frame.
  - A returning player already past that point in the chain gets the goal too, as an introduction to the feature.
- **The milestone.** The milestone feed has "Your first poster goes up" (server/src/ranks.ts firsts).

### The showcase

- **The High Street section.** It is a new section west of the town (shared/src/demo/showcase.ts HIGH_STREET). Shops
  line both sides, with gaps picked by design hash so the posters on their flanks face open ground. There are two car
  parks with billboards, a bus shelter and a building site behind its hoarding.
- **The seeder.** `server/src/demo/adverts.ts` opens the site after the fill and puts three campaigns up on every open
  frame there, kept at their ages: fresh, tagged and wrecked side by side.
- **The tour.** It stops at 'high-street' after the shops block.
- **Features.**
  - `advert-slots`: every frame size open somewhere in the seeded town.
  - `advert-wear`: three wear levels.
  - `advert-reach` is registered as a todo for A4.

### Measured

- **Tick cost.** `loadtest/ab.ts` (seed 1, 08:00 + 1,500 ticks) gives identical metrics on this branch and on main
  a17b145: the same game, 0.689 against 0.659 ms a tick, which is run-to-run noise. `Adverts.tick` is a day check: 0.9 µs
  a tick over four game days with posters up, the daily pass included (`loadtest/adverts.ts`).
- **Client cost.** London at street level draws 155 calls a frame with 8 posters up and 154 with the poster mesh hidden:
  one draw call.
- **Old saves.** Copies of the live `data/world.json` and the showcase's demo snapshot load and save again without an
  `adverts` field.
- **The probe.** `npx tsx packages/server/src/loadtest/adverts.ts` passes 29 of 29.

### What A4 needs next

- An `AdIndex` from road tile to rented slots. `adSlotWorld` gives each slot's facing, from which its road tile
  follows.
- The daily pass in `lifeStep` over cached commute paths, and bus riders seeing panels at their stops.
- Citizens' beliefs and values (motivation M1-M4) for the nudge.
- The reached / swayed / acted counters for the panel, which then replace its "coming update" line with numbers.

## Built: the big screens, a first cut of A6 (2026-10-20)

Rich, 2026-10-20 (UTD "New landmark: Piccadilly circus"): "Great for having a big TV showing adverts, or news etc
(especially from the helicopter)", and "Needs Eros as well!". This cut builds the screens and the two big-screen kinds.
The TV studio, airtime auctions, evening reach, the ad break on the FPV TV and screen failures are still to come.

### The slot

- **A sixth size, `screen`** (`buildings/adslot.ts`): rent $40 a day, four times a billboard, which is how this cut prices
  "the best screen in town". Screens are lit and never wear (size wear 0, so their area rate is 0). It is the 'L' artwork
  shape. A flat screen can stand on a wall like any slot (`adslot … 'screen'`). The curved banks use a new op.
- **The `screens` op** (`x y z r from to cols rows h [bezel]`, `screenArc`) lays `cols` × `rows` flat panels round a
  vertical arc. Each column is one facet of a dark bezel cylinder whose segments line up with the columns, so validation
  asks that a column's angle divide 360 and `from`. Every panel is a `screen` slot of its own, facing out of its facet.
  Nothing stands proud of the radius, so the walls the curve meets tangentially keep their windows.
- **Slot records grew a number.** `AD_STRIDE` is 8: the eighth is the way the poster faces, as a turn about y in model
  space. For a wall slot it is its wall's (`FACE_YAW`). A curve's panel faces its own way, and `face` is the nearest
  wall's, so `adSlotWorld` and the never-the-back-wall check still read it. `compiled.ts` is regenerated, nothing about
  a rental changes, and old saves load as they were.
- **Renting.** A screen is rented through the Campaigns panel like any frame: **Pick frames**, then click the building,
  and its first free screen is taken. "Rent 3 nearest" never takes a screen, on the server (`Adverts.nearest`) or in the
  panel's "show me". Rent goes to the parcel owner as for any slot.

### Turns

- **One ring per building** (`shared/src/adverts.ts screenTurns`). A building's screens share a ring of turns, one turn
  per panel. Both big-screen designs have `AD.screenTurns` (6), and `buildings:check` holds every screen design to that.
  - Turn k shows the campaign renting the k-th panel.
  - An unrented turn shows a house advert. There are seven generic brands, `HOUSE_ADS`: a drink, a phone, a bank, a
    railway, tea, noodles in neon and a mobile network. The building's seed picks which, so two screens in a town differ.
  - The last unrented turn is **the news**.
  - So the Lights are never dark, and a campaign renting one panel takes its turn on all six.
- **The rotation is in the shader** (`client/src/render/adverts.ts`). Every `AD.screenSecs` (8 s) each panel steps on to
  the next turn of the ring. The clock is the wall clock (`Date.now`, one uniform a frame, wrapped at a whole number of
  every ring's cycles), so every viewer sees the same rotation, give or take their machines' clock skew. Nothing goes
  over the wire. The ring is packed into the instance's `aRect` as atlas codes, three to a float:
  - 0-55: a campaign's block;
  - 56-62: the house adverts;
  - 63: the news.
  The instance buffer changes only when a rental does.
- **The news hook.** One turn per building is a 'news' turn. Today it shows a "LIVE · Civitas News" card from the ad
  atlas: a skyline, a helicopter, the LIVE bug and a ticker.
  - **The headline.** `AdvertsView.setNewsHeadline(text)` puts the latest story on the card's ticker. The media
    centre's story log (N2) calls it with `news.latest(1)[0]?.h` whenever the latest story changes; an empty text puts
    the card's own line back. Only the news cell of the atlas is redrawn: the text is cut at 60 characters with an
    ellipsis and set as large as fits, 12 px down to 8. An unchanged text costs nothing, and a change re-uploads the
    atlas once (16 ms measured in headless Chrome).
  - **The picture.** The media centre (UTD 90cd3857, N4) will hand `AdvertsView.setNewsFeed(texture)` the news
    helicopter's render target. Every news turn on every screen then samples that texture instead of the card, and
    `null` puts the card back.
  - Selling the news turn, and auctioning airtime, belong to that card.

### The look

- **The art.** Campaigns use their 'L' cell. The house adverts and the news are a row of 256×128 cells under the
  graffiti tags, drawn once at start-up.
- **Drawn whether rented or not.** Screens are drawn from the moment a chunk loads, with no distance fade and no tint,
  out to 900 tiles. Posters still stop at `FAR_AT`.
- **Brightness and screen effects.** Screens are mostly emissive: 0.75 of their colour by day and 1.2 at night, over a
  dim diffuse. They have scanlines and an LED grain close up, both fading with distance so far screens do not shimmer,
  a darker rim at the bezel, and a wipe from one turn to the next.
- **Organic** (the standing rule):
  - every panel has its own phase offset (up to 1.9 s), so neighbours never flip together;
  - its own brightness (0.86-1.1x) and a slow breath;
  - its own wipe direction (across or down);
  - its own slow drift and zoom across the picture;
  - and now and then (about one turn in 25, from its seed and the step) a glitch of its own, for a fifth of a second to
    1.4 s: a frozen frame, colour bars, the blue error screen or a picture torn into bands.
- **The glow.** A second, additive instanced mesh (`AdvertsView.glow`, a child of the poster mesh) carries each panel's
  halo and pool:
  - the halo spills above and below the panel, never over it or a neighbour, which would wash the pictures out;
  - the pool of the panel's current colour lies on the ground in front, brightest at the wall and reaching further
    from the upper row;
  - its colour is the turn's art, read from a small mip in the vertex shader;
  - it is faint by day and strong at night, and the fog thins it with distance.
  This is the colour the screens throw on the street and the haze at night.

### The two kinds

- **Piccadilly Circus** (kind 116, `buildings/landmarks-london-4.ts`, London tier 15, `lnd1`) is a 4×2
  theatre-family venue: the Criterion Theatre, with four event nights a week.
  - **The Lights.** The London Pavilion and Monico block's stone corner, of radius 0.75, turns from facing west to
    facing the road. The six screens run round it, three columns of 30 degrees in two rows.
  - **The Criterion** has a mansard and dormers and its lit canopy on the square.
  - **The Shaftesbury Memorial Fountain** has its octagonal steps, the bronze basin and tiers, and Anteros (Eros) in
    aluminium on top: winged, bow held out, balanced on his left foot.
  - **On the square:** the Underground stairs behind railings with their roundels, two red telephone boxes and lamps.
  - **In London** it stands where Piccadilly ends, its front on Piccadilly and Regent Street down its west side
    (docs/demo.md "London").
- **The big screens corner** (kind 117, `buildings/bigscreens.ts`) is the generic one for any city: the cinema ladder's
  fourth rung, unlocked by Landmarks (`cul5`).
  - It is a 2×2 corner block whose rounded corner of radius 0.62 turns from the front to the right side, with six
    screens.
  - There are two designs: modern grey with a sign blade, or terracotta with a copper dome over the corner.
  - It wants roads on its front and its right side.

### The demos

- **The showcase.** The big screens corner stands at the High Street's east end, on the corner with the perimeter road,
  its screens turned to the junction. The tour stop `big-screens` follows `high-street`, at 21:00, the camera round
  towards the curve.
- **London.** Piccadilly Circus is in the Landmarks section. Its tour stop follows the West End, at 21:30, from the
  front-left where the curve faces (a placement's `hour` and `aside`, docs/demo.md "The tour").
- **Seeding.** `server/src/demo/adverts.ts` rents turns 2 and 5 of every big screen in a demo to two of the town's
  campaigns ("Come and see …", "Five minutes from work in …"), kept and free. The tour therefore shows campaigns, house
  adverts and the news taking turns.
- **Features.** `advert-slots` now asks for every size including the screen. The new `advert-screens` asks for big
  screens with some, but not all, turns rented.

### Checks

- `buildings:check` section 12:
  - every slot record's facing agrees with its wall;
  - every design with screens has `AD.screenTurns` of them, and only landmarks and the big screens corner carry any;
  - Piccadilly Circus has six;
  - screens facing the back are refused, and so are screens off the bezel's facets.
- The adverts probe (`loadtest/adverts.ts`) section 9 places a big screens corner on a corner of a filled city and
  checks that:
  - its six screens are open;
  - "the nearest free frames" leaves them alone;
  - a screen rents at $40 and never wears;
  - the ring puts the campaign in its turn, house adverts in four, and the news in the last unrented one;
  - the ring is the same for every viewer and differs between buildings.

## Built: campaigns on planning applications, area claims and fly-posting (M6, 2026-11-11)

docs/multiplayer-land.md "Built: M6" has the whole of it. What it changed here:

- **The `plan` target.** `AdTarget.kind` may be `'plan'`, with `id` the planning application. Such a campaign is made
  by `Adverts.createPlan` (sim/campaigns.ts checks the stake and the guards first), and its `claim` indexes
  `PLAN_CLAIMS` (shared/src/campaigns.ts), not `AD_CLAIMS`. Its posters rent, wear, draw and pay rent like any
  campaign's. They need no Advertising tech, and their rent counts against the plan's spending cap (`planRent`). The
  campaign ends, and its posters come down, when the application closes.
- **Reach, for plan campaigns only.** Section 4 (A4) is still not built for ordinary campaigns. Plan campaigns reach
  the frozen roll once a game hour through `Adverts.postersOf`:
  - a poster within 2 tiles of a voter's home or commute;
  - its size's strength × the condition from its wear (a wrecked poster backfires);
  - freshness, susceptibility, the value weight and contrarians as in section 4;
  - plus TV spots on the city channels, with no studio yet.
- **Area claims.** Four rows join `AD_CLAIMS` with a value kind (`kind`, `high`, `good`): "{place} is up-and-coming",
  "{place} is noisy", "{place} reeks" and "Leafy {place}".
  - An area claim may name another owner's parcel, but only if it is true when posted: Adverts asks
    `areaTruth`, the M1 field's mean of that kind over the parcel.
  - It is checked again hourly. Once false, it is taken down and its maker fined $500, paid to the land's owner.
  - Its posters build the parcel's reputation, which `homeScore` reads for a while.
  - The client's claim picker still offers only your own parcels.
- **Fly-posting** (section 7), as the intent `adFlyPost` with no button yet. You post one of your campaigns over
  someone else's poster for $40, at most 3 a day. The rental keeps the renter's campaign underneath (`o`); the renter
  keeps paying the rent, and the fly-poster gets the reach. A fly-post is found with chance 0.2 a game hour, and then
  the renter's poster shows again. Found over a planning poster during its notice, it costs the fly-poster
  credibility. There is no "older than a day" rule, and no "No fly-posting" parcel setting yet.
