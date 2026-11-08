# Free time: places to go and what you see there

Citizens with a free afternoon or evening go out. Before this card they chose between a park, a cinema, a theatre, a
sports hall, a library and the café or bar. Now there are 26 more places, four new things to do in a park, and every
one of them has a first-person scene: follow anyone who goes and press I to see the place through their eyes. Everything
here is for all ages: no bars, no gambling, no late-night clubs.

Code: `shared/src/venueTypes.ts` (the outings), `shared/src/leisure.ts` (wording, park activities),
`shared/src/buildings/attractions.ts` (the places), `attraction-models-outdoor.ts` and `attraction-models-indoor.ts` (their
models), `shared/src/ferris.ts` (the wheel), `client/src/render/leisureKit.ts`, `leisureRooms.ts` and `rooms/*.ts` (the
scenes), `client/src/render/wheels.ts` (the turning wheel), `leisureAnims.ts` and `leisureRigs.ts` (the moving parts, section 9), `shared/src/tech.ts` (cul7-cul11).

## 1. Outings are data

A leisure place's `venueType` attribute names its outing. `VENUE_TYPES` (`shared/src/venueTypes.ts`) lists every outing in a
fixed order; the order seeds each citizen's taste for it (`pickLeisure`: `hash2(c.id, 301 + index)`), so new outings go on
the end and the first five (park, cinema, theatre, sports, library) keep the tastes they always had. `VENUE_TEXT`
(`shared/src/leisure.ts`) words each one:

| Field | Used for |
| --- | --- |
| `at` | the activity line while there ("swimming at the lido"); the first-person view picks its scene by it |
| `going` | on the way ("going to the lido") |
| `event` | the activity line while its event is on ("at the swimming gala") |
| `eventName` | the tooltip's next event ("swimming gala") |

`VENUE_WORDS`, `EVENT_NAMES` and `VENUE_TYPE_INDEX` are derived from these, so the simulation, the tooltips and the
interiors read one table. The validator (`buildings/validate.ts`) takes the list from the same file, which has no imports so
it can run before anything is compiled. `UNSTAFFED_VENUES` names the outings that open with nobody on the payroll: the
park, the playground, the skate park and the allotments.

Event days may start in the morning (5:00 to 23:00): the dawn chorus walk at 5:30, a fishing match at 8, a farm's open day
at 11.

Nothing else changed in how outings are chosen: every open place in reach is scored by its appeal at that hour and to that
life stage, the citizen's taste, an event about to start, its value and the citizen's need, over distance, and must beat a
bar. Children on their own go only to free places close by, so the playground, the skate park, the city farm and the art
gallery are the new places a child can walk to alone.

## 2. The places

Four tool-bar groups in the Leisure section, each a **collection** (`groups.ts`: `collection: true, noun: 'places'`): its
picker lists different places rather than sizes of one. Kind ids are the last free ids outside the reserved blocks
(docs/sub-kinds.md). Family codes follow what each is like; collections may mix codes.

