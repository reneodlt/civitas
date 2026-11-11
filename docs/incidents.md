# Incidents v1: house fires

Card c46399ac (docs/audit-2026-10.md section 8, card 3). Code: `server/src/sim/fires.ts` (the rules), `shared/src/fires.ts`
(tuning `FIRE`, the wire format `FireDTO`), `client/src/render/fires.ts` (the drawing), `server/src/loadtest/fires.ts`
(the probe). It builds on the fire family's size ladder (fire post, station, large station, headquarters,
`shared/src/buildings/civic-tiers.ts`) and on the priority vehicles the call-outs already used.

## What happens

1. **A fire starts.** Every built home and works (residential, commercial, industrial, office; not a block's garden, not
   a lot with builders on it) is rolled once a game hour, a slice of the built-building lists each tick, as the
   dispatcher rolls freight. The roll is a hash of the tile, the hour and the world seed, not `Math.random`, so a run is
   the same for a given world. The chance is `FIRE.perDay / 24` times the building's weight:
   - **density**: its level (a 1×1 lot), or a merged building's places over six (about six a level per lot);
   - **age**: `youngRisk` (0.4) for a new building, rising in a straight line to 1 over `matureDays` (10). Ages are kept
     only for buildings younger than that (saved); one first seen in the first game hour of an older world is mature;
   - **cover**: `coveredRisk` (0.6) in reach of a staffed fire engine (smoke alarms, inspections).

   At most `maxPerOwner` (2) fires burn at once in one owner's parcels and `maxWorld` (12) in the world.
2. **The engine turns out.** The nearest staffed fire building (in tiles, not by road) whose reach covers the fire, with
   an engine at home, sends it: reach is `FIRE.reach` (14 tiles, square, as service cover) or the station's own cover when
   that is wider. A post keeps one engine, a station two, the bigger rungs more (twice their call-out rate). The engine is
   the existing priority vehicle (blue lights, through red signals and round a roundabout without giving way) and pulls
   up at the door rather than looking for a space. Two things are new for an engine on a fire call (`Mover.call`; the
   routine call-outs and ambulances drive as before): it pulls out of its station into the forecourt and waits there for
   a gap instead of staying in the garage until the road has room (`sim/traffic.ts` enter), and **once traffic has
   stopped it for 8 ticks it drives on down the middle of the road** at 60% of a car's speed, out of the lanes, until it
   arrives (`Simulation.weave`). Without that, an engine in the 1×1 Commons at the evening peak waited up to four game
   hours to leave the garage. A fire next door
   (three tiles or less, too short a route to drive) gets the crew on foot five game minutes later. An engine lost on the
   way (despawned in a jam) is replaced from the next station in reach, three tries at most; a station that comes on
   shift later is asked every 25 ticks.
3. **The fire's course.** Unattended, the share burnt is `(t / burn) ^ growth`: slow while it smoulders, fast once it has
   spread (`growth` 2.5, `burn` a hashed 0.85-1.2 of `burnHours`, 4). When the engine parks the share is frozen (never
   under `minDamage`, 0.12: smoke and water) and the crew take `fightHours x (0.4 + share)` (`fightHours` 1.5) to put it
   out; the engine stays until then, drawn at the kerb of the road tile before the door with its lights on (`Fires.pullUp`;
   `Simulation.agents` shows a parked engine on a call), its hose playing on the building. Growth leaves a burning building alone (no upgrade, no merge into or out of it).
4. **Out.** Attended: the building loses `floor(level x share)` levels (a merged building never below its first level)
   and the owner pays `costShare` (0.5) of its book value (`parcelops.ts buildingValue`) times the share, filed as
   **Fire damage** (ledger category `fire`). Unattended: it burns out. A lot goes back to an empty lot of its zone, a
   merged building breaks back into lots (`World.removeStructure`), its people leave, and the owner pays `costShare` of
   the whole value. The lot regrows as any empty lot does.

Measured in the 1×1 Commons (probe, three seeds, 72 covered fires at all hours): engines arrive in 29-31 game minutes
on average, 57 at worst; every covered home kept its level (the bill is the 12% minimum), every uncovered one burnt out.

