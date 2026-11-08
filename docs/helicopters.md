# Helicopters

Helicopters land on the helipads drawn on the city's buildings: air ambulances at hospitals, the police helicopter at police headquarters, executive and charter flights on the tallest office towers, and the King's flight on the lawn at Buckingham Palace. Like the airport timetable (docs/airport.md) the schedule is a pure function, of the pads and the tick: nothing is stored and nothing goes over the wire.

Code: `shared/src/helipads.ts` (pads from buildings), `shared/src/helicopters.ts` (pads, schedule, poses, operators, crews), `client/src/render/helicopters.ts` (models, picking, the cockpit eye), `client/src/vehicles.ts` (tooltip and panel), `client/src/main.ts` (wiring), `packages/shared/scripts/heli-check.ts` (checks).

## Pads

A pad is part of a building design: the tierkit `helipad(x, y, z, r)` helper draws a dark disc, a yellow ring at 0.82 of its radius and a white H. `helipads.ts` finds that pair of ops (the dark `0x4a4f58` disc followed by the yellow ring on the same spot) in the compiled recipes, so adding a pad to a design is just adding the helper to its ops. Designs with a pad:

| Kind | Design | Where |
| --- | --- | --- |
| hospital (1×1) | white ward block over a glazed outpatients wing (the 2026-11 redesign) | the ward block's roof, beside the cross |
| community hospital | ward block across the back | ward block roof |
| general hospital | ward tower over a podium; cruciform ward blocks | tower roof; the lawn |
| teaching hospital | campus; domed main hall | ward tower; research tower |
| police headquarters | glass headquarters tower | tower roof |
| office (1×1, level 3) | wide slab on a podium | slab roof |
| office tower (2×2) | dark glass tower on a podium (4); twin glass towers (5); diagrid tower (5) | roof; the lower twin; the white crown |
| corporate headquarters (3×3) | ring round a court (6); pale setback supertall (7) | the tower; the crown |
| commercial (1×1, level 3) | Haiku's tower with helipad | roof |
| Buckingham Palace | the east front | a square of lawn beside the Victoria Memorial |

The media centre's tower carries a `'news'` pad (docs/media.md N1): its helicopter has no routine timetable and flies to stories instead (section 7 there, shared/src/newsHelis.ts `newsHelisAt`, drawn here alongside the others).

Big Ben, the Shard, the Gherkin and the other spires and domes have none. The 1×1 hospital and level-3 office existed when `buildings:check` took its model snapshot, so their new geometry is re-snapshotted there (`HELIPAD_FIXED`); their heights are unchanged.

`padAt(x, y, env)` reads only tile words, aux bytes and sub bytes. It picks the design (`designPick`, as `render/models.ts variant` does) and places the pad exactly as `render/chunkView.ts` places the model: a structure centred on its footprint and turned by its orientation, a 1×1 building turned to face its road (or by hash when it has none) and scaled by its hash. Unfinished buildings have no pad. A pad's id is a hash of the anchor tile; its service comes from the kind (hospital family: medical, police family: police, Buckingham Palace: royal, anything else: corporate); a parked helicopter faces the building's front.

The module is not exported from the shared index, since it reads the recipe table, which the server has no use for; the client imports it by path. The server does not run helicopters: nothing in the simulation depends on them.

## The schedule

`heliTimetable(pads, day)` is cached per pad set (`padsKey`) and day. Each pad starts its own flights from hashed times:

| Service | Flights per pad per day (small pad) | Hours | Stop on the pad | Go on to a second pad |
| --- | --- | --- | --- | --- |
| medical | 2-5 (0-2) | 00:30-23:00 | 15-40 min | 30% (a patient transfer) |
| police | 2-3 | 06:00-22:00 | 1-2.5 h | never |
| corporate | 1-3 (0-1) | 07:00-20:00 | 10-45 min | 25% (a hop between towers) |
| royal | 0-1 | 09:00-17:00 | 2-4.5 h | never |

