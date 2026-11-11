# Utilities: power, water, sewerage, gas, broadband and mobile

**Phase 1 is being built on branch `utilities-1`: the common framework and electric.** Water and sewerage, mobile,
internet and gas follow in that order. Sections marked **(built)** describe what this branch does; the rest is the
design the later phases follow.

UTD cards: "utilities" (191430bc) and its subtasks electric (91ed25ec), water, gas, internet and mobile. The older
"Utilities as coverage networks" card (74d9e42e, docs/feature-gaps.md card 10, docs/structures.md E10) is the same idea.
The concept notes were the card's three "Utilities overview" comments and the per-utility notes on each subtask. This
file replaces them and is corrected against the code as it stood at main 38272ae.

Rich's answers (2026-10-20):

1. **a, hybrid.** You place plants and local nodes. Coverage spreads along the roads by a BFS from each node, and a few
   trunk links are drawn as pylons or buried cable.
2. **a.** Level 1 needs nothing. Power and water from level 2, sewerage from 3, broadband for offices from 3.
3. **a.** Your own networks, plus an expensive grid import at a motorway connection, plus contracts to sell to
   neighbours.
4. **b, full drama.** Faults, storms that black out districts, and gas explosions that destroy buildings. Gas will use
   `Fires.explode([x, y], { cause: 'gas', level: true })` (server/src/sim/fires.ts), which exists. There is no weather
   system yet: storms get a hook (section 7) and a card of their own.
5. **a.** Electric, then water and sewerage, mobile, internet, gas.

## 1. How a utility reaches a building

Three models were weighed: pure coverage (place a plant and radius buildings), visible networks (drag a pipe or cable
under every street) and a hybrid. The hybrid won (answer 1):

- **The streets are the distribution network**, as in Britain: every road tile carries water, sewer, gas,
  low-voltage cable and ducts under the pavement. Supply from a node spreads **along roads** within its reach, by a
  breadth-first search over road tiles. Mobile is the exception: radio uses a straight-line radius.
- **Players only draw trunks:** plant to substation, works to water tower. A city has tens of these, not thousands.
- **The tick cost is bounded.** Reach is re-derived only when a road or a node changes, and supply against demand is
  solved per network once a game hour.

What the hybrid does not do: per-tile flow, pressure or pipe sizes. A network has a capacity and a demand.

## 2. Kinds and ids (built for power)

All 16 family codes are taken (docs/sub-kinds.md), so utilities are sub-kinds. They take **family 15** (`Zone.Hub`, the
transport hubs' family), which is already a grab-bag of placed infrastructure: the server checks `Zone.Hub` in only
two places, both by exact kind id. The catalogue gets a new `family: 'utility'` (schema.ts `Family`).

**Ids.** The concept notes proposed 101–149. That block is taken: 101–108 are education, 111–114 the London universities,
116–117 Piccadilly and the big screens, 120 the pioneer camp and 130–132 the media centre. Ids 29–39 are reserved for
boats and transport (docs/boats.md), 109–115 for education, and 133–139 are left for the media centre's later phases.
Utilities take **160–209**:

| Ids | Utility |
| --- | --- |
| 160–171 | power (phase 1 uses 160–166) |
| 172–181 | water and sewerage |
| 182–187 | gas |
| 188–192 | internet |
| 193–198 | mobile |
| 199–209 | London utility landmarks (Battersea, Bankside, the gasholders, Abbey Mills, the BT Tower) |

They are ordinary placed civic workplaces: sites, builders, staff, upkeep and an occupation each. Each has
attributes the game reads, flattened per kind id in `shared/src/utilities.ts` the way `serviceRadius` is read in
`shared/src/tiers.ts`:

| Attribute | Meaning |
| --- | --- |
| `utility` | which network: `'power'` (later `'water'`, `'sewer'`, `'gas'`, `'broadband'`, `'mobile'`) |
| `supply` | a plant's output in units an hour, at full staff and full availability |
| `nodeRadius` | a node's reach in road steps from its door |
| `nodeCapacity` | the most a node passes on to its patch, in units an hour |
| `importCap` | a node that can take grid import: the most it brings in, in units an hour |
| `pollution` | a plant's pollution, 0-10 (a hook for the derived-fields card bbe84771) |
| `fuel` | a thermal plant's fuel cost per unit generated |
| `availability` | `'steady'`, `'sun'` (solar) or `'wind'` |
| `crews` | a depot: its staff drive repair vans |

## 3. The common model

### 3.1 Reach (built)

`utilityReach(node, env)` in `shared/src/utilities.ts` is pure and runs identically on the server and the client from
the same tiles (the `planPlatform` pattern), so **reach never goes on the wire**.

- The search starts from the road tiles beside a node's door and walks road tiles in a fixed order (east, west, south,
  north) up to `nodeRadius` steps (12 for a substation, 16 for a grid supply point).