## Fairness in the first hour

The product goal is a fun entry-level city builder, and a fire must never punish a player who has not reached fire
services. Fire posts come with Emergency services (civ1: 20 housed, $400; the goal "Police and fire cover" asks for one).

- **The warning fire.** A player's first fire comes a hashed `warnMinHours` to `+ warnSpanHours` (3-9 game hours, a
  minute or three of real time per hour) after they first house `warnHoused` (12) people. It is always survivable: when no
  engine is in reach the neighbours' bucket chain has it under control at 15% burnt and puts it out over a game hour
  (buckets of water thrown at it from round the building), and either way it loses no level;
  the bill is small. It comes with the advisor hint `fire` (an alert: dismissible, it still shows after the tutorial is
  skipped) that names the fire post and Emergency services and offers the fire post tool.
- **The grace day.** Ordinary fires start in a player's parcels `graceDays` (1) after the warning fire, and only once the
  player has met Emergency services' condition (20 housed), so they could have bought it. A player who never buys it gets
  fires then; they have been told.
- **The Commons** burns from the start (`FIRE.commons`): its stations answer, and in the live world its badges stay hidden
  as all its issue badges do.
- Fires never start during a test city's or demo's fast fill, so the towns fill as before.

## What the player sees

- **On the building**: flames over the roof (5-9 tongues), soot rising and drifting downwind, an orange glow that carries
  at night, and a scorch on the ground. Following the organic-effects rule each tongue has its own height, width, flicker
  rate and phase, sway and place on the roof; each puff its own clock, rise, size, heading off the town's wind and wobble;
  each fire its own count of each and its own scorch outline, all from hashes. Size follows the fire's own course: it
  grows as it takes hold; under the hoses the flames die back and the smoke turns to pale steam; afterwards the ruin
  smoulders for `aftermathHours` (6) and the scorch fades (darkest where it burnt down). `client/src/render/fires.ts`,
  four instanced passes, one draw call each.
- **The engine** on the road in fire red with its lights, weaving down the crown of the road past a stopped queue, then
  parked at the kerb with its hose on the fire: a stream of drops arcing from the engine to the facade, each on its own
  clock and wobble (`FireDTO.hx, hy`). The bucket chain throws in bursts from three to five points round the building,
  each thrower on their own beat (`FireDTO.bk`).
- **The badge and the problems list**: code 7, **On fire** (a flame glyph, `shared/src/issues.ts`), set the moment the
  fire starts and cleared when it is out, not on the issues' quarter-hour round; it outranks every other code and is the
  first group in the problems panel. It floats a tile higher than the other badges, above the flames. It shows only while the fire burns (an hour or so), and a fire leaves no badge
  behind (a burnt-out lot is an empty zoned lot), so fires do not add to the badge flood.
- **The building's panel**: a Fire row ("On fire: the fire crew are on their way", "burnt out", "Fire damage: 1 level
  lost").
- **Toasts** for the owner when a fire starts (who is coming, or that nobody is) and, when it cost a level or the
  building or was the warning fire, when it is out (what was lost and the bill); a fire put out with nothing lost ends
  quietly (the badge clears, the bill is in the ledger). The warning fire's start is the advisor hint instead.

## Wire and save

- `{ t: 'fires', f: FireDTO[] }`: every fire burning, being put out or in its aftermath, broadcast whenever the list
  changes and sent on join. A fire: door `x, y`, seed `s`, phase `ph` (0 burning, 1 being put out, 2 out), `t0` and `burn`
  (ticks), `d` (share burnt when help came), `ta` (tick help came), `t1` (out, or will be), `eng` (an engine on its
  way), `out` (0 saved, 1 partial, 2 burnt out), footprint `w, h`. The client works out how far it has got from the clock.
- `BuildingInfo.fire`: the panel's words.
- Snapshot `fires` (optional, no version bump): the fires burning or in their aftermath, young buildings' ages (only
  those under `matureDays`), each player's warning (`warnAt`, `warned`). Engines are not saved; a loaded fire sends
  another.