| Group | Place | Kind id | Family | Size | Open | Ticket | Event | Staff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Play and green | adventure playground | 217 | park (10) | 1×1 | 7-20 | free | | none |
| | skate park | 218 | park | 1×1 | 8-21 | free | skate jam, Sat 14:00 | none |
| | allotments | 219 | park | 2×2 | 7-20 | $1 | harvest show, Sun 11:00 | none |
| | fishing lake | 220 | park | 2×2 | 5-21 | $3 | fishing match, Sun 8:00 | 2 bailiffs |
| | nature reserve | 221 | park | 3×2 | 5-20 | free | dawn chorus walk, Sat 5:30 | 2 wardens |
| Active fun | lido | 222 | sport (13) | 2×2 | 7-20 | $4 | swimming gala, Sat 14:00 | 6 lifeguards |
| | tennis club | 223 | sport | 2×1 | 8-21 | $4 | club tournament, Sun 13:00 | 2 coaches |
| | bowling alley | 224 | sport | 2×1 | 11-23 | $7 | league night, Wed 19:30 | 6 |
| | ice rink | 225 | sport | 2×2 | 10-22 | $7 | ice disco, Fri 19:30 | 8 |
| | roller disco | 226 | sport | 1×1 | 12-22 | $5 | roller disco night, Sat 18:30 | 3 |
| | climbing centre | 227 | sport | 1×1 | 9-22 | $8 | bouldering competition, Thu 19:00 | 3 instructors |
| | trampoline park | 228 | sport | 2×1 | 9-20 | $8 | family bounce, Sun 10:30 | 4 |
| | go-kart track | 229 | sport | 3×2 | 10-22 | $15 | kart grand prix, Sat 19:00 | 5 marshals |
| Days out | city farm | 251 | library (14) | 2×2 | 9-17 | free | open day, Sun 11:00 | 4 farm hands |
| | aquarium | 252 | library | 2×2 | 10-18 | $10 | feeding time, Sat and Sun 14:00 | 8 aquarists |
| | planetarium | 253 | library | 2×2 | 10-21 | $8 | star show, Fri 19:30 | 5 presenters |
| | science centre | 254 | library | 2×2 | 10-21 | $9 | late opening, Thu 18:30 | 8 explainers |
| | observatory | 255 | library | 1×1 | 18-24 | $5 | stargazing night, Sat 21:00 | 2 astronomers |
| | funfair | 250 | library | 3×3 | 11-23 | $9 | fireworks night, Sat 21:00 | 14 ride operators |
| Arts and games | art gallery | 118 | theatre (12) | 1×1 | 10-19 | free | exhibition opening, Thu 18:00 | 3 |
| | pottery studio | 119 | theatre | 1×1 | 10-21 | $12 | open studio, Sun 12:00 | 2 tutors |
| | dance hall | 140 | theatre | 1×1 | 13-23 | $4 | tea dance, Sun 14:30 | 4 |
| | concert hall | 129 | theatre | 2×2 | 12-23 | $16 | concert, Thu-Sat 19:30 | 24 musicians |
| | family arcade | 147 | cinema (11) | 1×1 | 10-22 | $4 | high-score night, Fri 18:00 | 2 |
| | board-game café | 148 | cinema | 1×1 | 11-23 | $5 | games tournament, Tue 19:00 | 3 |
| | escape room | 149 | cinema | 1×1 | 11-22 | $14 | | 2 hosts |

Who goes is set by the appeal numbers in `attractions.ts`: the playground, trampoline park, farm and science centre pull
children hardest, the allotments, nature reserve, gallery and dance hall retirees, the bowling alley, roller disco and
karts the evening. Every place has two designs (`attraction-models-*.ts`).

**Technology** (Culture track, `tech.ts`):

| Node | Tier | Cost | Needs | Unlocks |
| --- | --- | --- | --- | --- |
| cul7 Play and green spaces | 1 | 300 | 30 housed | playground, skate park, allotments, fishing lake |
| cul8 Days out | 2 | 600 | cul7, 80 housed | nature reserve, city farm, art gallery, pottery studio, tennis club, board-game café |
| cul9 Indoor fun | 3 | 1,000 | cul8, cul2, 150 housed | lido, bowling, roller disco, climbing, trampolines, arcade, escape room, dance hall |
| cul10 Attractions | 4 | 2,400 | cul9, cul3, 300 housed | ice rink, go-karts, aquarium, planetarium, science centre, observatory, concert hall |
| cul11 Funfair | 5 | 4,000 | cul10, 400 jobs | funfair |

## 3. What people do in a park