- It walks only roads on the node owner's own parcels and unowned (public) roads, never another player's streets.
  Each player runs their own networks (answer 3).
- A building is covered when a road tile beside its door is in a node's reach. Where two nodes of one owner reach the
  same road tile, the nearer one serves it, and on a tie the lower door key wins, so both sides agree.
- `UtilityField` caches the result per chunk, per owner: for every road tile, the serving node and its distance.
  It is rebuilt only when a chunk's road or node signature changes (a hash of the road bits and utility kinds over its
  1,024 tiles). Construction progress, which rewrites tile words all the time, does not change it.

### 3.2 Networks (built)

A network is a connected set of an owner's nodes and plants:

- two nodes are joined when their reaches share a road tile (the streets carry low voltage between them);
- a plant is joined to a node whose reach takes in the road beside the plant's door;
- a trunk link joins its two ends directly (section 4.2), so a plant out in the fields can feed a town;
- a faulted node or link is left out until it is repaired, so a fault can island part of a network.

Without links this is the "model A fallback" the notes asked for: plants and nodes on one street grid are one network.

### 3.3 Supply and demand, once a game hour (built)

- **Demand** of a covered building, in units an hour: `(occupants + 0.1 × capacity) × rate[family] × level factor ×
  curve[hour]`. Rates per resident or job: homes 0.1, shops 0.2, offices 0.15, works 0.4, civic buildings 0.15. The
  level factor is 0.6 at level 1, 1 at level 2 and 0.15 more for each level above.
- **The power curve:** 0.5 overnight, about 1.0 by day, the evening peak of 1.4 from 17:00 to 20:00.
- **Supply** is the network's plants, each at `supply × staffing × availability`. Staffing is the share of half the
  staff on the payroll (a plant runs at full output with half its staff), and a mothballed plant makes nothing.
  Availability is 1 for steady plants, the sun's elevation for solar (the same curve the sky uses) and a slow hashed
  "wind" signal for wind.
- **Grid import** tops up a shortfall after the network's own plants, up to the import cap (section 4.3).
- **Node caps.** A node's own patch draws at most its `nodeCapacity`, so an overloaded substation browns out its own
  streets even when the plants have headroom.

The solver (`solveNetwork` in `shared/src/utilities.ts`, pure) takes `s = supply / demand` per network:

| s | State | What happens |
| --- | --- | --- |
| s ≥ 1 | **ok** | all well; a margin under 10% shows amber in the panel |
| 0.85 ≤ s < 1 | **brownout** | everything works, growth pauses in the network, lamps dim by 15% at night |
| s < 0.85 | **rolling cuts** | nodes are cut by priority until the rest are back to s ≥ 1 |

The cut order:

- a node whose patch has a hospital or a police station is **never cut** (its generator hums);
- the player can **protect** a node (its panel), which ranks it with them;
- at night (22:00–06:00) nodes whose patch is mostly workplaces go first; by day, mostly homes;
- within a class the order **rotates every hour** by a hash of the node and the hour, so the pain is shared.

A node cut, faulted or overloaded is off for the hour: its buildings have no power.

