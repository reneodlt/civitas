# Roads: the tool, street names and the Commons

The roads programme (UTD card 5c3e5cd0) rebuilds roads in phases: R1 the look (render/), R2 the tools (this page),
R3 classes, R4 junctions, R5 traffic control. This page is R2 (what the road tool does, how streets are named, and
how the Commons is laid out), R3 ("Classes") and R4 ("Junctions"). The code is `shared/src/roadtool.ts` (the plan both sides use), `shared/src/streets.ts`
(the name generator), `client/src/input.ts` and `client/src/roadtool.ts` (the drag and its preview),
`server/src/net.ts` (`road`, `undoRoad`, `renameStreet`), `server/src/streets.ts` (the street book) and
`server/src/seed.ts` (the Commons).

## The road tool

**One drag, sent on release.** Press with the road tool (3) and drag: the road is drawn as a ghost from the press to
the cursor, and nothing is built until the button comes up. Esc lets go of the drag and keeps the tool (a second Esc
goes back to select, as ever).

**Shapes.** A drag is straight, or turns one corner like railway track: it runs first along the way the drag first
left the start, then along the other axis, so drawing east then turning south gives that L. Holding **Shift during the
drag** makes it a loop: the four sides of the rectangle between the press and the cursor. Shift held at the press
still pans, as it does with every tool (the controls scheme is unchanged). A drag is at most 256 tiles.

**Snapping.** When a drag stops one tile short of a road (the next tile along is bare dry land and the one after is
road) it gains that tile and meets the road.

**The ghost** is planned by `planRoad` on the loaded chunks, the same function the server lays with. Each tile is
coloured by what it will be: new road (pale blue; lilac on unclaimed land, which costs the public premium), road
already there (faint), an upgrade to another class (green), a bridge deck (blue), a building in the way (amber) or
refused (red). A chip at the end of the drag gives the running cost, the tiles and how many are on unclaimed land
("$340 · 17 tiles · 3 on unclaimed land: public road, you pay its $1.50/day upkeep"; public road is its builder's to
pay for and fades unused, docs/multiplayer-land.md "Built: M3 roads"), the block depth (below), the buildings in the way, and the first reason
anything is refused: another owner's land, water without Civil engineering or a bridge that cannot reach the far bank,
a runway, junction or multi-tile structure (bulldoze it first), a level crossing on curved track, a road joining a
bridge from the side, or not enough money (in drag order: once the money runs out, the rest is refused). The status
line says the same. Refused tiles are left out and the rest is built; the server toasts the first reason.

**Buildings in the way** (card a0902fd7). A building standing on a tile (homes, shops, works, civic buildings, parks,
car parks, bus stops: anything at level 1 or more) or a civic building still being built (the player paid for it)
is not paved over silently any more. On release the client asks, with the cost: **Demolish and build** (the road plus
the $5 demolition fee per built tile, nothing refunded), **Build round them** (those tiles are left out), or
**Cancel**. One answer covers the whole drag. The intent carries `demolish: true` only after a yes; without it the
server goes round, so no client can demolish by accident. An empty zoned lot and a growth site are paved over as
before; a multi-tile structure is refused as before (bulldoze it first).

**The spacing guide.** While dragging, the straight stretch being drawn looks sideways up to 12 tiles for a road
running alongside it (at least two tiles of it). When it finds one, the chip says the depth of the block between them
("block 4 deep") and two faint lines mark where the next roads would make blocks of the same depth on the other side.
It is a hint, not a snap: there is no default block size.

**Undo.** Ctrl+Z (Cmd+Z on a Mac) with the road tool takes back the player's last road drag within 30 seconds
(`ROAD_UNDO_MS`, real time) while it is still bare road: no tile bulldozed or given a junction since, its bridges
still standing, and nothing gone up beside it since (a site or a building on a tile next to it that was not there
when it was laid). The tiles go back to what they were (an empty lot stays zoned; a building the drag demolished
stays down) and the road and bridges are refunded; the demolition fee is not. The toast says what was undone
("Undone: 17 tiles of road, $170 back"). One level: the last drag only, kept in memory, not saved.

**Classes and upgrade in place.** The intent and the plan carry a class (`cls`); the road tool lays the class picked
in its class picker, and a drag over road of another class upgrades it in place (see "Classes" below).

## Classes

R3 (card 26c5cb9a). Six classes, Rich's choice (answer 3a on the programme card): **country lane, street, one-way
street, avenue, motorway, pedestrian street**. The code is `shared/src/roadclass.ts` (the table, the byte, the rules a
car follows, the junction flag, the twin row of a divided road), the plan in `shared/src/roadtool.ts`, laying and
upgrading in `server/src/net.ts` and `World.setRoadClass`, the routers in `server/src/pathfinding.ts` and
`sim/busroute.ts`, lanes and speed in `server/src/sim/traffic.ts`, the picker in `client/src/roadpicker.ts` and the
drawing in `client/src/render/roads.ts` and `roadGeo.ts`.