A park visit used to read "in the park" and had no first-person view. `parkActivity` (`shared/src/leisure.ts`) now picks one
per person and visit (seeded, so a visit keeps it): a sit on a bench ("in the park"), a picnic ("having a picnic in the
park", midday to early evening), a kite ("flying a kite in the park", by day, children most) or feeding the ducks ("feeding
the ducks in the park", only where the park has water: a pond layout, the lakeside park, the botanical garden). The band's
afternoon is the park's event, as before.

## 4. Inside, in first person

When a followed citizen is at a leisure place, the server's inspect says which (`CitizenInfo.venue`: its door tile and kind
id, inspect only), and the first-person view (`render/fpv.ts`) builds that place's scene from `render/interiors.ts`.
`placeOf` maps the activity line to a room (`leisureRoomOf`); a room is offered only if a builder is registered for it.
`render/leisureRooms.ts` registers the new ones into `EXTRA_ROOMS` on import, from four files:

| File | Scenes |
| --- | --- |
| `rooms/parkRooms.ts` | on a bench, a picnic rug, a kite on the wind, the ducks at the water's edge, deckchairs before the bandstand, and the Ferris wheel |
| `rooms/outdoorRooms.ts` | on a swing, the skate bowl's deck, kneeling at an allotment bed, a fishing peg, inside a bird hide, in the lido's water, the tennis baseline, driving a kart |
| `rooms/indoorRooms.ts` | at the bowling lane, skating the rink, the roller disco, up the climbing wall, bouncing, at an arcade cabinet, a board-game table, the escape room |
| `rooms/dayoutRooms.ts` | the farm's pens, the aquarium tunnel, under the planetarium's turning stars, the science centre's pendulum, the observatory's slit, the gallery, a potter's wheel, the orchestra, the tea dance |

Each scene is seeded by the place (`Place.venue.seed`) so the same place looks the same to everyone, and by the visitor for
their seat. Your own household comes with you: `companions` puts the family members whose activity line matches yours
beside you on the rug, the bench or in the gondola.

**The kit** (`render/leisureKit.ts`) adds what the indoor rooms did not need: `outdoors()` gives a scene a ground and a sky
dome (one shader: the clock's sky from horizon to zenith, the town's skyline round the horizon with its windows lit at
night, and stars once it is dark), daylight from above and moonlight; trees, benches, lamp posts and flower beds; visitors
seeded per place, walkers on loops and lines, thin bars between two points (a kite's string, a rod's line), and ducks.

**Two things a scene can now do** (`View` in `interiors.ts`):

- `move(t, eye)`: a moving eye. It moves the eye each frame and may point the head: the swing's arc, a skater going round
  the rink, a kart round its track, the trampoline's bounce, the kite followed across the sky.
- `overWorld(t)`: the eye's place in world tiles. The first-person view then draws the real city from there, with the room's
  camera turn, and the room over it (`Interior.renderOver`: depth cleared, no background). The Ferris wheel uses it.

`msc.fpv.preview(room, seed, hour, venue?)` shows any room full-window with nobody selected, for screenshots and tuning
(`msc.fpv.preview(null)` returns). With a real funfair's door and kind as `venue`, the gondola rides that wheel.

`/viewer.html` shows the same rooms: pick a kind and press **Inside** on the stage. The chips choose among the kind's rooms (a
home's lounge, kitchen and bedroom; a shop floor or café; the ward or the doctor; a park's stroll, picnic, kite, ducks and band;
each free-time place's scene), **Another visit** reseeds the visitor, the Hour slider rebuilds the room for that time, and you
drag to look round and scroll to zoom. The link keeps it (`#…&in=1&room=kite`). The gondola there has no town under it, so it
shows the fallback skyline.

## 5. The Ferris wheel

`shared/src/ferris.ts` fixes the wheel in the funfair's 3×3 recipe frame: the hub at (-0.3, 1.62, -0.75), a rim of radius
1.15 turning in the x-y plane, twelve gondolas hanging 0.42 below their pivots, a turn in 150 seconds. The recipe draws only
the A-frame legs and the axle. `render/wheels.ts` draws the rest, turning: the twin rims, spokes and hub as one instanced
mesh and the gondolas, each hung level from its pivot, as another, so every funfair in range costs two draw calls. A wheel
turns while its fair is open and winds down over eight seconds when it shuts; each has its own phase and a speed within a
few per cent of the others.