- `FIRES=0` (index.ts) switches fires off on a server (an A/B control). A sandbox opt-out per owner is not built yet.

## The demo

The showcase's civic district has a fire drill: the level-3 house at (-29, -31), five tiles from the fire post at
(-24, -29), catches light again `drillGapHours` (0.6) after each drill fire is out, and costs nothing. Tour stop
**House fire** (after the fire post); the feature `house-fire` in `SHOWCASE_FEATURES`, whose seeded test checks the drill
home stands with a fire building in reach. `demoFireDrills(id)` reads the scenario's `house-fire` spots; index.ts hands
them to the Fires module.

## Fires v2: spread and explosions

Card eca21a7a, from Rich's note on the audit card: "Fires that aren't put out or at least attended to have increasing
chance over time of spreading to neighboring buildings. Fires at industrial locations have a chance of exothermic
explosions." Code: `sim/fires.ts` (`hourly`, `spreadTo`, `blast`, `neighbours`), tuning in `shared/src/fires.ts` (the
v2 block of `FIRE`), the drawing in `client/src/render/fires.ts` (`blast`).

1. **The hourly roll.** A fire rolls once a game hour, on the hour from when it lit (`next`, saved), with a hash of the
   tiles, the fire's id, the hour and the world seed. The warning fire and the demo's drills never roll.
2. **Spread.** Each building whose lot touches the burning one's (corners included) may catch. The chance an hour is
   `spreadMax` (0.3) x ramp x catch with no engine crew on scene (an engine still on its way counts as no crew); the ramp
   is `((u - 0.2) / 0.8) ^ 1.6` on u, the share of the fire's burn time gone: 0 in the first hour of a four-hour burn,
   about 6% at half time, 16% at three quarters, 30% near burn-out. Under a crew's hoses it is `spreadAttended` (1%)
   x catch. Catch (`catchByLevel`) is 0.7 for a level-1 lot (a detached cottage), 0.85, 1, 1.1, 1.2 at level 5, and 1.2
   for a merged building (a terrace, a block of flats, a works); a building touching only at a corner catches at half
   (`diagonal`). Roads, parks and empty lots hold no building, so a lot across a road (two tiles off) never catches: they
   are the firebreaks. An unattended level-3 fire with a lot on each side sets light to each with about a 45% chance
   before it burns out.
3. **Who pays.** A spread fire is the owner of the building it lands on: dispatched (the 14-tile rule), burnt and billed
   like any other, with a toast that says it came from next door. It is lit only when that owner could have a fire (the
   Commons always; a player after their warning fire and grace day, as `ownerBurns`).
4. **Caps.** Ordinary fires keep `maxPerOwner` (2) and `maxWorld` (12). A fire caught from another, or from a blast, may
   light up to `spreadPerOwner` (6) burning in that owner's parcels and `spreadWorld` (20) in the world; past them the
   catch is held back (`stats.capped`). A block can burn down in an uncovered town, a few lots at a time; the world never
   goes up.
5. **Explosions.** A burning industrial building (zone Industrial: the industrial lots, which include the waste and
   parcel depots, and the merged workshop row, warehouse, factory and heavy plant) rolls for a blast before it rolls to
   spread: `blastMax` (0.16) x `((u - 0.1) / 0.9) ^ 1.5` an hour unattended, `blastAttended` (1.5%) under a crew, once per
   fire. About a third of unattended works fires blow up. The blast:
   - wrecks the works: an unattended fire jumps to `blastDamage` (70%) burnt (its clock is wound on, so the client reads
     the jump), one being put out is held at 70% and the crew take longer;
   - sets light to every building whose lot is within `blastReach` (2) tiles, across a road too (spread caps and the
     fairness rule apply);
   - bills the owner `blastCostShare` (25%) of the works' book value under **Explosion damage** (ledger `blast`), on top
     of the fire's own bill;
   - tells the owner (a toast) and puts a line in their milestone feed (`Ranks.incident`, kind `incident`, ✸).