### 3.4 Effects

- **Growth (built).** Next to the level-3 coverage rule in `Simulation.growth`, a growth or merge to level 2 or above
  needs power: the building must be covered and its node supplied (ok, not browned out, cut or faulted). Level 1
  needs nothing, so day one is exactly as it was. The Commons (the system player) and sandboxes (test cities, demos)
  are on a notional public supply and are never gated, so the 2×2 test city grows as before and its tick cost is
  comparable. Later phases: level 3 also needs water and sewerage, offices broadband tier 2, merged kinds at level 4
  and up everything but gas.
- **The hint (built).** When a player's level-2 growth has been held back by power for a game hour, an advisor alert
  says why and points at Electrification and the substation. The rank card's "two-storey buildings" step says so too.
- **Decline (later).** After 5 days in rolling cuts (or 3 without water), a level 2+ building declines like a roadless
  one.
- **Happiness (later):** "power cut last night" −6, "no water" −12, "slow broadband" −2 to −4, "no signal" −3,
  "everything connected" +2, in `happinessParts` (sim/life.ts).
- **Workplaces (later):** a shop or office in a cut closes for the hour and a factory loses its shift's output.

### 3.5 Bills and costs (built)

- **Bills are income:** a new `LedgerCat` `'bills'` (protocol.ts). Every supplied building pays its units at the
  owner's tariff, collected hourly. The tariff is $0.06 a unit by default, the same as grid import, so imported power
  breaks even and your own (a gas plant's fuel is $0.02 a unit) earns; a tariff slider (0.5× to 2×) is a hook.
- **Fuel and import are spending:** a new `LedgerCat` `'fuel'` for thermal plants' fuel per unit generated and grid
  import per unit imported.
- Both count in the "days in the black" sum (`running`, server goals.ts), as taxes and wages do.
- Upkeep is per plant, node and depot, from the catalogue (`CIVIC_UPKEEP`), as for every civic building.

## 4. Electric (built in phase 1)

### 4.1 Kinds

All are family 15, `family: 'utility'`, `utility: 'power'`. Two designs each.

| Id | Kind | Ladder | Size | Output | Staff | Cost / upkeep | Tech |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 160 | substation | grid 1 | 1×1 | node: 300 u, reach 12, import 300 | 2 | $900 / $15 | ut1 |
| 161 | grid supply point | grid 2 | 2×2 | node: 1,500 u, reach 16, import 1,500 | 6 | $6,000 / $90 | ut2 |
| 162 | power depot | grid 3 | 2×1 | crews: repair vans | 8 | $2,500 / $40 | ut2 |
| 163 | gas power station | power 3 | 3×3 | 1,200 u, fuel $0.02/u, pollution 3 | 24 | $8,000 / $180 | ut2 |
| 164 | coal power station | power 4 | 4×4 | 2,000 u, fuel $0.012/u, pollution 8 | 40 | $15,000 / $250 | ut2 |
| 165 | wind turbine | power 1 | 1×1 | 40 u × wind | 1 | $900 / $8 | ut3 |
| 166 | solar farm | power 2 | 2×2 | 100 u × daylight | 2 | $3,000 / $15 | ut3 |

Reserved for later: 167 hydro weir, 168 nuclear power station, 169 battery store, 170 pumped storage, 171 EV charging
hub. Pylons are not kinds: they are drawn along overhead links.

**Tech:** a seventh track, **Utilities** (tech.ts `TRACK_NAMES`):

| Node | Unlocks | Condition | Cost |
| --- | --- | --- | --- |
| ut1 Electrification | substation, grid import | 250 units built (it is ready before Masonry's 1,500) | $300 |
| ut2 Power stations | gas and coal power stations, grid supply point, power depot, pylons and buried cable | 150 housed | $900 |
| ut3 Renewables | wind turbine, solar farm | 200 jobs | $1,200 |

### 4.2 Trunk links

Two drag tools, **Pylons** and **Buried cable**, drag like railway track (one corner, `trackDragPath`): press on a
plant, a node or a motorway connection, release on another.

- **Overhead pylons:** $40 a tile. A lattice tower every 4 tiles, catenary between them. Spans pass over anything, and
  a tower that would stand on a building moves to the nearest clear tile of the run. Buildings within 2 tiles take a
  land-value hit once the land-value field exists (bbe84771); until then `PYLON_BLIGHT` and `pylonBlightAt` are the
  hook.
- **Buried cable:** $160 a tile, $400 under water. Nothing on the surface. Drawn in the underground view later (U7).
- Every tile of a link must be the owner's land or unowned land. Each end must touch (be on or beside) a power plant
  or node of the owner, or a motorway connection.
- Bulldozing a link: the bulldoze tool on any of its tiles while a link tool is picked removes the whole link; half
  the cost comes back.
- Links are stored in the snapshot as `utilities.links` and sent as `{ t: 'utilLinks' }` on hello and when they change.

### 4.3 Grid import

The National Grid comes in at a **motorway connection** (kind 21, a gateway). A network can import when:

- one of its nodes is within 64 road steps of a motorway connection's door (along the owner's and public roads), or
- a trunk link ends at a motorway connection.

Import costs **$0.06 a unit**, about 2.5× what a gas plant's units cost. The grid comes in where a node meets it and
runs through the network, so a network that reaches it can import up to the sum of its nodes' `importCap` (a
substation adds 300 u, a grid supply point 1,500): it is capped by tier, and each substation added raises the cap. It is
on by default: the first hour's crutch and the late game's insurance. The player can switch it off in a node's panel.