The funfair's scene asks `wheelSeat(door, seat)` every frame for its gondola's pivot, so the rider rises and falls with the
wheel everyone else sees; that gondola is left out of the pass while it is ridden, and the room draws the cabin around the
rider (a little roomier than the one seen from outside, its depth inside the rims) with a companion on the bench. The rider
looks out along the axle over the town, down toward the fair near the top. With no wheel loaded (a preview), the gondola
hangs high under the sky dome instead.

## 6. The demos

The showcase and the Leisure demo have a **Days out** section (`shared/src/demo/showcase.ts`): five blocks of district C2
cleared and given to all 26 places, the funfair facing the street to the north with seven small places round it, the 2×2
places in the corners of the next blocks, and the rest round the two blocks to the south, each on the tour after the
museum. London (`demo/london-kinds.ts`) has each at its real counterpart: the allotments by Fulham Palace, Walthamstow
Wetlands, the London Wetland Centre, Brockwell Lido, Queen's Club, the bowling lanes off Brick Lane, Bayswater's rink, a
trampoline park in Wandsworth, karting at Canning Town, a funfair in Hyde Park, Mudchute Farm, the Horniman's aquarium,
Greenwich's planetarium and observatory, the Science Museum, the Barbican, the Diana memorial playground, Stockwell's skate
park, a roller disco in Vauxhall, the Castle climbing centre, the Whitechapel Gallery, a pottery in Hackney, the Rivoli
Ballroom, an arcade in Camden, a board-game café in Haggerston and an escape room by King's Cross. (A bowling alley in
Bloomsbury took the land the Embankment pier needs on London's coarse map; it stands off Brick Lane instead.)

## 7. Measured

`npx tsx packages/server/src/loadtest/leisure.ts --new --days 2 --ages 6-90` places the eleven one-tile places on the first
street and a funfair, a lido, an aquarium and an ice rink as built structures beside the probe's park, cinema and library
(1 district, about 1,000 people, 2026-11-06). Visits on the second counted day:

| Place | Visits | Place | Visits |
| --- | --- | --- | --- |
| funfair | 41 | board-game café | 19 |
| aquarium | 41 | art gallery | 14 |
| dance hall | 34 | escape room | 12 |
| cinema (for comparison) | 33 | pottery studio | 9 |
| lido | 22 | climbing centre | 6 |
| ice rink | 21 | roller disco | 5 |
| observatory | 20 | playground, arcade, skate park | 0-1 |

The children's places were near empty because the probe town had 29 children; the skate park and arcade then got a
leisure value of 4 (from 3). Retirees' favourite new places were the dance hall (25% of their outings) and the aquarium
(19%); adults' the funfair (13%), the lido and the aquarium. The bar's share of adults' outings was 30%.

## 8. Adding a place

1. Add an outing to the end of `VENUE_TYPES` and its words to `VENUE_TEXT`.
2. Add the kind to `attractions.ts` with `place({...})`: a free kind id (docs/sub-kinds.md), a family code, a group and
   tier, the attributes and a staff roster; draw two designs in a models file.