A small pad (radius under 0.25) is on a one-tile building. A flight comes in from a point 72 tiles out in a hashed direction, lands on its pad, stops, and leaves in another hashed direction, or first flies on to another pad of the same service 8 to 90 tiles away and stops there too. Candidate flights are booked in time order: each stop reserves its pad from 24 ticks before touchdown to 14 after lift-off, and a flight that would overlap a reservation is delayed in 10-tick slots (an onward flight that cannot fit drops its second stop first). A flight that cannot finish inside its day is cancelled, so nothing is parked over midnight. The light twin flies the air ambulances and police; executive flights take either; the royal flight the medium twin. The model is scaled down a little when its rotor would overhang a small pad.

The booking reads the whole pad list, so an onward flight depends on the other pad being known: a client that has not loaded the second pad's chunk may see a flight end at the first pad instead. The flights each pad starts on its own depend only on that pad.

## A flight

`heliState(flight, tick)`:

- **Off-map ends.** It appears at cruise height (9.5 tiles, above the supertall's spire; a short hop between pads stays lower but at least 2.5 tiles over the higher roof) fading in over 10 tiles, and fades out the same way.
- **In.** Straight to the pad at cruise speed, decelerating over the last few tiles. Near the pad the height falls at 1.6 per tile flown (a steep rooftop approach), easing in from the cruise, to a hover 0.55 above the pad.
- **Landing.** In the hover it turns to the pad's heading (turned a little either way per visit), then settles; the rotors run down to idle for a short stop or stop for a long one. The hover and the last of the settle wobble a little, per flight.
- **Out.** Spool-up on the pad, a vertical lift to the hover (wobbling), a turn onto the course, then nose down, accelerating and climbing steeply away.
- **Attitude.** Nose down with speed and while accelerating, up in the deceleration (the flare); a slow wander in bank and height in the air.
- **Lights.** Red and green navigation lights and a white tail light always, a red beacon while the rotors turn, white strobes in the air, a landing light near the pads.

## Drawing, selecting, riding

`render/helicopters.ts` keeps the pads of each loaded chunk (rescanned when chunkView rebuilds it), and every frame draws `helicoptersAt(pads, tick)`. The two airframes: a light twin on skids with a glazed nose and slim tail boom, four blades; a medium twin with a longer cabin, sponsons and wheels, a taller fin with a T-tailplane, five blades. Body and stripe are the operator's colours (`HELI_OPERATORS`), with per-airframe jitter and weathering. Main and tail rotor angles accumulate per flight with the rotor speed, so they never jump; translucent discs come up as the rotors reach speed.

Hovering a helicopter shows its tooltip: callsign and operator, what it is doing ("flying a patient in from Marlow", "landing at the general hospital", "out on patrol"), the type and registration, the altitude. Clicking selects it: the panel adds the route, speed, the patient or passengers, and the crew (a pilot; a paramedic and a doctor on an air ambulance, tactical flight officers on the police helicopter, a co-pilot on the medium twin). Right-click gives the vehicle menu. I or O rides in the cockpit (`HelicoptersView.cockpitOf`): the eye is in the right-hand seat behind the canopy, with the airframe's pitch and bank, and the flight instruments are calibrated like the planes'.

## Testing

`npx tsx packages/shared/scripts/heli-check.ts [days]` builds a town with every padded building in a server World, mirrors its chunks into a ClientWorld as the wire would, and checks that the server-side and client-side derivations give identical pads and timetables; that every pad matches a helipad drawn by chunkView (the design's op put through the model's placement matrix); that no pad's visits overlap and, sampled every half tick, no pad ever has two helicopters on it or in its hover; that flights stay inside their day; and the same for a dense synthetic city of 24 pads where onward flights compete.

`window.msc.helis` in the browser: `debugTick` freezes the helicopters at a tick, `at(tick)` lists them, `findPhase(phase, from, kind)` finds the next moment one is in a phase.