6. **Fairness.** The warning fire never spreads or blows up. A covered town rarely sees either: the engine is there in
   about half an hour, before the ramp has started.

### Explosions: one entry point for any cause

Every explosion goes through `Fires.explode([x, y], { cause, radius?, level?, costShare?, seed? })` (sim/fires.ts):
the works' hourly roll, the demo's blast drill, and later causes. The gas utility (card 968d0d2f, "full drama": gas
explosions destroy buildings) is meant to call it from its leak roll and needs no change here. The call works like this:

- `cause` picks the defaults in `BLAST_CAUSES` (shared/src/fires.ts) and the look in the client (`BLAST_LOOK`,
  render/fires.ts, keyed by `FireDTO.bc`). Each option passed overrides its default:
  - `radius`: every burnable building whose lot is within this many tiles catches light (2 for a works, 1 for gas);
  - `level`: true flattens the source there and then; false never does. Unset, the cause's `damage` decides: the share
    of the source wrecked there and then. That is 0.7 for a works, whose fire carries on from there, and 1 for gas, which
    levels the building. `level: false` on gas wrecks 0.7 instead. A levelled building is destroyed outright: it is cleared to an empty lot of its zone (a merged one breaks
    back into lots), its people leave, it is billed as burnt out under 'fire', and its aftermath (scorch, debris,
    smoke) is drawn over the empty lot;
  - `costShare`: the blast's own bill, a share of the source's book value under 'blast' (0.25 for a works, 0.5 for
    gas);
  - `seed`: the drawing's variation, when the blast starts the fire. Otherwise it is hashed from the tile and the tick.
- The building at (x, y), or the structure that tile belongs to, must be a home or works that can burn. One that is not
  burning catches light with the blast, quietly: the blast's own toast says what happened. A fire blows up at most once.
  Where no such building stands (a road, a civic building, a lot with builders on it), `explode` returns false and
  nothing happens.
- Neighbours light inside the spread caps and the fairness rule, as spread fires do, and are marked `from` 2. Each is
  dispatched to and billed like any other fire.
- The toast and the milestone feed line name the cause by its `label` ("Explosion", "Gas explosion"), with "destroyed"
  when `damage` is 1. The building's panel reads "Destroyed by a gas explosion".
- The look by cause:
  - a works: a warm white flash, a deep orange fireball, a tall black oily column, steel and rust debris;
  - gas: a blue-white flash, a yellower and bigger fireball, a shorter pale grey column, and more brick, timber and
    slate debris thrown further.

  A new cause adds an entry to `BLAST_CAUSES` (with the next `code`) and a row to `BLAST_LOOK`.

The gas card still has to decide the provisional gas numbers in `BLAST_CAUSES.gas`, and what makes gas leak and blow.
A blast with no building to anchor it (a main under a road) would need its own wire entry. Today a blast is drawn on the
fire it leaves (`FireDTO.bx`, `bc`).

### What the player sees

The fire itself is drawn as before. An explosion (`FireDTO.bx`, the tick it blew) adds a white-yellow flash, a ragged
shockwave ring racing out over the ground, a fireball of five to nine balls thrown out and up, cooling from yellow to
deep orange, a dark smoke column that punches up from the ruin and then rises four to eight tiles, leaning downwind, for
as long as the fire burns and fades through the aftermath, debris thrown on arcs that tumble and then lie where they fell
until the scorch fades, and a scorch twice as wide. Under the organic-effects rule every blast is its own: the flash's size, tint and
length, the ring's reach, speed, tint and front, the count of fireball balls and each one's heading, throw, rise and size,
the column's height and every puff's clock, place and size, the count of debris and each piece's heading (thrown more one
way than the others), distance, height, time in the air, size and colour, and the scorch's outline, all hashed from the
door and the tick. The flash, ring, fireball and debris flight run on the wall clock from when the client saw the blast
(a client that joins later sees the aftermath only). Two more instanced passes, one draw call each, drawn only while a
blast is in the list. The building's panel says how it caught ("On fire, caught from next door", "Blown up and on fire").

### Wire and save