On a frontier the country road links the charter to the gate: a substation in town is about 25–35 road steps from it,
so a first substation can import at once.

### 4.4 Faults and repair crews

- **Faults** are deterministic, rolled each game hour from a hash of the node or link, the hour and the world seed, so
  demos replay. A node fails about once in 25 game days; a link about once per 40 tiles per game week. There are none
  in the first 7 game days of a world, none for an owner without Power stations (ut2: no depot to send a van from), and
  none in a sandbox (a demo's blackout drill aside, `Utilities.drills`).
- A fault cuts its node (or removes its link from the network) at once.
- **Repair vans** are a new fleet kind, `FleetKind.UtilityVan` (10; SchoolBus took 9). A power depot's lineworkers
  (40% of its staff) roll the road role. The nearest depot of the owner with a lineworker on shift sends a van; the
  fault is a door stop; the van works there for 2 game hours and the fault clears when it leaves. With no depot, or
  none that can reach it, a contractor clears it after 10 game hours.
- **The player is told** (playtest 37299b96: a substation failed, came back, and nothing said how). When a fault opens
  its owner gets a toast at once, "Substation fault at (x, y): its streets are dark." and what happens next (shared `faultAdvice`): with a depot,
  "Your power depot sends a repair van (about 2–3 hours); if none can come, a contractor fixes it in about 10 hours";
  with Power stations and no depot, the contractor's time and that a depot's van takes 2–3 hours; without Power
  stations, that a depot needs it. A fault also raises the advisor's general `fault` line (what faults are, who fixes
  them, "show me" the power depot; an alert, so it comes back only after a rest). The substation's panel (and a plant's or depot's on the same network) lists each
  fault with a **Repair** line, the contractor's hours counting down, or "a repair van is on its way" / "a repair crew
  is at work"; a building on its streets says the same under Power. When it is fixed: "Power restored at (x, y)
  after N hours: your repair van fixed it", or "a contractor fixed it" and what a depot would do.