3. Unlock its tool from a Culture node in `tech.ts`.
4. Write its scene in a `rooms/*.ts` file and register it (the key is the outing's name).
   If something at it should move (a ride, a game, animals), add a rig in `render/leisureRigs.ts` (section 9).
5. Place it in the showcase's Days out section and at its real place in London; `npm run demo:check`.
6. `npm run buildings:compile`, `npm run buildings:check`, `npm run typecheck`, and
   `npx tsx packages/client/scripts/leisure-check.ts`: every outing and park activity has a scene its activity line leads to,
   and each builds by day and night, alone and with family, with its eye in place, a line, at most 64 people and a bounded
   number of meshes; the wheel's lowest gondola clears the ground; ducks only where a park has water.

## 9. Moving parts

The places are drawn still by the kit, as every building is; what moves at them is drawn over the top by
`client/src/render/leisureAnims.ts`, the way the Ferris wheel's rim turns in `wheels.ts`. Each kind with something to move
has a **rig** in `render/leisureRigs.ts`: the geometries of its props, how many of each one place can need, how far from a
camera it still moves, and a `frame` that places this frame's instances in the recipe's own frame (the same x across the
frontage, y up, z toward the road that the ops in `attraction-models-*.ts` use); the building's matrix takes them into the
world. Every prop is an `InstancedMesh` shared by every place of its rig, so all the karts on all the tracks in range are
one draw call, and the recipes keep only what stands still (the track, the pit lane with karts parked in it, the carousel's
platform and roof). Rigs keep what they need to remember per place (a ride's speed, a dodgem's own clock, the animals' day)
in a map by the place's seed, so a chunk rebuild changes nothing.

| Place | What moves |
| --- | --- |
| go-kart track | up to eight karts race the circuit (the figure of eight climbs its bridge), each with its own lane, pace and colour |
| funfair | the carousel's horses turn and bob, five dodgems drive about their floor, riders come down the helter-skelter; on the boardwalk fair the chair swing flares out as it spins, the teacups turn and spin, logs ride the flume, drop the chute and cross the splash pool |
| adventure playground | the swings swing with children aboard, the roundabout turns, the zip wire runs |
| city farm | sheep, pigs, a pony, goats and hens wander their pens by day (hens peck), ducks paddle the pond |
| tennis club | a rally on each court in play: players shuffle along their baselines, the ball lobs between them |
| skate park | riders roll round the bowl and pump the half-pipe, or lap the pump track |
| ice rink | skaters glide loops over the open-air ice, leaning into the turns |
| lido | swimmers do lengths of the lane pool, or drift round the lagoon |
| nature reserve | six birds wheel over the water by day, wings beating |
| observatory | the slit dome and its telescope slew to a new part of the sky every minute or so while it is open |
| fishing lake | anglers settle on the pegs as the day fills, a fish leaps now and then with a ring of splash, and on the canal pond a boat is rowed up and down |
| allotments | gardeners hoe their plots and straighten up, a barrow is wheeled up and down the main path |
| climbing centre | climbers work up the outside wall hold by hold, rest at the top and lower off |

**What moves follows the crowd.** The server broadcasts how many guests each leisure place has (`ServerMsg 'venues'`, flat
[x, y, guests] by door tile, with the stats when the counts change and every ten seconds for anyone just joined;
`Simulation.venueGuests`). Each place eases an **activity** 0-1 toward guests over capacity (0 when shut) over about four
seconds, and the rig scales what moves by it: an empty track stands quiet with its karts in the pit, the first guests put a
couple out, a full house runs eight; the swings die down and the roundabout coasts to a stop as the children leave. Rides
wind up and down over a few seconds when the fair opens and shuts, as the wheel does. Animals and birds go by the opening
hours alone. Without a guest count (an older server, the viewer) an open place is taken as half full.

**The switch.** The pass costs nothing when nothing is in range: a place more than its rig's range (70 to 120 tiles) from
every camera is neither updated nor drawn, so a wide view of the town carries none of it, and the far tier shows the places
still. In range it is a few hundred matrix writes a frame (under 0.1 ms for the showcase's ten places). It also turns itself
down when the frame rate drops: `level` 2 moves everything every frame; 1 updates every other frame over three quarters
of the range, with fewer karts and dodgems; 0 freezes the parts where they are (no updates; the draws stay, so nothing pops).
It falls a level when the smoothed frame time passes 30 ms, to frozen past 45 ms, and climbs back under 20 ms, re-judged
once a second. `?anim=0|1|2` pins it; `msc.buildings.anims` has `level`, `pinned`, `inRange` and `lastMs` for the console.

The viewer (viewer.html) draws the selected design's moving parts and the funfair's wheel the way the city does, with the
place taken as open and half full, and its filter lists the designs that have them.

The switch is shared with the fires (`render/motionGate.ts`, docs/incidents.md): one judgement a frame for everything
that moves for show.