`FireDTO.bx` and `bc` (optional; `bc` absent means a works). The saved fires carry `next`, `from`, `bx`, `blastCost`, `cause`, `levelled`, `hold` and `round`, all optional: a
save from before v2 loads, its fires take their next roll on the hour from when they lit. Snapshot version unchanged.
Ledger category `blast` ("Explosion damage", `LEDGER_LABELS`), milestone kind `incident`.

### The demo

Two staged drills, run only in a demo (`Fires.rows`, `Fires.blastDrills`, from the scenario's `fire-spread` and
`fire-blast` spots; index.ts):
- **Fire spreading** (tour stop after House fire): the four homes along the south edge of the civic district's
  north-west block, (-31, -31) to (-34, -31). The lead catches light with nobody called (`drillHoldHours`, 1.6 h); each
  house still burning with no crew on it lights the next `drillSpreadHours` (0.5 h, ten seconds at 1×) later, so the
  fire runs along the row, then the engines from the civic stations turn out and it stops where they get there. A new
  round `drillGapHours` after the row is out.
- **Explosion at the works** (tour stop after the industrial estate): the works at (-31, 27) catches light, blows
  `drillBlastHours` (0.6 h) later as a real blast does (everything within two tiles alight), and the district's fire
  station's engines turn out; again `drillBlastGapHours` (1.5 h) after its fires are out.

Drill fires cost nothing, roll for nothing, and never burn a building down: one the engines cannot reach in time is
saved by the bucket chain at 90% burnt. The features `fire-spread` and `fire-blast` in `SHOWCASE_FEATURES` check the row
stands as touching homes in a fire station's reach and the works has at least six buildings within the blast's reach.

## Deaths (docs/remembrance.md)

Since death and remembrance, fires kill. When a fire is out (or a building blows up), before the damage, `Fires.onHarm` gives
sim/death.ts the people inside: 18% each die when it burnt down with no crew, 12% × (share burnt when the crew came)² when
a crew put it out (about 0.2% when they come at once), 30% in a blast and 55% when it flattens the building. The warning
fire and the drills never kill, nor anything in a player's first hour. An incident's dead are one news story naming them.

## Checks

`npx tsx packages/server/src/loadtest/fires.ts [--seed 1] [--n 24]`: a 1×1 Commons with its fire station swapped for a
fire post, filled for a day. Covered homes (within 14 tiles of the staffed post), one at a time: each loses under half
its level, an engine arrives for each, the badge shows and clears, the ledger carries the bill. Uncovered homes burn
out and nobody is left in them. A save with a fire burning loads with it burning and sends an engine. A player's district
gets its warning fire 3-9 h after the threshold, saved with nothing lost with the post mothballed and staffed, and no
other fire in the grace day. A 2×2 Commons over two days has a few fires, and the same ones from the same seed.

## Measurements (2026-10-19)

- **Probe** (`loadtest/fires.ts`, seeds 1, 2, 3): 22/22 each. 72 covered fires at all hours: every home kept its level
  (the 12% minimum bill only), engines arrived in 29-31 game minutes on average, 57 at worst; 33 uncovered fires all
  burnt out with nobody left inside; the warning fire lit 4.6 and 6.6 h after the threshold and lost nothing, with the
  post mothballed and staffed; no other fire in the grace day; a 2×2 Commons had 2-10 fires in two days, the same ones
  on a second run.
- **Bot B** (the first-five gauntlet bot, `play.mts` with a fire log, SIM_STEPS=10, joining at 05:00): on a fresh
  Commons world its first fire (the warning) lit at day 0.83, 14 game hours after joining and 4 after it housed 12; the
  Commons' fire station sent its engine, there in 52 game minutes, 12% burnt, $2. On a fresh frontier it lit at day
  1.75 with no engine in reach (B had Emergency services but had not placed a station on $843); the bucket chain had it
  out at 15%, $2. One fire each in the three days; neither lost a level.