| Class | Lanes | Speed | Holds (cars a tile) | Access | Cost a tile | Upkeep a day | Technology |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Country lane | one each way, no centre line | 80% | 2 each way | all | $5 | $0.25 | none |
| Street | one each way | 100% | 2 each way | all | $10 | $0.50 | none |
| One-way street | two, one way | 100% | 4 | all | $12 | $0.50 | One-way streets (Transport 2, $350, 80 housed) |
| Avenue | two each way, 2 tiles wide | 100% | 4 each way | all | $25 (two tiles a length) | $1 | Avenues (Transport 3, $1,000, 160 housed) |
| Motorway | two each way, 2 tiles wide | 250% | 4 each way | no frontage; slip roads | $40 (two tiles a length) | $2 | Motorways (Transport 4, $2,500, 200 jobs) |
| Pedestrian street | none (paving) | 40% (service vehicles) | - | walkers, bikes, emergencies, deliveries before 10:00 and after 19:00 | $15 | $0.75 | Pedestrian streets (Culture 2, $500, 90 housed) |

Unclaimed land adds the public premium ($10 a tile) to any class. Upgrading charges the difference; a downgrade is free
and refunds nothing. Upkeep is charged with the parcel's roads each midnight at each tile's class (`World.roadUpkeepOf`;
a parcel of streets pays exactly what it did). The technology costs sit with their neighbours: One-way streets beside
Traffic signals (tier 2), Avenues beside Junction design and Public works (tier 3), Motorways beside Harbours (tier 4),
Pedestrian streets with the second culture tier. Bot F buys none of them, so its first hours are unchanged.

**The byte.** A class lives in the low range of the tile's aux byte, `cls | dir << 3 | junction << 5`
(docs/aux-layer.md). The street has no byte, so every road laid before R3 is a street, old saves load unchanged and the
snapshot version stays 8. A bridge deck, a level crossing, a roundabout ring and a flyover keep their own bytes and are
streets: a class drag over one leaves it as it is, and the classes on either side carry on through it (a one-way's
direction is held by the one-way tiles round a crossing). The byte travels in the chunk messages and aux deltas the aux
layer already sends.

**Why the avenue is two tiles.** A tile is about 13 m and a car 0.18 of a tile wide (the client draws it at exactly
that); a street's two lanes sit 0.19 either side of its centre. Four lanes and a reservation in one tile would need
about 0.74 of a tile of carriageway: lanes half as wide as a street's, cars almost touching side by side, no room for a
planted strip, and the walkers pushed to the tile's edge. A one-way tile with two lanes uses the street's own two lane
positions, so the avenue is a pair of one-way tiles, two lanes each, with the reservation on their shared edge
(SimCity 4's avenue, and docs/structures.md's original plan); the motorway is the same pair with no frontage. The one
multi-lane piece the traffic model needs is "a one-way tile with two lanes", which the one-way street needs anyway. The
cost: an avenue dragged along a street needs the row beside it (the tool asks before demolishing what stands there).

**Laying.** The drag's direction is the traffic's on a one-way street; dragging one the other way reverses it, for
nothing. A divided class (avenue, motorway) lays the drag's row going the drag's way and its twin one step to the
drag's left going the other way (traffic keeps right), round corners and loops too (`twinRow`); the two rows go in
together or not at all (a tile refused, or a building left standing, takes its partner with it). Across water or a
railway a divided class is refused (two-tile bridges are a follow-up): lay a street over the bridge or crossing. A
motorway is refused where a building stands beside it, except its motorway connection. Dragged across a one-way or
divided road, a drag keeps that road's tile (a crossing, not a downgrade); a pedestrian drag keeps any road crossing
it. A street crossing a one-way street, an avenue crossing a street, and an avenue crossing an avenue all make
junctions as you would expect.