- **A cut's length is a gameplay number:** depot distance plus traffic.
- **Weather (docs/weather.md W4):** `UTIL_WEATHER.faultMul(x, y, tick, overhead, seed)` multiplies the fault rate
  (×3 for overhead links in a storm, ×2 for nodes and buried cable, 1 otherwise; W6's big storms take it further) and
  `UTIL_WEATHER.windMul(tick, seed)` wind output (the weather's wind against the world's mean, up to 1.5×, 0 when gusts
  pass 40 tiles an hour: the turbines feather; `windAt` caps the product at 1). Every building's demand is × a temperature
  factor (+1.2% a degree under 14 C, at most +30%: electric heating; +2.5% a degree over 22 C, at most +30%: cooling), and
  each node's streets draw street lighting, 0.02 units an hour per road tile it serves in the dark (`UtilityField.served`;
  dusk and dawn shade it, thick fog lights it by day). Nobody is billed for the lamps: the network's owner pays for the
  units. `gasDemandMul` is the heating hook for a gas network.

### 4.5 The client

- **The power overlay** (the overlay menu and H): roads tinted by their node's state, green supplied, amber browned
  out, red cut or faulted, grey covered by an unpowered node; uncovered roads untinted. It reuses the congestion
  overlay's path (`ChunkView.setHeat`, `uHeat`) with a power palette, from the client's own reach and the hourly
  state.
- **Blackouts at night:** a per-tile power map (`uPowMap`, the same wrapped 1,024² texture scheme as the data overlay)
  is read by the window shader and the street-lamp shader. In a cut, lamps go out and windows drop to a candle share:
  a few flicker warm and a few buildings (6%, by hash) are on generators, bright and steady. In a brownout lamps dim by
  15%, steadily (a flicker read as a fault: playtest f91d8841), and a window dims with a slow breath. When power returns the area comes back block by block (4×4-tile blocks) over 20 to 60 s.
- **The wind turbine's rotor** (card c3a3e2b3, `client/src/render/rotors.ts`, numbers in `shared/src/rotors.ts`). The kit builds
  only the tower (a foot, a tapered white tower with a red band, a door on the road side, a service platform and a red
  aviation light in the `beacon` class); the nacelle, hub and three blades are an instanced pass, two draw calls for every
  turbine within 190 tiles (none, and the group hidden, when none is). The blades are thin extruded outlines, broad near the
  root and narrowing to the tip with a trailing edge bowed out and twisted about 16 degrees from root to tip, on a hub with a
  spinner. **What drives it:** a rotor turns while its plant is generating, at a speed the town's wind sets (`windAt`, the
  same signal the plant's output follows, from the world seed in the welcome and the game tick, 0.45 to 2.1 rad/s) times its
  own jitter of 0.9 to 1.1. Whether a plant generates is the additive `p` field of `utilState` (below). It winds up over about
  six seconds and winds down linearly to a stop over ten (`rotorStep`), so a plant cut off, mothballed, unstaffed, out of any
  network or with no demand to serve slows and stops; before the first `utilState` arrives every rotor turns on the wind alone.
  The nacelle yaws to the wind's heading (`windYaw`: hashed from the seed, eased every twelve game hours) plus its own offset
  of up to a quarter radian, following a change at its own pace (about 3 degrees a second at most). Per tower, from its tile:
  a start angle, the speed jitter, the heading offset and the pace; the state is kept by tile, so a chunk rebuild that
  places the tower again changes nothing and two rotors are never in step. `client/scripts/turbine-check.ts` runs the
  rules on a fake clock.
- **`utilState.p`** (additive, optional): `[x, y, percent, ...]` for every plant in a network, the share of its full rating
  it was asked for at the last hourly solve (`plantOut / supply`, 0 to 100). A plant in no network is absent. Older clients
  ignore it; nothing else reads it. Snapshot VERSION 8 is unchanged.
- **Pylons and cable:** `client/src/utilities.ts` draws each overhead link's towers (each with its own lean and paint
  fade, a bird on some spans) and the sagging wires between them, red while the link is faulted. Buried links show as a
  dashed red line while a link tool or the power overlay is on. A link drag shows green or red tiles and its cost.
- **The building panel:** `BuildingInfo.utilities` (section 5) for every building: what it gets, from which node, its
  bill; a node, plant or depot shows its network's supply, demand, state, import and faults.