- **Tick cost** (2×2 test city, seed 1, `seedCity` built 3, 1.25 days' fill with fires off as index.ts fills, then
  2,400 measured ticks of `Game.step`; main 849a63b against the branch, interleaved at nice 15, four pairs): 4.141 ms
  against 4.133 ms median, **-0.2%** (pairs +0.1, +0.2, -3.1, +0.6%); `Fires.tick` itself 0.006 ms. Three fires lit in
  the measured day (two burnt out, one saved). An earlier build that let every vehicle on blue lights weave (call-outs
  and ambulances too) measured +6%; weaving is now for fire calls only, and the call step sits outside the ordinary
  drive step so vehicles keep one shape.

## Measurements, v2 (2026-10-20)

- **Probe** (`loadtest/fires.ts`, seeds 1, 2, 3): 38/38 each (sections 1-4 as before). 5e (`explode`): a gas blast destroyed a home and lit all 4 burnable buildings touching it, $65 under `blast`; nothing happened on a road; a works blew on demand, once.
  - Uncovered town (5a), every fire building mothballed, hand-lit one at a time: 18, 15 and 20 fires lit. From these, 44, 45 and 36 spread fires, with 11-14 of the hand-lit fires setting light to a neighbour.
  - Every spread fire touched a lot that was burning when it caught.
  - 7, 7 and 1 explosions, all at works, setting 19, 24 and 4 alight. They cost $288, $324 and $54 under `blast`.
  - At most 6 fires burned at once (the per-owner spread cap; the Commons is one owner). Catches held back by the caps: 29, 26 and 3.
  - Warning fires (5b): 9-10 lit unattended in the same town, with 0 spread and 0 explosions.
  - A fire saved without the v2 fields loads, rolls on the hour and can blow up. A blast tick survives a save and load.
  - The same fires, spreads and blasts come at the same ticks on a second run.
  - Covered town (5d), 23-24 hand-lit fires within reach of the staffed post: 0, 0 and 2 spread, with no explosions.
- **The 2×2 Commons over two days** (section 4) changes with spread where it has gaps in cover:
  - seed 3 had 23 fires (18 burnt out), against 10 (2 burnt out) on main;
  - seeds 1 and 2 had 2 and 7 fires, as before.
- **Tick cost** (2×2 test city, seed 1, `seedCity` built 3, 1.25 days' fill with fires off, then 2,400 measured ticks of `Game.step`; main ee47163 against the branch, interleaved at nice 15, six pairs):
  - 2.094 ms against 2.068 ms, the median of each side's medians, which is **-1.2%**. The pairs were -2.0, -9.7, +4.8, -2.4, -2.1 and +3.5%: noise.
  - `Fires.tick` itself took 0.0143 ms against 0.0113 ms.
  - The branch lit 8 fires in the measured day (5 of them spread), and main lit 3.

## Severe weather (docs/weather.md W6)

Storms and floods are incidents by place, not by player, and come with a warning a game day ahead (a toast to the mayors
with land in the way, a news story, the TV and teletext, a ⚠ on the weather chip). Code: `server/src/sim/severe.ts`,
`shared/src/severe.ts`; check `npm run severe:check`.

- **Fallen trees.** In a storm, road tiles beside parks and wild trees may have a tree come down across them (hashed by
  tile, hour and seed; at most 12 at once). The tile is closed: `Traffic.closures`, priced out of every route
  (`CLOSED_COST`), drawn as a trunk with barriers. A road crew (a builder on shift at the nearest builders' yard, in a
  hi-vis van) clears it 45 game minutes after it gets there; a contractor after 8 game hours if none comes.
- **Floods.** After days of heavy rain the river level rises; low land by the water (the Flood risk overlay) floods for
  hours from the water's edge: roads close, a flooded home's people stay in, flooded shops and works shut. Each flooded
  building's owner pays 8% of its book value once a flood ("Flood damage"); a flood never takes a level or demolishes,
  and an owner away 3 days or more pays nothing. Flood walls (the Flood wall tool) hold the water back behind a
  continuous line until the river is 85% up.
- **Line faults.** Overhead lines fault three times as often in a storm (W4, `docs/utilities.md` 4.4); the repair vans
  work as before.
- **Insurance**: a hook only (`floodInsured`, false for everyone).