**One crossing, not two.** A street crossing an avenue is two junction tiles one tile apart (four where avenues cross),
and they are one junction (R4's junction group, `shared/src/signals.ts` junctionGroup: see "Junctions" below): lit or
not by the arms of the whole crossing (a street over an avenue is a crossroads), one controller whose timing is the
crossing's north-west tile's, so the crossing street gets one green through both halves; a car going from one of its
tiles to another is already through the lights. The server (`Traffic.junction`), the lights (`render/signals.ts`), the
markings and the yellow box (`render/roads.ts`, one box over the crossing's tiles) all read it. A street meeting an avenue from one side makes both carriageways' tiles the
junction, so a car turning across goes through one junction. Measured: one controller took the avenue grid's give-ups
from 508 to 436, level with the doubled streets it replaced (docs/traffic-tuning.md "Road classes").

**The pair stays a pair.** One drag lays both rows, the ghost shows both with their arrows, and a street upgraded to
an avenue asks once, with the cost, about the buildings in the row beside it (R2's rule; one answer for the drag).
Dragged back along itself the other way, an avenue is road already, not a third carriageway (`planRoad` reads the drag
the way the traffic goes). Bulldozing a tile of one carriageway, or dragging another class over it, leaves the tile
of the other a one-way street going its own way (`World.orphanTwin`), so no half-avenue is left; the tiles either side
of the gap become the ends' junction tiles. The tooltip names the avenue once: the step across the reservation is no
street of its own.

**The junction flag.** An avenue or motorway tile is a junction tile where a road crosses or joins it from the side
(not its twin), where it turns a corner, and where it or its twin ends. A junction tile has no direction of its own:
cars cross the reservation and turn round only there. Streets meet a motorway by slips: a street beside a motorway does
not make it a junction, so there is no crossing; only another motorway does. The flag is a pure function of the 3×3
round the tile, kept by the server round every road change (`World.refreshRoadFlags`).

**Driving.** `carStepOk` is the rule every car router follows (A*, the bus router, a driver's re-route): never out of
or into a one-way tile against its direction, never across a divided road's reservation between two tiles that both
have a direction, never onto a pedestrian street unless the vehicle is an emergency on a call or a delivery lorry out
of shop hours (`pedestrianDeliveryOpen`), and no building's way on or off the road is a motorway but the motorway
connection's (`World.hasRoadAccess` ignores motorways, so lots beside one do not grow from it). Walkers never walk along
a motorway; they walk anywhere else, pedestrian streets included. A driver whose way ahead a class change breaks finds
another (`Simulation.recheckClasses`).

**Lanes.** A one-way tile (one-way street, avenue, motorway carriageway) has two lanes, at the street's two lane
positions; every other edge has one, the right-hand one, so a world of streets runs exactly as before. Each car crosses
each tile edge in one lane of it (a strand: `Mover.s0`, `s1`, `s2`): it takes the lane for its next turn within six
tiles (left turns the left lane, right turns the right), keeps the lane it is in going straight, and coming off a
single lane takes one by its own hash so traffic spreads. A car follows the car ahead in its own lane, a lane fills on
its own (`laneCap` each), and a lane change eases across a tile and goes through the box check at its stop line like a
turn; the conflict tables gained the strands (the all-zero entries are the old tables). Where an avenue is crossed, a
car going over the reservation may wait in the first carriageway for a gap in the second, but not while a car crossing
the other way is in that box heading for its own (`Traffic.overMedian`: without it the two would wait for each other
for ever). A car joining a motorway from a street gives way to motorway traffic within two tiles (`SLIP_GAP`), lights or
none, and there are no signals on motorway tiles. The class sets the speed of the tile a car is on and the route cost
(the avenue 0.9 of a street, the motorway 0.5, the lane 1.2); A* scales its distance estimate by the cheapest class in
the world (`World.minRouteCost`), so it stays exact. `Traffic.roadRank` is the class's rank (motorway 4, avenue 3,
street and one-way 2, lane 1, pedestrian 0): with `TRAFFIC_TUNING.mainRoad` on, a bigger road's arms are the main road.

**Showing it.** The road tool (3) opens the class picker beside the tool bar, a card per class with its cross-section,
lanes, speed, cost, upkeep and the technology it needs (a locked class greyed with the technology named); the last
class picked is remembered. The ghost is in the class's colour with an arrow on every one-way tile, the chip and the
status line name the class, and a drag over road of another class shows as an upgrade. The road tooltip and a
building's address name the class ("Mill Lane, one-way street, northbound"; "12 Kingsway, avenue"). Streets on
an avenue are Avenues, on a country lane Lanes, on a pedestrian street Walks or Rows, and an avenue's two carriageways
are one street (renaming one renames both).

**Footfall.** A pedestrian street's shops see the most passers-by; the bonus itself is left for the leisure and
commerce work: `isPedestrianAux` on the shop's road tile is the hook, and walkers already walk along pedestrian
streets.

**Showcase.** The "Road classes" section (west of district A1, `ROAD_CLASSES_LAND`): Cheapside, a pedestrian street of
shops that Market Street ends at; North and South Parade, a one-way pair round a block of homes; Kingsway, an avenue
through offices and homes crossed by Market Street (y -26 and -25 since R4, with its 5×5 roundabout at Crown Street);
a motorway from a motorway connection of its own that Market Street crosses at a diamond interchange (R4; it was a slip
road); Hedge Lane, a country lane out to the edge (since R4 from Queen's Avenue, on the junctions' land south of the
section). A tour stop each, and five registered features (`road-class-*`) that demo:check enforces.

## Junctions

R4 (card d5da6ea9). What a junction is to the traffic and the tools beyond the give-way box, the lights, the 3×3
roundabout and the flyover. The code: `shared/src/signals.ts` (junction groups, their phases, signal crossings),
`shared/src/junctions.ts` (the mini-roundabout, the 5×5 roundabout and the diamond interchange: bytes and planners;
where a turn sign or a crossing may go), `shared/src/roadrules.ts` (the road rule record), `server/src/sim/traffic.ts`
(the rules a car follows), `server/src/pathfinding.ts`, `sim/busroute.ts` and `sim/transit.ts` (routing round turn
bans), `server/src/net.ts` (the tools), `World.roadRules` (the store) and `client/src/junctiontools.ts` (the ghost).

**Avenue crossings work as one junction.** Where an avenue (or a motorway) is crossed or joined, the crossing is two
junction tiles (an avenue and a street, a T on an avenue) or four (an avenue and an avenue). `junctionGroup` finds them:
the 4-connected divided-road tiles with three or more arms, in a 1×2 or 2×2 box (anything bigger, and every other
junction, is a group of one, exactly as before). A group has one controller: its timing is seeded from its **anchor**
(the min x, min y tile), its lights gate only cars coming into the group from outside it, and a move between two of its
tiles answers only to the box rules. Two phases at an avenue × street (as every junction: north-south, then east-west,
each ending in amber; lefts go on the green and give way). Four at an avenue × avenue, with **protected left turns**:
north-south straight on and right, then north-south lefts and U-turns on their own (`leftPhase` of a through phase,
half by default), then east-west the same. Walkers cross only in the through phases. The groups along an avenue run a
**green wave** (`TRAFFIC_TUNING.greenWave` 2, the default: their offsets timed for `waveSpeed` along the diagonal, as R0's
wave; every single junction keeps its own timing, so a town of streets runs as before). The server
(`Traffic.signalPhase`) and the client draw from the same `groupTiming` and `groupPhaseOf`, so the lamps match. Signals
at a T (`signalT`) and the hold rule (`signalActuated`, two-phase groups only) carry over; the junction where an
interchange's slips meet its street never has lights (`slipJunction`).

**Turn lanes.** On a one-way approach (an avenue's carriageway, a one-way street; not a motorway, where nobody turns
left) to a four-phase group, where the lefts have a phase of their own, the last two tiles before the junction hold the
lane: the left lane for left turns and U-turns only, the right for straight on and right turns; the lane changes happen
on the tile before (`TRAFFIC_TUNING.turnLanes` 2, the default). Approaching any other junction a car takes the lane for
its next turn within six tiles and goes straight on in either, as in R3 (the arrows read left and ahead, ahead and
right). `turnLanes` 1 holds the lanes at every junction: on a give-way avenue corridor that halves the straight-on
lanes where they meet and costs a sixth of the throughput (docs/traffic-tuning.md "Junctions"). A street approaching an
avenue gets no new lane: the queue at its stop line is the lane.

**The median box.** A car crossing an avenue, or turning left across it, may wait in the reservation between the two
carriageways' junction tiles: centred on their shared edge (lane progress 0.5), clear of both carriageways' lanes by a
twentieth of a tile, in neither tile's box. Each such edge holds one car each way (nobody comes into the first tile to
cross while one is waiting to; `medianTaken`); vans, lorries and buses (longer than 0.36) wait in the first box as
before. R3's `overMedian` rule (no car into a box while one crossing the other way waits in the twin's) stays for them.
The body guard tests a car in the median body to body, without its margin: there is room, but not for the margin on
both bodies.

**Mini-roundabouts.** A painted roundabout on the junction tile of a crossroads or T of streets or country lanes
(`MINI_AUX`, 0xfb; the tile stays road and loses any lights). A car coming in gives way to a moving car about to come
in from the arm on its left (traffic goes round anticlockwise, so that is where the circulating cars come from:
`miniYield`, 0.6 tiles; the brief said "from the right", the UK's way round); standing cars give way to nobody, so four
waiting at once never lock; there is no don't-block-the-box rule. `miniOne` 1 lets only one car into the box at a time
(the brief's model): it carries a third of a give-way crossroads, so the default is 0, the box's own conflict rules.
Cars drive the tile's ordinary turn paths over the disc, as real ones may.

**Big roundabouts.** The Roundabout tool on an avenue's junction builds a **5×5 two-lane ring** (`planBigRoundabout`):
the group at the box's middle (the box from the anchor less two each way), a 3×3 island round it (`BIG_ISLAND_AUX`,
0xfc, not road, planted as one from its centre tile), and sixteen ring tiles of road class 6 (`RoadCls.Ring`, one way
round in each tile's direction, a corner's the way out; two lanes, as R3 drives every one-way tile). An avenue's two
carriageways join a side at its second and third tiles (the way out first in driving order, then the way in), a street
at its middle; corners take no road. Cars going past the second exit (more than nine ring tiles) take the inner lane and
move out four tiles before they leave; cars for the second exit (straight over, six to nine) take either lane by the
driver's hash and move out two tiles before; cars for the first keep to the outer; the approach takes the lane the ring
will want. A car coming on gives way to a moving car on the ring tile before it (or the one before that) that stays on
past it, within `ringYield` (joining the outer lane, not to one in the inner lane that stays there), and never fills the
ring (`bigRingSpare` places free over both lanes); after `minorWaitMax` ticks it goes when the box is clear anyway, so a
side street does not starve behind a busy avenue. Bulldozing any of it leaves the ring
as plain streets and the island bare.

**The diamond interchange.** The Interchange tool, clicked on a motorway where a street meets or should cross it
(`planInterchange`): the street goes over both carriageways on a deck (road class 7, `RoadCls.Deck`: a motorway tile to
everything under it, and a step along the deck's axis is a street step on route layer 1, as on a flyover, so nobody
turns between the two); each carriageway gets an off slip that leaves it four tiles before the bridge and an on slip
that joins it four tiles after, one-way streets running parallel a tile out (a verge row between) to a junction with
the street, where they give way. Footprint 9 along the motorway × 6 across; it needs a straight plain motorway five
tiles either side. Every part is an ordinary road tile of its class: the diverge is a one-way tile beside the
carriageway, the merge gives way to the motorway as any slip does (`SLIP_GAP`). Bulldozing the deck takes it away (the
motorway whole again, the slips left as one-way streets). A motorway-to-motorway interchange (a trumpet) is not built:
motorways meeting are a plain junction, as in R3.

**Turn bans and no entry.** The Turn rules tool: click the road just before a junction, on the arm you want the sign
on; each click goes on to the next of no rule, no left turn, no right turn, no straight on, no entry
(`junctionArmAt`, `nextArmState`). The signs live in the junction's **road rule record** (`shared/src/roadrules.ts`):
one small typed record per junction anchor, `{ ban?, noEntry?, pelican? }`, the bans as bit `arm × 3 + turn`, arms in
DIRS order (E, W, S, N; arm d the road leaving the junction heading d); a U-turn counts as a left. The store is
`World.roadRules` (an optional snapshot field `roadRules`, absent in older saves; every client gets the list on hello
and on each change), and R5's traffic control adds its own fields to the same record. A record follows its junction:
when a road change moves a group's anchor the record moves with it, and when the junction goes the signs go. Every
router honours them: A* checks where a route leaves a ruled junction against the heading it came in by (back up its
parents), keeps a ruled tile's arrivals along x and along y apart (so a ban on one arm does not shut the tile to a route
from another) and, where any rule exists, never turns straight back on the road (which would get round a sign); the bus
router checks its exact (tile, heading) states and its turns round; a bus lap a new sign breaks is re-planned
(`lapValid`); a driver whose way ahead a new sign breaks finds another (`Simulation.recheckClasses`, from the tile
ahead, without the stuck rule's avoidance of the tile after it). Fire engines, ambulances and patrols on a call ignore
turn bans, never a no entry.

**Signal crossings** (pelicans). The Signal crossing tool, on a straight two-way street or lane tile a tile or more from a
junction (`pelicanProblem`), or clicked again to take it away; and wherever a pedestrian street crosses a street there
is one already (`implicitPelican`). A walker at its kerb presses: the walk phase is granted once the last cycle and its
minimum green are done (`pelicanReady`), and runs amber (2 ticks), red (6: walkers cross), flashing amber (2: cars give
way to anyone still on it), then green for at least 12 (`PELICAN`, `pelicanPhase`). Cars stop at its stop line on amber
and red; walkers cross only on the red. The server sends each grant's tick (`walks`), and the client draws the lamps
from it with the same function.

**Tools, technology and costs.** The tools sit on the tool bar after the road tool, beside Roundabout and Flyover, one
click each (no keys: every letter is taken); the ghost outlines the footprint green or red with the reason, and the
status line gives the cost.

| Tool | What | Technology | Cost |
| --- | --- | --- | --- |
| Roundabout on a street junction | 3×3 ring | Junction design | $600 |
| Roundabout on an avenue junction | 5×5 two-lane ring | Junction design and Avenues | $1,500 |
| Mini-roundabout | painted on a street junction | Junction design | $150 |
| Interchange | diamond, street over a motorway | Junction design and Motorways | $2,500 |
| Turn rules | a sign on a junction's arm | Traffic signals | $40 a sign (taking one down is free) |
| Signal crossing | a pelican on a street | Traffic signals | $250 |

**Showcase.** In the "Road classes and junctions" section: Kingsway's 5×5 roundabout where Crown Street meets it,
Market Street's diamond over the motorway, and on the land south of them Regent Avenue crossing Queen's Avenue (the
four-phase group), Mill Road's mini-roundabout at Church Lane, its no left turn at Queen's Avenue and its signal crossing
between the homes and shops; a tour stop each, and six features (`miniroundabout`, `interchange`, `turnrule`,
`pelican`, `big-roundabout`, `junction-group`) that demo:check enforces.

## Traffic control

R5 (card 0ce0a9c9). The jam tools that work, so a jam is the player's own doing and they can see why: per-street rules,
a visitor and freight load they can see and shape, and a lorry curfew. The code: `shared/src/roadrules.ts` (the rules,
their costs, the tiles a click sets, humps), `server/src/world.ts` (the store: `setStreetRules`, `streetAt`),
`server/src/sim/traffic.ts` (bus lane strands, 20-zone speed and cost, kerbless tiles, `whyHeld`),
`server/src/pathfinding.ts` (`findRoute`'s lorry and `lorryAccess`), `server/src/sim/control.ts` (freight routing, the
visitor limit, the curfew, the Traffic panel, the overlay's explanation, the HGV ghost's probe), `server/src/net.ts` (the
intents), `client/src/streetrules.ts` (the tool, its picker and ghost), `client/src/trafficpanel.ts`,
`client/src/render/roadGeo.ts` and `roads.ts` (markings, humps), `render/junctionSigns.ts` (signs).

**Street rules, per tile, set per street.** Four bits of `RoadRule.st` on each road tile (StreetRule: 1 HGV ban, 2 bus
lane, 4 double yellows, 8 20 zone), in the road rule records R4 made (`World.roadRules`, the optional snapshot field
`roadRules`, sent whole as `{ t: 'roadRules' }`). A tile's bits go with it when it stops being a road (bulldozed out of a
street: the tiles either side keep theirs) and survive a rename, which only touches the street book. The Street rules tool
(on the tool bar after the signal crossing; no key) opens a picker of the four, each with its cost a tile and upkeep a
day and the technology it needs. A click on a road sets the rule along the whole street through it (`streetRuleTiles`:
the straight run, the axis the cursor is towards at a crossroads; on an avenue both carriageways, but a bus lane only the
one clicked); a straight drag sets it on those tiles only; a click on a street that has the rule everywhere takes it off,
free. The ghost covers the tiles a release would change in the rule's colour (dim where it is already, red where it
cannot go), with a chip of the cost, the day's upkeep and, for an HGV ban, how much further a lorry going past must go
round (the server's router, `ruleProbe`). Ctrl/Cmd+Z takes the last change back, refunded, within `ROAD_UNDO_MS`. The
upkeep is charged with the parcel's roads each midnight (`World.recountRoads`). The road tooltip lists a tile's rules, and
a road's right-click menu has the four, each on or off along the street through it with its cost (`client/src/contextmenu.ts`).

| Rule | Who it stops | Cost a tile | Upkeep a day | Technology |
| --- | --- | --- | --- | --- |
| HGV ban | lorries (freight), but to deliver on it | $3 | $0.05 | Traffic signals |
| Bus lane | cars and lorries from the kerb lane, but to turn off at the last tile | $8 | $0.20 | Public transport |
| Double yellows | kerb parking | $1 | $0.02 | Traffic signals |
| 20 zone | nobody: every vehicle at 60%, routes avoid it | $6 | $0.10 | Traffic signals |

- **HGV ban.** A lorry is a freight vehicle (`VehicleKind.Freight`); vans, buses, the fleet and emergencies are not.
  `findRoute(…, lorry)` treats banned tiles as walls except "for access": the banned tiles 4-connected to the road the
  trip starts or ends on, or the roads beside its building (`lorryAccess`), so a delivery to a home on a banned street
  comes in from the nearest end. The bus router does not read bans. A lorry whose way a new ban breaks finds another
  (`Simulation.recheckClasses`, `TrafficControl.breaksBan`); its re-routes and its trip back obey the ban. Signs: a red
  ring with a lorry on both kerbs wherever a road comes into a banned stretch (its ends and the junctions on it). The
  rule is not in `carStepOk`: it is not in the aux byte, so the routers test `World.streetAt` beside it.
- **Bus lane.** The kerb lane (strand 0, the right-hand lane) of a one-way tile with two lanes: a one-way street or an
  avenue's carriageway, not a motorway, a 5×5 ring or a junction tile (it stops short of each junction). Buses, bikes,
  taxis, private hire and emergencies on a call take it (unless they turn left within six tiles); every other vehicle
  takes the other lane on an edge into or out of a bus lane tile, but for a right turn out of the next tile, which is
  turning off at the last tile (`Traffic.strandFor`). The lane model is R3's: a car follows the car ahead in its own
  lane, so a bus in the bus lane passes the queue. A street with one lane each way refuses one: "One lane each way: a
  bus lane needs a one-way street or an avenue". Drawn red, the lane line solid, BUS LANE every third tile. No kerb
  parking on it.
- **Double yellows.** No kerb parking (`Traffic.kerbless`): a driver whose destination is full and who finds no lot
  parks at the kerb of the last tile back along the route that allows it (the next street) and walks; a driver giving
  up in a jam does not pull over there. Drawn as two yellow lines along each kerb of a straight.
- **20 zone.** Every vehicle at `ZONE20_SPEED` (60%) on its tiles; a route tile costs `ZONE20_COST` (1.4, against a
  street's 1 and a lane's 1.2), and a lorry's `ZONE20_FREIGHT` (1.5) times that again. Humps four to six tiles apart along
  each run of zone tiles, never on a junction (`humpAt`, by hash: each run its own), drawn as a raised band with white
  triangles; cars dip over them (the client's `RoadLayer.humpY`). The roundel stands on both kerbs at each way in and is
  painted on the road in the lane coming in; a repeater on one kerb at each hump. Quieter and safer: the car–pedestrian
  contacts in the harness go down (docs/traffic-tuning.md "Traffic control"). Noise: nothing in the game reads traffic
  noise yet; the hook is `World.streetAt(x, y) & StreetRule.Zone20` (and, for the curfew, `inCurfew`), for when a
  building's noise or a home's appeal does.

**The visitor and freight load.** Two-thirds of give-ups are visitors and lorries the player did not create
(docs/traffic-tuning.md "What the player can do about jams"). Three things make that load the player's:

- **The Traffic panel** (the overlays menu's Traffic panel…, `client/src/trafficpanel.ts`): cars on the road now by who
  drives them (residents, visitors, lorries, buses, services and the fleet), visitors and lorries set off in the last
  hour, today's give-ups by kind, each gateway's arrivals an hour, moves today and (a motorway connection) visitors today
  and yesterday, the five junctions where most drivers gave up since yesterday began (`TrafficControl.noteGiveUp`: the
  junction tile within four tiles ahead of the car) and the three streets with the most cars queued now. A junction or a
  street is a link. The client asks (`trafficPanel`) every three seconds while it is open, never otherwise.
- **The visitor limit.** A motorway connection's panel has Limit visitors: `RoadRule.gw` on its door, and
  `VISITOR_LIMIT_SHARE` (half) of the visitors who would come in by it do (`Simulation.dispatch`, `TrafficControl.dropVisitor`).
  The panel says about what it costs a day: the visitors it turns away (yesterday's count, or today's so far) times the
  $5 a visitor spends at the mean tax rate. Rail, coach and air gateways bring newcomers on foot, not visitors by road,
  so the limit lives on motorway connections. `TRAFFIC_TUNING.visitorLimit` 1 turns it on at every entry (ab.ts: the
  Commons has no gateway of its own).
- **Freight routing.** Lorries cost a route as cars do, but a 20 zone costs them half as much again and a ban is a wall,
  so industry's lorries keep to the roads that are theirs.

**Why it is slow.** With the congestion overlay on, hovering a road's tooltip adds "Why it is slow": the cars held on the
tile by cause, from the same tests the entry rules make (`Traffic.whyHeld`: following the car ahead in its lane, held at
a red light, waiting for a gap, the box ahead blocked, getting into the destination or looking for parking, slowed for a
turn), and how many of them are visitors and lorries. The server answers `{ t: 'jamWhy', cx, cy }` for one chunk at a
time (flat [x, y, cars, six causes, freight and visitors] per tile with a car held), asked at most every two seconds while
the tooltip is up with the overlay on: no stream, no steady cost.

**The lorry curfew.** A policy (`shared/src/policies.ts`, the Policies panel's Transport section; Traffic signals opens
it, $150, $10 a day): from 22:00 to 06:00 no lorry sets off from or for the land of a player with it on. One that would
waits at its depot (`Vehicle.hold`) and sets off at its own minute in the first hour of the morning; one that delivers
late waits where it delivered. Industry sends lorries only from 06:00 to 20:00 already, so it holds the late ones, rail
freight's last mile and the harbours' early fish; deliveries are not lost, they come in the morning.

**Showcase.** In "Road classes and junctions": an HGV ban on South Parade, a bus lane on North Parade with bus line 4
along it, double yellows on Market Street's approach to Cheapside, a 20 zone on Church Lane (the homes south of Regent
Avenue: the homes behind Kingsway face the avenue and have no street of their own), a bus depot of its own facing North
Parade (line 4's buses start on their line; from the town's depot they spent the morning crossing town), the motorway connection's visitor
limit on, and a stop that opens the Traffic panel with the congestion overlay; a tour stop each and seven features
(`street-hgv`, `street-bus`, `street-yellow`, `street-zone20`, `bus-lane-line`, `visitor-limit`, `traffic-panel`) that
demo:check enforces.

**London** uses all of R3-R5 in its scenario (docs/demo.md "London", "Roads"): its arterials as avenues, the M4 and the
A13 as motorways with diamond interchanges, roundabouts at Hyde Park Corner, Marble Arch, Elephant and Castle and Old
Street, pedestrian streets, bus lanes, 20 zones, double yellows and turn bans.

## Street names

**What a street is.** The longest straight run of road tiles along one axis. A crossroads belongs to both streets
through it, a bend ends one street and starts the next, and a street runs on through junctions, as Station Road does
in a real town. This was picked over "a segment between junctions" because it reads like a town: on a grid, junction
segments would give every block side its own name.

**How it is named.** British: a base (Station, Mill, Victoria, Albert, Church...) and a suffix by what the street is
like when it is named: a mews, court or yard for a stub of three tiles or fewer; a close (court, gardens) for a short
dead end of homes; a street or parade where shops make up half its frontage; a road or way for industry; a street,
place or row for offices; a lane (terrace, grove, row, gardens, walk) for a short street of up to 8 tiles; a road or
way for a through route of 14 tiles or more joined at both ends; else a street, road or terrace. The avenue waits
for R3's avenue class. The choice is a hash of the world seed, the street's line and its first tile, re-rolled until
its base differs from every street crossing it or running alongside it within 8 tiles, so no two neighbours share a
name (`streetClashes` counts any that do; the Showcase must have none).

**When.** A street is named the first time anyone asks (a hover, a building's address) and keeps that name from then
on, in the server's street book (`server/src/streets.ts`): a list per owner of stretches of a line and their names,
not per tile. A longer street on the same line that overlaps a named stretch takes its name and widens it, so
extending a street keeps its name; two named streets joined end to end keep the one they overlap most. The book is
saved in the snapshot as the optional `streets` field (`{ owner: [["h12:-11:10", "Mill Lane"], ...] }`; the
snapshot version stays 8). An older save has no book: its streets are named as they are asked for, the same way on
every server (a pure function of the seed, the street and what is round it at the time).

**Owner and renaming.** A street's owner is whoever owns most of its tiles ('' for public road on unclaimed land).
Right-click a road: **Rename street** (or **Rename Mill Lane** and **Rename Station Road** at a crossroads), greyed for
a street the player does not own. An empty name gives back the generated one. Up to 32 characters.

**Where names show.** The road tooltip leads with the street's name (and "corner of" or "meets" the other street at
a bend or junction), above the traffic; the building panel has an address line, the number on the door (shared
`houseNumber`, the number the door plates show) and the street the front faces ("12 Mill Lane"); the right-click
menu's title. R1's sign plates are next (a follow-up: the server sends the names of the streets in subscribed chunks).

**Showcase.** The High Street is named by the scenario (`DemoSection.streets`), and the `street-names` feature checks
every seeded street has a name, the scenario's names stand, and no neighbours clash.

## Lots one back from a road (card 797ee40a)

Not a bug in road access, but nothing told the player. A lot builds only with a road on one of its four sides
(`World.hasRoadAccess`). A lot one tile behind the frontage has none, so it waits for the building in front to grow
back into it as a deep plot (sim/blocks.ts), which only a building of two storeys or more does, and two storeys need
Masonry and power. Measured on a fresh Commons world, a new player's homes zoned one, two, three and four rows behind a
road: after four game days only the front row was built (level 1, full); with Masonry and the power gate off, the
front row reached levels 2-3 and one lot of the second row had been taken in; rows three and four never build until a
road reaches them. Now: with a zoning tool, the hover turns amber over land with no road beside it and the status
line says why; the toast after zoning says the same, naming Masonry and power.

## The Commons

The Commons used to be a 22×22 grid of 4×4 blocks with roads every 5 tiles (plus a doubled edge road). It is now
four bands of blocks between full-width streets, 4, 3, 6 and 4 tiles deep, each cut by its own cross streets into
blocks 3, 4, 6 or 8 long, so the cross streets meet the long ones at staggered T-junctions (13 T-junctions to 1
crossroads inside it) instead of a grid (`COMMONS` in seed.ts). Its edge roads are where they were (x and y = -11
and 10), so a plot east of it still joins at x = 10. New worlds only: an old save keeps its Commons.

The zones were balanced so the town grows as before. Six seeds, three game days from a fresh world:

| | Road tiles | Lots | Frontage homes / shops / works / offices | Residents | Jobs | Employed |
| --- | --- | --- | --- | --- | --- | --- |
| Before (4×4 grid) | 228 | 256 | 79 / 47 / 34 / 24 | 341 | 316 | 305 |
| After (mixed blocks) | 185 | 299 | 90 / 50 / 33 / 8 | 348 | 320 | 308 |

Fewer office lots, because offices on the new layout grew far faster (a 3×4 block of offices made 140-160 jobs in
three days, against 40-64 from the old six blocks). The test cities (loadtest/cities.ts) keep the old grid, so load
test results stay comparable.

## Street lamps at night (card f91d8841)

Every lamp is placed once per loaded chunk (`render/roads.ts` `placeLamps`, hashed from its tile, so a chunk rebuild changes
nothing about a lamp) and its habits go into the lamp map: when it comes on, where its pool falls, and flags for **dead**
(about 4%, never lit), **failing** (about 5%), LED-white or sodium-warm, and its brightness. The ground and road shader draws
the pool from the map and the instanced lantern draws the head from the same bytes.

- **A failing lamp is steady almost all the time.** Every 25 to 65 seconds, on a period and phase of its own, it stutters for
  about a second and a half: two or three soft dips to 40%, eased in and out, never faster than two a second and never a hard
  step (`mscFlutter` in `render/materials.ts`). The pool and the head both take their seed from the lamp's tile
  (`mscLampSeed`), so they dip together. The old habit was a hard 35%/100% strobe at about three a second, for ever, on one
  lamp in twenty, and the pool and head strobed out of step: "flickering lights on some streets". A failing office tube
  in a window uses the same function.
- **A brownout** dims lamps (and windows) steadily; nothing in the night lighting moves faster than a breath except a
  failing lamp's rare stutter, the beacons, signs and screens that blink by design, and a candle in a cut.
- **The shadow camera** snaps to whole texels of its own map in the light's axes (`render/lighting.ts`), so shadow edges stay
  on the same texels as the view pans instead of crawling over lit surfaces.
- To look for flicker: pin the hour (`?hour=22`), hide the moving things (`msc.citizens.group.visible = false`, `planes`,
  `helis`, `boats`, `trains`), take 80 frames 20 ms apart and count a patch's crossings of its own mean; with the clock frozen
  (the `uTime` uniform) nothing should still cross. `uTime` is wall-clock seconds from the page's load; a float32
  argument stays smooth for days of uptime, so it is not wrapped (a wrap would make every sine jump).