- **The showcase:** a power district with a gas power station, two substations, a pylon run, a buried cable, a wind
  row and a depot, and tour stops for the plant, the pylons and a scripted blackout (section 4.7).

### 4.6 Underground view

The utility runs under the streets (section 6) are **not drawn in phase 1**. Drawing them is cheap only once the
underground view's chips exist (U7): one merged mesh per chunk per utility, built lazily from the client's reach.

### 4.7 The showcase

The **Power** section (shared/src/demo/showcase.ts) is open land west of districts B1 and C1, its two roads joining the
perimeter road at x = −35: a gas and a coal power station, a grid supply point by the road into town, three wind
turbines, a solar farm and a power depot. Two substations stand on lots of B1 and C1 by the perimeter road. A pylon line
runs from the coal station to the C1 substation and a buried cable from the solar farm to the B1 one (the seeder lays
them as the tools would, `demoUtilLinks`, into the save's `utilities.links`). Every six game hours the C1 substation
faults (`demoBlackouts`, `Utilities.drills`): its streets go dark, the depot's van drives round, and after its two hours
on site they light up again block by block. Tour stops: each plant and node, the pylon line, the buried cable and the
blackout (shown at 21:36). `SHOWCASE_FEATURES` has `power-plant`, `power-pylons`, `power-buried` and `power-blackout`.

### 4.8 Measured (utilities-1)

- **The probe** (`npx tsx packages/server/src/loadtest/utilities.ts`), 46 checks: reach walks roads only, to its radius,
  never along another player's street, the same whatever the node order; the solver's brownout at 0.85-1, cuts below,
  by night and day, rotating, never a hospital's or police station's patch; overloads, faults, import; a town gated
  until it has power and then supplied, with bills and fuel in the ledger; a frontier substation importing from the
  gate; a fault, the depot's van and its repair (2.9 game hours), the contractor (10 game hours); links laid, refused
  and taken down; bot F's first game day identical with the gate and without; determinism; old saves.
- **Tick cost** (`--bench`, the 2×2 test city with 16 substations and 4 gas plants, 4,421 citizens, 1,500 ticks):
  1.509 ms a step with utilities off and 1.499 ms with them on (two runs each), inside the run-to-run noise. The
  hourly solve takes about 1.45 ms, about 0.015 ms a tick amortised (1%).
- **Bot F** (`loadtest/utilities-ranks.ts`, frontier, seeds 1-12, three hours; botf.ts now buys Electrification with
  Masonry and puts a substation by each zoned block's connector road, bulldozing a lot if it must):

  | Rank | Before utilities (mean) | With the gate (mean) | Change |
  | --- | --- | --- | --- |
  | Hamlet | 19.1 min | 20.9 min | +9% |
  | Village | 43.6 min | 44.8 min | +3% |
  | Town | 96.5 min | 85.1 min | −12% |
  | City | 151.4 min (11 of 12 runs) | 124.8 min (12 of 12) | −18% |

  The first three ranks are within 15%. City comes 18% sooner, not later: lots the bot has not powered stay one
  storey and its builders build out new lots instead of raising old ones. With the bot's substations and no gate
  (POWER=1 GATE=0) City is 6% sooner, so most of that is the gate. The treasury's low is lower: $4,271 at the worst
  (seed 6) against $8,216 before; seed 1, which the ranks probe plays, keeps $6,045, over its $5,000 floor. Tried and
  dropped: a $3,500 cushion before each substation (no change) and two substations a block (Hamlet +17%, low $1,615).
- **Checks:** typecheck, buildings:check, demo:check, finance:check, the fires, ranks, adverts and media probes,
  rail-check, metro-check, boats-check and gesture-check pass.

## 5. Data and wire (built)

| | Stored | Derived | Wire |
| --- | --- | --- | --- |
| Plants, nodes, depots | tile, sub and aux bytes, as every placed kind | per-kind numbers from the catalogue | chunks, as now |
| Trunk links | `utilities.links` in the snapshot: `{ id, util, owner, mode, a, b, tiles }` | pylon spots, which nodes they join | `{ t: 'utilLinks', links }` on hello and on change |
| Coverage | nothing | `UtilityField`, on both sides | nothing |
| Network state | `utilities.faults`, `utilities.protect`, `utilities.noImport`, `utilities.tariff` | supply, demand and state per network and node | `{ t: 'utilState', h, n: [x, y, state, load%, …] }` once a game hour and on a fault |
| Tooltips | | `BuildingInfo.utilities` | with `describe()` |

- **Snapshot:** one optional `utilities` field. VERSION stays 8: older worlds load with no links, faults or settings,
  and a world with none saves without the field.
- **Local mode** stores the same snapshot, so it needs nothing (docs/local-mode.md).
- **States on the wire:** 0 ok, 1 brownout, 2 cut, 3 fault, 4 unpowered (a node in a network with no supply).
- **Contracts (hook):** `UtilitiesSave.contracts` and `ContractDTO` are declared and empty. A link crossing onto
  another player's land is refused until contracts land (U9).

## 6. The underground view (later, U7)

- **Depths:** fibre −0.10, gas −0.18, water −0.26, power −0.32, sewers −0.45 (brick egg-section, Bazalgette-style),
  deep trunk tunnels at −1.3 below the metro (`METRO_Y` −0.9).
- **Colours:** UK markings: water blue, gas yellow, power red, telecom grey, fibre green; sewers brown.
- **Distribution is drawn, not stored.** Under each covered road tile, a thin run per utility, each at its own depth and
  side. Trunk links are thicker, with joint bays every 6 tiles. Nodes are chambers.
- **Toggles:** chips beside **under**: `tube · water · sewer · gas · power · fibre`, each in localStorage. The view
  turns on by itself while a utility tool is picked.
- **Outages:** a dead section's runs go dark grey; a burst main pulses.
- **Roadworks:** laying a buried link or repairing a fault puts a works state on the road for a few hours: barriers, a
  trench, temporary lights, one lane closed.
- **The under byte is not used:** tunnels and platforms own it (docs/underground.md).

## 7. Hooks left in phase 1

| Hook | Where | For |
| --- | --- | --- |
| `UTIL_WEATHER.faultMul`, `windMul` | shared/src/utilities.ts | filled by docs/weather.md W4 (storm faults, wind output); W6 the big storms |
| `pylonBlightAt(x, y, links)` | shared/src/utilities.ts | land value (bbe84771) |
| `UtilitiesSave.contracts`, `ContractDTO` | shared/src/utilities.ts | selling to neighbours (U9) |
| `Utilities.tariff` per owner | server sim/utilities.ts | the tariff slider |
| `Utilities.supplied(b, util)` | server sim/utilities.ts | water, sewer and broadband gates |
| `UTIL_KINDS` by utility | shared/src/utilities.ts | the next networks reuse the field, solver and links |

## 8. Phases

| # | Phase | State |
| --- | --- | --- |
| U1 | Framework: the utility family and id block, `utilityReach`, the hourly solver, the growth gate, bills, tooltips, overlay, tech track | **built (utilities-1)** |
| U2 | Electric: plants, substations, grid import, overhead and buried links, faults and repair vans, blackout render | **built (utilities-1)** |
| U3 | Water and sewerage: works, towers, treatment, the decline rule | next |
| U4 | Mobile: masts, radius and capacity, rooftop cells | |
| U5 | Internet: exchanges, cabinets, tiers, the office gate | |
| U6 | Events: roadworks with temporary lights, storms (needs weather) | faults and crews built in U2 |
| U7 | Underground view: utility depths, chips, chambers, dark sections | |
| U8 | Gas and heat pumps; gas explosions via `Fires.explode` | |
| U9 | Interconnector contracts between players | hook only |
| U10 | London: Battersea, Bankside, the gasholders, Abbey Mills, the BT Tower, the Tideway | |

Each phase lands in the Showcase (`SHOWCASE_FEATURES`, shared/src/demo/showcase.ts) with tour stops.
