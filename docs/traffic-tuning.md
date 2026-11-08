# Traffic tuning

Rush-hour traffic on the Commons, measured offline, and the rule changes and default values chosen from that
(2026-10-16). The goal: jams and queues that look real, no car ever drawn inside another car or a pedestrian, and
far fewer cars that silently vanish because the stuck rule gave up on them.

**Outcome.** Against the rules as they were, at the 08:00 and 17:00 rushes (12-seed means):

| | 08:00 old | 08:00 new | 17:00 old | 17:00 new |
| --- | --- | --- | --- | --- |
| give-ups (cars sent home or removed) | 804 | 163 | 464 | 97 |
| of those, removed from inside a junction box | 363 | 45 | 218 | 29 |
| mean speed | 23% | 36% | 26% | 39% |
| queued share | 71% | 57% | 69% | 55% |
| car–car body overlaps per tick | 0.145 | 0 | 0.071 | 0 |
| car–pedestrian contacts per tick, as the client draws them | 0.226 | 0.008 | 0.120 | 0.005 |

Give-ups drop 4.9× and 4.8× on the seeds the values were chosen on (1–12), and 4.2× on twelve held-out seeds
(13–24): just short of the 5× target. Turning off one option (`guardDrawn`, below) gives 5.4× / 5.2× over all
24 seeds, but leaves ten times more visible car–pedestrian contacts, so it stays on. Jams still happen: over half
the cars are queued at the peaks. On the live server at rush hour (probe-obb.mjs), car–car overlaps went from 0.08 to
0 per frame and car–pedestrian contacts from 0.38 to 0.000 (08:00) and 0.010 (17:00).

## Method

`packages/server/src/loadtest/ab.ts` builds a 1×1 test city (`seedCity`, the Commons layout, everything built to
level 3, about 950 citizens), runs it from midnight to the given hour of the second day (by then the population
has settled), then measures 1,500 ticks (15 game hours) every tick. `Math.random` is replaced with a seeded
generator, so a run is deterministic for its seed. Every traffic constant that matters is a field of
`TRAFFIC_TUNING` in `packages/shared/src/tuning.ts`, read where it is used, so `--set name=value,...` changes it for
the whole run; `old=1` first restores the rules as they were before this work. `ab-matrix.ts` runs a list of
settings over several seeds in parallel and prints the tables below; `ab-why.ts` is the diagnostic used to find
what each stuck car was waiting for.

```sh
npx tsx packages/server/src/loadtest/ab.ts --hour 8 --ticks 1500 --set stuckLimit=150,signalT=0
npx tsx packages/server/src/loadtest/ab-matrix.ts --hours 8,17 --seeds 1,2,3,4,5,6,7,8,9,10,11,12 --row "old=old=1" --row "new="
npx tsx packages/server/src/loadtest/ab-why.ts --hour 8 --ticks 1500 --stuckmap   # what held each car that gave up
```

What is measured:

- **Speed**: distance driven per tick as a share of each car's free speed, averaged over all cars on the road.
- **Queued**: share of car-ticks moving at under 30% of free speed (the same test as the congestion overlay's "held": section Congestion).
- **Give-ups**: trips ended by the stuck rule (a citizen sent home, a truck, visitor or patrol removed), counted
  in `Traffic.counters` (read-only). "In a box" is the subset removed while inside a junction tile. Cars that never
  get out of their garage are not counted: they were never on the road.
- **Driver commute**: mean ticks from leaving home to arriving at work for commuters who drove, over completed
  commutes (a give-up is not a completed commute, so the old rules look faster here than they are).
- **Junction entries**: cars entering a lane out of a junction tile, per tick: throughput through junctions.
- **Overlaps**: every tick, every pair of car bodies (oriented rectangles `VEHICLE_LEN` × `VEHICLE_WIDTH`) and every
  car against every pedestrian (a 0.07-radius disc), as in probe-obb.mjs. "Path" orients a car along its lane
  geometry; "as drawn" orients it the way the client does, facing the direction it last moved. On a tight turn the
  two differ by up to about 35°, so as drawn is what a player sees and what the live probe measures.

Seeds 1–12 were used to choose values; the final defaults were then checked on seeds 13–24. Between two runs of
the same setting on different seed sets the mean give-up count moves by about ±15 at 08:00, so differences
smaller than that are noise. Another agent was optimising `dispatch()` while this ran; every table below comes
from one run of one code version.

## What was wrong

Following individual stuck cars (ab-why.ts) showed that most give-ups were not traffic at all:

1. **The stuck clock counted every stopped tick on a trip.** A commute through four or five red lights reached 75
   ticks without ever being in a jam. In a run with the deadlock fixes below but the old clock, the commonest thing
   a car was waiting for when it gave up was a red light. Counting ticks since the car last reached a new tile fixes that, but on its own it makes things worse,
   because the early give-ups had been hiding real deadlocks.
2. **Deadlocks in the entry rules.** With no stuck rule at all the Commons locked solid within the first game hour.
   - *Driveways*: a car turning into a building waited for an empty forecourt, while the car pulling out of the
     same building waited for the arriving car to clear the road. A driveway's in and out lanes are straight and a
     lane apart, so they never touch; the forecourt now uses the conflict table.
   - *Rounding at the stop line*: a car stopped at its stop line could sit a rounding error past it and count as
     "in the next box", so two cars facing each other each waited for the other for ever. A car is now in a box on
     the way in once it has committed to entering, which also closes a race where a committed car short of the line
     was invisible to conflicting movements.
   - *Whole-path conflicts*: a car waiting at the far edge of a box still blocked every movement its earlier turn
     had crossed. Only the part of its path from its rear bumper on now counts.
   - *Waiting in the forecourt*: a car waiting to pull out stood in the forecourt and blocked cars arriving from
     the building's other side. Cars now wait in the garage until the road would let them in.
   - *Same approach, other exit*: a follower turning left across a leader that had stopped straight ahead in the
     box. This now uses the same remaining-path test.
3. **Stop lines were in lane-progress units.** Progress is a fraction of a lane, and a right-turn arc is only half
   a tile long, so a car stopped at the old line on a right-hand bend had its nose in the next tile.
4. **Re-routes could U-turn.** The congestion re-route searched from the tile ahead and could go straight back
   through the tile behind, which the lane geometry draws as driving through the box. Re-routes now never use
   the tile behind (this fix is in the "old rules" rows too).
5. **Car–car overlaps** came almost entirely from cars appearing at progress 0 inside a busy box (pulling out of an
   entry tile or the kerb), and the rest from the arc geometry above.
6. **Car–pedestrian contacts** had four sources: driveways (cars crossing the sidewalk had no rule at all), the
   one-tick crossing lag, the bounded waits (a car nosing through after 15 ticks, a pedestrian stepping out after
   20), and on turns the difference between a car's path and the way the client draws it.

## Build-up: one change at a time

Each row adds to the one above (12 seeds).

**08:00**

| setting | speed % | queued % | queued % first hour | give-ups | of which in a box | kerb+walk / withdrawn | driver commute (ticks) | junction entries / tick | car–car / tick | car–ped / tick (path) | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 old rules (today) | 23.2 | 71.0 | 67.5 | 804 | 363 | – | 51 | 3.6 | 0.145 | 0.229 | 0.226 |
| 1 stuck clock per tile | 15.0 | 80.9 | 70.4 | 638 | 201 | – | 72 | 3.0 | 0.136 | 0.302 | 0.301 |
| 2 forecourt by conflict, box by commitment | 19.4 | 75.9 | 60.5 | 439 | 124 | – | 68 | 4.0 | 0.098 | 0.300 | 0.301 |
| 3 remaining-path conflicts, arc-aware stop lines | 24.9 | 69.6 | 58.7 | 269 | 68 | – | 66 | 4.5 | 0.117 | 0.308 | 0.330 |
| 4 wait in the garage | 29.1 | 64.4 | 56.5 | 150 | 39 | – | 69 | 4.3 | 0.014 | 0.262 | 0.276 |
| 5 body guard, no walk-through, step back | 27.4 | 66.3 | 57.0 | 194 | 46 | – | 75 | 4.2 | 0.000 | 0.005 | 0.120 |
| 6 patient at lights, same approach by path, congestion 8 | 28.3 | 65.2 | 55.7 | 188 | 45 | – | 78 | 4.6 | 0.000 | 0.006 | 0.084 |
| 7 signal period 15, stuck limit 60 | 36.9 | 55.2 | 47.5 | 136 | 34 | – | 63 | 5.2 | 0.000 | 0.004 | 0.077 |
| 8 guard as drawn: the new defaults | 35.5 | 56.8 | 45.9 | 163 | 45 | – | 65 | 5.1 | 0.000 | 0.005 | 0.008 |

**17:00**

| setting | speed % | queued % | queued % first hour | give-ups | of which in a box | kerb+walk / withdrawn | driver commute (ticks) | junction entries / tick | car–car / tick | car–ped / tick (path) | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 old rules (today) | 26.0 | 68.7 | 73.1 | 464 | 218 | – | 44 | 2.2 | 0.071 | 0.125 | 0.120 |
| 1 stuck clock per tile | 17.4 | 78.9 | 83.1 | 380 | 127 | – | 52 | 2.0 | 0.053 | 0.160 | 0.161 |
| 2 forecourt by conflict, box by commitment | 22.7 | 72.9 | 79.1 | 240 | 73 | – | 45 | 2.6 | 0.037 | 0.155 | 0.152 |
| 3 remaining-path conflicts, arc-aware stop lines | 27.2 | 67.9 | 74.1 | 166 | 49 | – | 44 | 2.8 | 0.050 | 0.182 | 0.199 |
| 4 wait in the garage | 32.4 | 61.7 | 67.6 | 80 | 23 | – | 72 | 2.8 | 0.009 | 0.156 | 0.165 |
| 5 body guard, no walk-through, step back | 30.7 | 63.6 | 71.0 | 110 | 28 | – | 73 | 2.7 | 0.000 | 0.002 | 0.086 |
| 6 patient at lights, same approach by path, congestion 8 | 31.1 | 63.1 | 70.3 | 113 | 29 | – | 67 | 3.0 | 0.000 | 0.003 | 0.045 |
| 7 signal period 15, stuck limit 60 | 39.6 | 53.3 | 60.0 | 82 | 22 | – | 62 | 3.2 | 0.000 | 0.003 | 0.052 |
| 8 guard as drawn: the new defaults | 38.6 | 54.5 | 63.1 | 97 | 29 | – | 70 | 3.1 | 0.000 | 0.002 | 0.005 |

The deadlock fixes (rows 2–4) take give-ups from 638 to 150 at 08:00 and nearly remove car–car overlaps. The
body guard (row 5) is what removes contacts. It is a last resort behind all the rules: a car never moves its body onto a pedestrian or
another car ahead of it, and a pedestrian never steps into a car. It costs some give-ups, because a pedestrian and
a car can now hold each other up. To break that tie without a contact, a pedestrian held on a crossing for 10 ticks
steps back to the kerb. Row 8 extends the guard to bodies as drawn, which buys a further tenfold drop in visible
contacts for about 20% more give-ups.

## The matrix around the new defaults

Each row changes one setting from the new defaults (12 seeds).

**08:00**

| setting | speed % | queued % | queued % first hour | give-ups | of which in a box | kerb+walk / withdrawn | driver commute (ticks) | junction entries / tick | car–car / tick | car–ped / tick (path) | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old rules (today) | 23.2 | 71.0 | 67.5 | 804 | 363 | – | 51 | 3.6 | 0.145 | 0.229 | 0.226 |
| **new defaults** | 35.5 | 56.8 | 45.9 | 163 | 45 | – | 65 | 5.1 | 0.000 | 0.005 | 0.008 |
| stuck limit 75 | 31.5 | 61.5 | 50.7 | 187 | 51 | – | 78 | 4.9 | 0.000 | 0.005 | 0.009 |
| stuck limit 150 | 18.7 | 76.7 | 53.9 | 207 | 56 | – | 108 | 4.0 | 0.000 | 0.006 | 0.007 |
| stuck limit 300 | 11.0 | 86.1 | 60.2 | 140 | 38 | – | 151 | 2.8 | 0.000 | 0.006 | 0.008 |
| old stuck clock (every stopped tick on the leg) | 41.1 | 50.1 | 47.8 | 279 | 70 | – | 52 | 5.1 | 0.000 | 0.005 | 0.008 |
| never give up, re-route instead | 0.8 | 98.9 | 97.2 | 0 | 0 | – | 41 | 0.5 | 0.000 | 0.000 | 0.000 |
| re-route, abandon after 300 more (kerb / withdraw) | 3.9 | 94.7 | 86.0 | 0 | 0 | 60 / 99 | 252 | 1.3 | 0.000 | 0.006 | 0.007 |
| give up only clear of a box (kerb + walk) | 14.0 | 81.4 | 64.7 | 8 | 0 | 110 / 253 | 84 | 1.8 | 0.000 | 0.006 | 0.009 |
| release first car clear of a box instead | 31.7 | 61.2 | 50.1 | 242 | 15 | – | 71 | 4.6 | 0.000 | 0.004 | 0.007 |
| no T-junction lights | 37.8 | 54.3 | 39.9 | 218 | 54 | – | 69 | 5.4 | 0.000 | 0.005 | 0.008 |
| signal period 20 | 33.5 | 59.1 | 51.1 | 193 | 55 | – | 68 | 4.9 | 0.000 | 0.005 | 0.009 |
| signal period 30 | 30.5 | 62.8 | 54.8 | 214 | 61 | – | 81 | 4.8 | 0.000 | 0.005 | 0.008 |
| signal period 45 | 28.1 | 65.4 | 59.2 | 260 | 68 | – | 82 | 4.5 | 0.000 | 0.006 | 0.008 |
| actuated lights | 34.6 | 57.8 | 49.8 | 195 | 53 | – | 69 | 5.0 | 0.000 | 0.004 | 0.007 |
| same approach: keep the conflict | 33.5 | 59.2 | 49.8 | 196 | 47 | – | 63 | 4.8 | 0.000 | 0.006 | 0.010 |
| same approach: allow past box centre | 34.7 | 57.7 | 49.8 | 181 | 45 | – | 67 | 5.2 | 0.000 | 0.004 | 0.010 |
| car yield max 0 (never nose in) | 34.2 | 58.4 | 47.3 | 205 | 58 | – | 66 | 4.9 | 0.000 | 0.005 | 0.007 |
| car yield max 30 | 34.5 | 57.9 | 48.1 | 179 | 51 | – | 72 | 5.0 | 0.000 | 0.006 | 0.008 |
| crossing wait max 0 (never step out) | 32.0 | 60.9 | 47.3 | 286 | 64 | – | 70 | 4.5 | 0.000 | 0.006 | 0.006 |
| crossing wait max 40 | 33.3 | 59.3 | 47.3 | 211 | 57 | – | 70 | 4.9 | 0.000 | 0.009 | 0.009 |
| no crossing lag | 35.1 | 57.3 | 48.8 | 170 | 47 | – | 66 | 5.0 | 0.000 | 0.004 | 0.008 |
| pedestrian priority (unsignalled) | 34.1 | 58.5 | 50.3 | 182 | 47 | – | 68 | 4.9 | 0.000 | 0.004 | 0.009 |
| lane by length, room 1.4 (3 sedans) | 33.6 | 58.9 | 48.5 | 199 | 49 | – | 67 | 5.1 | 0.000 | 0.006 | 0.010 |
| don't block the box (junctions) | 34.7 | 57.7 | 49.0 | 178 | 47 | – | 63 | 4.9 | 0.000 | 0.006 | 0.011 |
| pedestrians walk through after 40 | 35.4 | 56.9 | 49.6 | 159 | 44 | – | 69 | 5.1 | 0.000 | 0.041 | 0.083 |
| guard by path only (not as drawn) | 36.9 | 55.2 | 47.5 | 136 | 34 | – | 63 | 5.2 | 0.000 | 0.004 | 0.077 |
| car ownership 0.55 | 36.3 | 55.9 | 47.2 | 151 | 40 | – | 66 | 4.9 | 0.000 | 0.006 | 0.011 |

**17:00**

| setting | speed % | queued % | queued % first hour | give-ups | of which in a box | kerb+walk / withdrawn | driver commute (ticks) | junction entries / tick | car–car / tick | car–ped / tick (path) | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old rules (today) | 26.0 | 68.7 | 73.1 | 464 | 218 | – | 44 | 2.2 | 0.071 | 0.125 | 0.120 |
| **new defaults** | 38.6 | 54.5 | 63.1 | 97 | 29 | – | 70 | 3.1 | 0.000 | 0.002 | 0.005 |
| stuck limit 75 | 34.3 | 59.4 | 64.7 | 116 | 32 | – | 63 | 3.0 | 0.000 | 0.003 | 0.005 |
| stuck limit 150 | 20.6 | 75.2 | 79.6 | 154 | 41 | – | 73 | 2.5 | 0.000 | 0.005 | 0.006 |
| stuck limit 300 | 10.0 | 87.7 | 88.6 | 152 | 40 | – | 149 | 1.9 | 0.000 | 0.004 | 0.006 |
| old stuck clock (every stopped tick on the leg) | 44.1 | 48.0 | 55.9 | 160 | 39 | – | 64 | 3.1 | 0.000 | 0.003 | 0.005 |
| never give up, re-route instead | 0.3 | 99.6 | 99.1 | 0 | 0 | – | 21 | 0.2 | 0.000 | 0.000 | 0.000 |
| re-route, abandon after 300 more (kerb / withdraw) | 2.0 | 97.1 | 95.1 | 0 | 0 | 75 / 101 | 426 | 0.6 | 0.000 | 0.004 | 0.005 |
| give up only clear of a box (kerb + walk) | 8.0 | 89.4 | 83.5 | 6 | 0 | 76 / 170 | 121 | 0.7 | 0.000 | 0.004 | 0.006 |
| release first car clear of a box instead | 34.7 | 58.8 | 66.7 | 134 | 11 | – | 66 | 2.8 | 0.000 | 0.002 | 0.005 |
| no T-junction lights | 39.8 | 53.1 | 59.2 | 137 | 35 | – | 45 | 3.2 | 0.000 | 0.003 | 0.006 |
| signal period 20 | 37.0 | 56.3 | 63.6 | 109 | 30 | – | 66 | 3.2 | 0.000 | 0.003 | 0.006 |
| signal period 30 | 33.7 | 60.2 | 67.7 | 125 | 37 | – | 55 | 3.1 | 0.000 | 0.003 | 0.006 |
| signal period 45 | 30.5 | 63.7 | 68.2 | 151 | 42 | – | 60 | 2.9 | 0.000 | 0.003 | 0.004 |
| actuated lights | 37.0 | 56.3 | 62.9 | 121 | 34 | – | 49 | 3.2 | 0.000 | 0.002 | 0.006 |
| same approach: keep the conflict | 37.2 | 56.0 | 65.6 | 114 | 28 | – | 73 | 3.0 | 0.000 | 0.003 | 0.006 |
| same approach: allow past box centre | 37.5 | 55.6 | 61.7 | 106 | 24 | – | 66 | 3.2 | 0.000 | 0.003 | 0.006 |
| car yield max 0 (never nose in) | 36.5 | 56.8 | 66.7 | 128 | 36 | – | 59 | 3.0 | 0.000 | 0.003 | 0.004 |
| car yield max 30 | 37.4 | 55.8 | 65.2 | 108 | 32 | – | 58 | 3.1 | 0.000 | 0.003 | 0.005 |
| crossing wait max 0 (never step out) | 33.8 | 59.9 | 65.5 | 186 | 39 | – | 67 | 2.7 | 0.000 | 0.003 | 0.003 |
| crossing wait max 40 | 36.0 | 57.4 | 65.1 | 129 | 38 | – | 63 | 3.0 | 0.000 | 0.003 | 0.006 |
| no crossing lag | 37.9 | 55.3 | 62.5 | 104 | 29 | – | 62 | 3.1 | 0.000 | 0.002 | 0.004 |
| pedestrian priority (unsignalled) | 36.7 | 56.5 | 64.2 | 107 | 29 | – | 62 | 3.1 | 0.000 | 0.003 | 0.006 |
| lane by length, room 1.4 (3 sedans) | 36.1 | 57.3 | 64.2 | 127 | 32 | – | 71 | 3.2 | 0.000 | 0.003 | 0.006 |
| don't block the box (junctions) | 37.9 | 55.2 | 63.0 | 106 | 28 | – | 66 | 3.1 | 0.000 | 0.004 | 0.008 |
| pedestrians walk through after 40 | 39.1 | 53.8 | 59.9 | 79 | 23 | – | 60 | 3.2 | 0.000 | 0.022 | 0.057 |
| guard by path only (not as drawn) | 39.6 | 53.3 | 60.0 | 82 | 22 | – | 62 | 3.2 | 0.000 | 0.003 | 0.052 |
| car ownership 0.55 | 38.7 | 54.4 | 62.7 | 92 | 22 | – | 52 | 3.0 | 0.000 | 0.002 | 0.004 |

Reading the matrix:

- **Stuck limit.** A longer limit does not reduce give-ups until 300 ticks, and by then the city is close to
  gridlock (11% speed). Of the limits that keep traffic moving, 60 ticks (12 game minutes without reaching a new
  tile) gives the fewest give-ups and the best flow. "Never give up", with or without re-routing instead, locks
  the whole city within the hour, so some release valve is needed.
- **Visible-safe give-ups.** Every variant that avoids removing a car from inside a junction box makes things
  worse. Waiting until it is clear of the box, then parking at the kerb, leaves cars stuck in boxes and kerb-parked
  cars taking lane space: speed falls to 8–14%. Releasing the first car clear of a box along the chain holding it
  up instead does not unblock the junction: 49% / 38% more give-ups. The car stuck in the box is the one that has to
  go. What the new rules do instead is make it rare: 45 removals from inside a box at 08:00 against 363.
- **Signals.** A short phase is better on the Commons' short blocks: 15 ticks beats 20, 30 and 45 on speed,
  queues and give-ups. With no lights at T-junctions traffic moves a little faster but deadlocks more, giving a
  third to two-fifths more give-ups. Actuation (holding a green while nobody waits on red, up to twice the period)
  is worse than fixed timing at 15 ticks, with 20–25% more give-ups. It is also server-only, so the client's lamps
  would be wrong.
- **Crossings.** Never letting a pedestrian step into a busy box costs 75–90% more give-ups, and never letting a
  car nose in costs about 30% more: each lets a stream of one kind starve the other. With the guard on, the
  one-tick crossing lag no longer causes contacts, and removing it is within noise, so it stays. Pedestrian
  priority at unsignalled crossings is slightly worse. Letting a pedestrian walk through a car after 40 ticks cuts
  give-ups by 2% (08:00) to 18% (17:00) but makes visible contacts ten times more frequent.
- **Lane capacity.** Admitting a third sedan when lengths allow (`laneByLength`, room 1.4 tiles) is worse, with
  about 22% more give-ups at 08:00. "Don't block the box", which only enters a junction if the tile after it will
  take you, is slightly worse.
- **Demand.** Car ownership at 0.55 instead of 0.7 changes give-ups by under 10%. Two-thirds of the remaining
  give-ups are visitors and delivery trucks, not commuters (four-fifths under the old rules).

## Held-out check and live probes

On seeds 13–24, which played no part in choosing the values: old rules 786 / 456 give-ups at 08:00 / 17:00;
new defaults 186 / 110, a 4.2× cut at both. With `guardDrawn=0` the new rules give 160 / 94, a 4.9× cut, with
car–pedestrian contacts as drawn of 0.100 / 0.076 per tick.

Live dev server (ws :8080, the real Commons), probe-obb.mjs over 60 s after a 15 s warm-up:

| | cars at most | car–car / frame | car–ped / frame |
| --- | --- | --- | --- |
| before (previous agent's measurement) | | 0.08 | 0.38 |
| new defaults, 07:30 onwards | 159 | 0 | 0.000 |
| new defaults, 16:30 onwards | 233 | 0 | 0.010 |
| same with `guardDrawn=0`, 07:30 / 16:30 | 171 / 255 | 0 / 0 | 0.218 / 0.114 |

probe-stuck.mjs straight after each run showed 40–68% of cars queued.

## Chosen values

All in `TRAFFIC_TUNING`; each is documented where it is defined.

- `stuckClock: 1`, `stuckLimit: 60`, `stuckReroute: 0`: give up after 60 ticks without reaching a new tile.
- `boxByCommit`, `forecourtConflict`, `conflictRemaining`, `arcAware`: 1, the deadlock and geometry fixes.
- `sameApproachRelax: 2`: same approach, other exit, judged by the rest of the leader's path.
- `spawnClear: 2`: a car pulls out only when the box is empty and the road tile would let it in.
- `bodyGuard`, `carGuard`: 1; `guardWaitMax: 0`, so a pedestrian never walks through a car;
  `pedRetreatAfter: 10`; `guardDrawn: 7`, so the guard also protects bodies as drawn.
- `signalPeriod: 15`, shared with the client: lamps change about every 3 real seconds, ±20% per junction.
- `pedSignalPatient: 1`: at lights, never across a red or into a busy box.
- `congestionWeight: 8`: a fully congested tile costs 9 instead of 5 when routing, so drivers use alternatives
  sooner. (Since 2026-10-26 congestion is how held up a tile's cars are, section Congestion: a standstill reads about 1,
  a busy street that flows 0; 8 was kept.)
- Unchanged: `signalT: 1`, `carYieldMax: 15`, `crossingWaitMax: 20`, `crossingLag: 1`, `pedPriority: 0`,
  `laneCap: 2`, `boxClear: 0`, `signalActuated: 0`.

**Cost.** The simulation tick on the 1×1 city goes from 0.42 to 0.65 ms at 08:00 and from 0.26 to 0.43 ms at
17:00. About 0.16 ms of that is the guard (roughly 1.5 µs per car per tick); the rest is more cars staying on the
road. That is a few ms per tick at the 6×6 load-test city, inside the 50 ms budget.

**Known gaps.**
- Over a quarter of the remaining give-ups still remove a car from inside a junction box.
- Cars parked at the kerb (when a destination is full) are not drawn by the client.
- Most of the remaining as-drawn contacts are a pedestrian starting to walk from a door while a car is in the same
  forecourt, inside the building's footprint.

## What the player can do about jams

Measured with the same harness, new rules, 12 seeds:

**08:00**

| setting | speed % | queued % | queued % first hour | give-ups | of which in a box | driver commute (ticks) | junction entries / tick | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| new defaults | 35.5 | 56.8 | 45.9 | 163 | 45 | 65 | 5.1 | 0.008 |
| no parking lots | 34.7 | 57.0 | 49.1 | 168 | 48 | 69 | 4.9 | 0.010 |
| no signals technology | 43.6 | 47.3 | 32.3 | 179 | 43 | 52 | 5.5 | 0.009 |
| ring road round the district | 34.3 | 58.8 | 49.0 | 234 | 57 | 62 | 6.2 | 0.008 |
| old rules | 23.2 | 71.0 | 67.5 | 804 | 363 | 52 | 3.6 | 0.226 |
| old rules, no signals | 31.3 | 61.4 | 44.7 | 690 | 241 | 42 | 4.5 | 0.234 |
| old rules, no lots | 23.4 | 70.4 | 66.3 | 762 | 348 | 50 | 3.5 | 0.216 |

**17:00**

| setting | speed % | queued % | queued % first hour | give-ups | of which in a box | driver commute (ticks) | junction entries / tick | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| new defaults | 38.6 | 54.5 | 63.1 | 97 | 29 | 70 | 3.1 | 0.005 |
| no parking lots | 37.8 | 54.6 | 62.3 | 99 | 28 | 60 | 3.1 | 0.007 |
| no signals technology | 46.0 | 45.8 | 56.9 | 112 | 28 | 39 | 3.3 | 0.006 |
| ring road round the district | 36.3 | 57.6 | 63.4 | 158 | 37 | 45 | 3.9 | 0.005 |
| old rules | 26.0 | 68.7 | 73.1 | 464 | 218 | 44 | 2.2 | 0.120 |
| old rules, no signals | 34.2 | 59.1 | 68.5 | 413 | 165 | 33 | 2.6 | 0.128 |
| old rules, no lots | 26.4 | 67.9 | 72.8 | 454 | 215 | 39 | 2.2 | 0.120 |

- **Signals are not a cure on a dense grid.** Without the signals technology every junction is give-way, and
  traffic on the Commons moves faster: 44% against 36% at 08:00, with driver commutes 20% shorter. It deadlocks a
  little more, with 10–16% more give-ups. On blocks four tiles long the technology blurb's "roughly doubling what a
  busy junction can carry" does not hold. A busy crossroads between long roads, where lights might pay off, is not
  something this test city has.
- **Parking lots barely matter here.** Removing the Commons' four lots changes nothing measurable: most cars find
  a space at their destination. Lots matter where destinations are full, because those cars then park at the
  kerb, which takes a lane slot. The parking "turned away" counts in building tooltips show where that happens.
- **More road is not automatically more capacity.** A ring road two tiles outside the district, joined to every
  street, made things worse (40–60% more give-ups). It added a junction at the end of every street and moved the
  visitor entry points out to its corners. The give-ups cluster where routes funnel: the junctions along the second
  street from the north edge, and the four corner tiles every visitor enters and leaves by. A parallel road can
  only help if it gives those same trips another way in without adding many junctions.
- **The load is mostly visitors and freight.** Cutting car ownership from 0.7 to 0.55 changes little, and
  two-thirds of give-ups are trucks and visitors. Where commercial and industrial zones sit, and so where that
  traffic converges, likely matters more than how many residents drive. This test did not measure that.

## Re-route on cumulative delay

Drivers already re-route when held up: after 10 ticks at a standstill, at an id-staggered cadence (every 25 ticks), if
the alternative costs under 85% of the rest of the route, and never back through the tile behind. The card extended
this to react to **cumulative delay**: when a drive leg starts, the simulation records the leg's expected time
(route cost at departure divided by free-flow speed, `Simulation.startTrack`) and the start tick. A driver whose
elapsed time exceeds that by `delayFrac` (40%) and by at least `delayMinTicks` (20) is *running late*, and
`maybeReroute` then also considers it at the same cadence **even while creeping**, searching up to `delayNodes`
(12,000 instead of 4,000) A* nodes. Everything else is unchanged: the per-tick budget of 40 searches, the 50-tick gap
between tries, the hysteresis (`delayGain`, 0.85), no U-turn through the tile behind, the current lane stays the first
segment, and nothing happens once committed into the next box or past half the lane. After a successful re-route
the leg's expectation is rebased on the new route. At most `delayMax` (3) late re-routes per leg. Walkers are
skipped. It is behind `delayReroute` in `TRAFFIC_TUNING`.

Counts: per citizen per trip (shown in the citizen panel as "Re-routed N times this trip" when N > 0, from the
optional `CitizenInfo.reroutes`) and per citizen per game day (`Simulation.reroutesOf(m)`). The harness reads
`Simulation.rerouteLog` (held-up, late, forced, searches tried for lateness, and a total per game day).

**Result: it does not help on the Commons, so `delayReroute` stays 0 (off).** 24 seeds (1–24), 1,500 ticks, the same
test city and measures as above. Rows differ only in the re-route settings. "Drive commute" is the mean for completed
driver commutes, so cars that gave up are not in it.

**08:00**

| setting | speed % | queued % | give-ups | drive commute (ticks) | held-up re-routes | late re-routes (searches) | re-routes per car | most for one citizen in a day | car–car / tick (as drawn) | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off (default) | 34.1 | 58.5 | 197.5 | 67.4 | 116 | 0 | 0.081 | 3 | 0.000 | 0.0094 |
| on, 40% and 20 ticks | 33.5 | 59.3 | 209.2 | 67.8 | 40 | 136 (796) | 0.123 | 3 | 0.000 | 0.0081 |
| on, 80% and 30 ticks | 33.8 | 59.0 | 204.5 | 69.1 | 53 | 118 (645) | 0.120 | 3 | 0.000 | 0.0119 |
| on, 40% and 20 ticks, gain 0.95, max 4 | 33.7 | 59.1 | 209.6 | 67.0 | 41 | 277 (754) | 0.222 | 3 | 0.000 | 0.0086 |
| on, 20% and 10 ticks, gain 1, max 6 | 33.3 | 59.5 | 215.3 | 63.8 | 30 | 576 (916) | 0.420 | 4 | 0.000 | 0.0096 |

**17:00**

| setting | speed % | queued % | give-ups | drive commute (ticks) | held-up re-routes | late re-routes (searches) | re-routes per car | most for one citizen in a day | car–car / tick (as drawn) | car–ped / tick (as drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off (default) | 37.1 | 56.1 | 116.9 | 56.2 | 68 | 0 | 0.068 | 3 | 0.000 | 0.0058 |
| on, 40% and 20 ticks | 37.0 | 56.3 | 118.4 | 60.9 | 21 | 85 (458) | 0.106 | 3 | 0.000 | 0.0047 |
| on, 80% and 30 ticks | 36.9 | 56.4 | 121.5 | 61.9 | 29 | 78 (396) | 0.107 | 3 | 0.000 | 0.0080 |
| on, 40% and 20 ticks, gain 0.95, max 4 | 36.7 | 56.5 | 123.1 | 55.4 | 21 | 172 (458) | 0.194 | 3 | 0.000 | 0.0060 |
| on, 20% and 10 ticks, gain 1, max 6 | 36.6 | 56.6 | 122.3 | 59.1 | 16 | 340 (529) | 0.356 | 4 | 0.000 | 0.0053 |

Paired by seed (on minus off, mean ± standard error over 24 seeds):

| setting | 08:00 give-ups | 08:00 drive commute | 17:00 give-ups | 17:00 drive commute |
| --- | --- | --- | --- | --- |
| 40% and 20 ticks | +11.8 ± 8.8 | +0.4 ± 2.6 | +1.5 ± 8.1 | +4.7 ± 4.3 |
| 80% and 30 ticks | +7.0 ± 7.6 | +1.7 ± 2.4 | +4.7 ± 6.3 | +5.7 ± 3.5 |
| 40% and 20 ticks, gain 0.95, max 4 | +12.1 ± 9.1 | −0.5 ± 2.4 | +6.3 ± 7.1 | −0.7 ± 3.6 |
| 20% and 10 ticks, gain 1, max 6 | +17.9 ± 9.4 | −3.6 ± 2.0 | +5.4 ± 6.1 | +2.9 ± 3.1 |

Reading it:

- No setting reduces give-ups. Every one has slightly more (up to +9% at 08:00, within about two standard errors), and
  speed is 0.2–0.8 points lower. None improves trip time at both peaks: the most eager setting is 3.6 ticks shorter
  at 08:00 and 2.9 ticks longer at 17:00, and it is measured over completed commutes only.
- Car–car overlaps stay 0 as drawn and by path. Car–pedestrian contacts as drawn stay in the 0.005–0.012 range of the
  off rows (the changes are within the seed noise; none is a trend).
- The late test fires on a large share of ordinary legs: even with the feature off, 41% (08:00) and 38% (17:00) of
  driven legs end more than 40% and 20 ticks later than the free-flow expectation (median elapsed / expected 1.4, 90th
  percentile 4.6), because lights, turns and queues at junction boxes are the normal condition at the peaks. So
  lateness alone cannot separate a jam from a normal trip. What decides is whether a clearly cheaper route exists, and on
  a grid of short blocks the answer is almost always no: the same junctions sit on every alternative.
- The late re-routes mostly *replace* the held-up ones (116 → 40 held-up at 08:00), so the extra re-routes per car
  (0.08 → 0.12) are mostly the same cars being re-routed earlier or on a wider search.
- Cost: a late search is 4,000–12,000 nodes, 500–900 per 1,500 ticks across the whole city, well under one per tick;
  the tick time was not measurably different (noise of ±0.3 ms from other load on the machine).

The setting is kept in case a bigger city has long routes with real alternatives (not tested here): turn it on with `--set delayReroute=1` offline or `delayReroute: 1` in
`TRAFFIC_TUNING`. New tunables: `delayReroute: 0`, `delayFrac: 0.4`, `delayMinTicks: 20`, `delayNodes: 12000`,
`delayGain: 0.85`, `delayMax: 3`. The harness prints re-routes by kind, per car and the most for one citizen in a day,
and the elapsed / expected distribution of the driven legs (`legs` and `reroute` in the JSON).

Live dev server (feature off), probe-obb.mjs over 60 s after 15 s, late afternoon (229 cars at most): car–car 0, car–pedestrian 0.087 per frame.

**Search cost (2026-10-19, docs/search-perf.md).** In London three in four held-up re-route searches found the way the
driver was already on. A re-route search now stops as soon as nothing it could still find would be taken (its cheapest
open node already costs `worse`, 0.85 × the rest of the current route), which takes exactly the same re-routes for 37%
less A\* time. Two new tunables keep the old fixed values: `rerouteCooldown: 50` (ticks between one driver's searches)
and `rerouteNodes: 4000` (a held-up driver's node budget). A cooldown of 100 or a budget of 1,000 or 2,000 saved
0.1–0.2 ms a tick more and took 4–22% fewer re-routes, with the traffic within about 1%; neither was adopted.

## Buses

Buses (docs/transit.md) are 0.6-tile vehicles in this traffic model. They pull in on the stop's road tile in their lane,
so everything behind them waits. The harness lays the test network with `ab.ts --set bus=3`: a depot and twelve stops
on two lines over the Commons (a six-stop loop round the inner ring, a six-stop there-and-back line down the middle
street), three buses per line. The depot and stops replace 18 zoned tiles, so the city has about 73 fewer citizens.
**`busTiles=1` is the fair control**: the same tiles taken, no lines run. Six seeds (1–6), 1,500 ticks from 08:00 and
from 17:00. "Cars" counts vehicles on the road per tick excluding buses. "Trip" is every trip, door to door. Overlaps
are true body overlaps per tick; bus–car overlaps are included in car–car and also counted on their own.

**08:00**

| run | citizens | trips | by transit | transit trips | trip mean (ticks) | transit trip mean | cars mean | cars peak | buses | give-ups | speed % | car–car | bus–car | car–ped | car–ped as drawn | boarded / gave up waiting / buses withdrawn | calls / stops passed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no buses (Commons as is) | 945 | 1664 | 0% | 0 | 47.9 | – | 94.5 | 142 | 0 | 199.0 | 34.0 | 0.000 | 0.000 | 0.0063 | 0.0094 | – | – |
| control: depot and stops, no lines | 873 | 1523 | 0% | 0 | 45.5 | – | 89.7 | 136 | 0 | 150.8 | 36.3 | 0.000 | 0.000 | 0.0057 | 0.0087 | – | – |
| buses, 3 per line | 872 | 1525 | 0.43% | 6.0 | 47.0 | 326 | 89.4 | 133 | 5.3 | 172.5 | 34.5 | 0.000 | 0.000 | 0.0036 | 0.0073 | 5.3 / 1.5 / 5.7 | 8 / 138 |

**17:00**

| run | citizens | trips | by transit | transit trips | trip mean (ticks) | transit trip mean | cars mean | cars peak | buses | give-ups | speed % | car–car | bus–car | car–ped | car–ped as drawn | boarded / gave up waiting / buses withdrawn | calls / stops passed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no buses (Commons as is) | 946 | 1202 | 0% | 0 | 47.2 | – | 56.8 | 130 | 0 | 122.5 | 36.9 | 0.000 | 0.000 | 0.0039 | 0.0059 | – | – |
| control: depot and stops, no lines | 873 | 1120 | 0% | 0 | 44.7 | – | 54.1 | 129 | 0 | 90.7 | 38.7 | 0.000 | 0.000 | 0.0019 | 0.0032 | – | – |
| buses, 3 per line | 873 | 1133 | 0.16% | 3.0 | 45.9 | 404 | 53.3 | 124 | 3.1 | 85.2 | 39.0 | 0.000 | 0.000 | 0.0019 | 0.0030 | 1.8 / 0.2 / 2.0 | 4 / 88 |

Buses against the control, paired by seed (mean ± standard error over six seeds):

| | give-ups | speed points | trip mean (ticks) | cars on the road | car–ped per 1,000 ticks |
| --- | --- | --- | --- | --- | --- |
| 08:00 | +21.7 ± 9.2 | −1.8 ± 0.8 | +1.5 ± 0.9 | −0.2 ± 1.5 | −2.1 ± 0.8 |
| 17:00 | −5.5 ± 6.7 | +0.3 ± 0.6 | +1.2 ± 0.6 | −0.8 ± 1.4 | +0.0 ± 0.8 |

Reading it:

- **Bodies stay apart.** Car–car and bus–car overlaps are 0 in every run, by path and as drawn. Car–pedestrian contacts
  do not rise: lower at 08:00, unchanged within noise at 17:00. Riders waiting at a stop stand on the stop tile, off the
  carriageway, and riders on board are inside the bus, not counted as pedestrians.
- **Hardly anyone takes the bus in the Commons, and that is the model working as written, not a fault.** About 0.4% of
  trips at 08:00 and 0.16% at 17:00 go by transit, a handful of riders per run. Three things in the Commons work against
  buses. Commutes are to the nearest job (median 3 tiles, 90th percentile 8), and only trips of 7+ tiles are offered
  the bus. In this congestion a bus moves at about walking pace, junctions every five tiles. And the walk to a stop and
  the wait use up most of what a bus saves on trips this short. Transit trips take 330–400 ticks door to door, against
  about 46 for all trips: the people who choose the bus are on the long trips.
- **The buses cost the morning peak a little.** Against the control, give-ups are up by about 22 at 08:00 (two standard
  errors) and speed is down 1.8 points: five long vehicles on a saturated grid, each holding a lane when it stops. At
  17:00 there is no difference. At 08:00, against the control, the steps were:

  | version | give-ups vs control | buses withdrawn per run |
  | --- | --- | --- |
  | first version: a bus stops at every call, a stuck bus waits twice the stuck limit | +44.8 | 2.0 |
  | request stops (pull in only for someone getting off or waiting) | +48.7 | 1.5 |
  | the same with a car-length bus (0.34 instead of 0.6), sensitivity only | +29.9 | 1.0 |
  | request stops, a stuck bus withdrawn at the stuck limit with no re-route, sensitivity only | +17.9 | 8.3 |
  | request stops, one way round at the stuck limit, withdrawn ten ticks later | +35.3 | 5.5 |
  | **shipped**: the same, and drivers on their way in count at a shift change (no buses called in and sent out again) | **+21.7** | 5.7 |

  The standard errors are 9–19, so only the overall direction is firm. Request stops take the dwelling out (at
  Commons ridership a bus now passes about 95% of its calls) but do not measurably change give-ups. Treating a stuck
  bus like a stuck car does, and so does keeping the fleet steady through shift changes. Withdrawing a bus at the
  limit, with no re-route first, looked better still, but it also withdraws a bus about every three game hours and
  sets its riders down mid-route. The shipped rule tries the way round first. No anti-bunching hold happens while
  anything is queued behind the bus.
- **Cars on the road do not fall.** Ridership is too low to take cars off. The bus share is mostly people without a car
  on long trips, and car owners only consider the bus when the car is at home and the trip is long.

Where buses should earn their keep: bigger cities with longer trips, owners who put stops where homes are dense and
jobs are far, and roads that are not already saturated. The 4×4 load test with a depot and two lines in every district
(`run.ts --bus 3`, docs/load-tests.md) shows what 32 lines and about 70 buses cost the tick.

Live, in a standalone 1×1 test city (the Commons plus a player's 18×22 plot east of it, with a depot, eight stops and
two lines, about 1,380 people), `probe-obb.mjs` (bus length added: `LEN[3] = 0.6`) over 60 s after 15 s: car–car 0 with
up to 5 buses and 256 cars on the road. Car–pedestrian contacts were 0.11 and 0.36 per frame in two runs; a breakdown
of the second (`probe-obb-bus.mjs`) found none involving a bus and none involving anyone waiting at a stop. That city
had become very congested (68–81% of vehicles queued).

### Turning round (2026-10-17)

Bus laps may now turn round (docs/transit.md "The lap"): a three-point turn that has the whole box to itself, and a bus
held at its stop line before a junction instead of overshooting it on entering the lane. The first scenario run
(`loadtest/busroutes.ts`) gridlocked a stub with a turn at each end: a bus coming out of its three-point turn in a
junction mouth was held by the body guard against a bus waiting in the side road whose nose was 0.13 into the box
(a 0.6-tile bus enters a lane up to 0.3 in, past its 0.17 stop line), and that one waited for the box. With the cap,
no bus is withdrawn there.

A/B on the Commons, `ab.ts --ticks 1500 --set bus=3`, six seeds at 08:00 and at 17:00, the build before 49fd1fb against
this work (with `busTiles=1`, no lines, the two ran identically in a first, shorter A/B). A first version planned
the there-and-back line round a 2×2 square of road at its south end (4 tiles, 6 shorter than round the block), a turn
round squeezed through two junction boxes, and cost about 1.4 speed points; two turns the same way on neighbouring tiles
now cost a lap 20 more (`DOUBLE_TURN`, sim/busroute.ts), so it goes round the block again (110 tiles, as before).
No bus turns round in these runs. Paired differences, mean ± standard error over six seeds:

| | speed points | give-ups | trip mean (ticks) | buses withdrawn | ms/tick |
| --- | --- | --- | --- | --- | --- |
| 08:00 | +0.1 ± 0.4 (28.8 → 28.9%) | +6 ± 20 | −0.9 ± 1.3 | −0.7 ± 1.5 | +0.18 ± 0.17 |
| 17:00 | +0.9 ± 0.9 (32.6 → 33.4%) | −19 ± 15 | −3.5 ± 3.9 | +0.2 ± 0.9 | −0.09 ± 0.07 |

No loss against the build before: every difference is within its noise.

## Roundabouts and flyovers

Two junction types beyond give-way and lights (2026-10-17; design in docs/structures.md section 4, code in
`shared/src/junctions.ts`): a **roundabout**, a 3×3 one-way ring round an island (anticlockwise, traffic drives on the
right), and a **flyover**, a crossroads tile whose two roads are on different levels.

**Bench.** `packages/server/src/loadtest/junctions.ts` builds one crossroads (arms 10 tiles each way to a dead end) four
ways, runs the real traffic model on it with Poisson demand from the four ends, and measures 20 game hours after a
300-tick warm-up, 3 seeds. Demand is cars per game hour over all four approaches. "Straight" sends every car straight
over; "turns" 60% straight, 20% right, 20% left. Delay is game minutes per completed trip beyond free flow, counting
the wait to get on; give-ups are the stuck rule; overlaps are true car-car body overlaps per tick (oriented
rectangles; a car on the deck and one on the road beneath never count). There are no pedestrians in the bench.

```sh
npx tsx packages/server/src/loadtest/junctions.ts --rates 15,25,35,50 --seeds 1,2,3 --ticks 2000 --mix turns
npx tsx packages/server/src/loadtest/junctions.ts --rates 25 --kinds roundabout --set ringYield=0   # one knob
```

Straight over (demand / served throughput / mean delay in game minutes):

| demand / h | give-way | signals | roundabout | flyover |
| --- | --- | --- | --- | --- |
| 60 | 59 / 3.0 min | 59 / 11.8 min | 60 / 4.4 min | 59 / 1.2 min |
| 100 | 79 / 135 min | 67 / 221 min | **85** / 71 min | **96** / 2.1 min |
| 140 | 74 / 326 min | 62 / 407 min | 80 / 281 min | **137** / 7.2 min |
| 200 | 65 | 52 | 72 | **146** / 171 min |

With turns (the flyover serves only the straight 60%: nobody can turn there, so turning cars have no route through
it and drive round by the next junction in a real city):

| demand / h | give-way | signals | roundabout | flyover (straight share) |
| --- | --- | --- | --- | --- |
| 60 | 59 / 8.6 min, 1 give-up | 51 / 98 min, 10 | **60** / 4.6 min, 0 | 36 of 36 / 0.9 min |
| 100 | 62 / 252 min, 15 | 46 / 387 min, 15 | **81** / 99 min, 0 | 59 of 60 / 1.2 min |
| 140 | 55 / 430 min, 22 | 40 / 556 min, 14 | **76** / 310 min, 0 | 84 of 84 / 1.8 min |
| 200 | 48, 18 | 31, 11 | **67**, 0 | 117 of 120 / 3.4 min |

Car-car body overlaps were 0 in every run. Readings: a flyover carries straight traffic with almost no delay up to
about 140 cars an hour (the arms, not the crossing, are then the limit). A roundabout carries about 30% more than a
give-way crossroads with turning traffic and twice what fixed-time lights do, with no give-ups; with straight traffic
only it is about 8% ahead of give-way. Lights do worst here: symmetric flows and no pedestrians are the case where
fixed-time phases only add waiting, so this bench says nothing about what they do in a city.

**The roundabout knobs** (`TRAFFIC_TUNING`, turns, 3 seeds, at 100 and 140 cars an hour: throughput, give-ups):

| setting | 100 / h | 140 / h | note |
| --- | --- | --- | --- |
| defaults (`ringYield` 0.7, `ringMerge` 1, `ringSlow` 1, `ringSpare` 4) | 80, 0 | 75, 0 | |
| `ringYield=0` (first come, first served) | 0, 358 | 0, 375 | the ring fills with cars coming on and locks within the hour |
| `ringYield=0.4` | 75, 24 | 65, 43 | too short a gap: cars squeeze on and the ring stalls |
| `ringYield=1.2` | 72, 1 | 67, 1 | too cautious |
| `ringMerge=0` (plain junction box rules on the ring) | 62, 0 | 56, 3 | a car joining waits until the one ahead is out of the box |
| `ringSlow=0.8` (slow for the turns on and off) | 69, 0 | 63, 3 | |
| `ringSlow=0.6` (as at a plain junction) | 39, 93 | 31, 94 | slow joiners hold the merge box so long the ring jams |
| `ringSpare=0` / `2` | 80, 0 | 74, 2 | rare locks of a full ring |
| `ringSpare=8` | 68, 5 | 62, 6 | the ring kept half empty |

What had to change for the ring to work in a tile-box model, in the order it was found: give way only to a circulating
car that **stays on the ring past the entry** (cars leaving by that arm never cross the joiner; yielding to them too cut
throughput by half); treat joining the ring lane behind a car already out in it as **following** (`ringMerge`); never
let the ring **fill** (`ringSpare`: with every lane round it at capacity each car waits for room in the next and none
ever moves, a real gridlock the bench reproduced in a few minutes); the ring's corners are wide (radius 0.69 tile) and
cost no speed. Pedestrians cross the arms, not the ring: a car going round never drives over a crossing there, so
people on it hold only the cars coming on or leaving, and a walk round a corner follows the outer kerb instead of
counting as a diagonal crossing of the box.

**Live** (the showcase demo, standalone on port 8297, with the roundabout at (-20, -6) and the flyover at (-25, -1),
bus line 1 on the deck and line 2 under it): `probe-obb-junction.mjs` (probe-obb.mjs that skips deck-over-road pairs and
counts near each junction) over 90 s with about 11 cars around each junction per frame: car-car 0 everywhere, car-ped 0
near the flyover and 0-2 near the roundabout. A scan of the server sim (3,400 ticks of the showcase) found no car going
the wrong way round the ring and none turning on the flyover.

## Smooth flow (2026-10-21)

Rich, watching the UAT: "a lot of stop start traffic". Three things made it:

1. **No speed.** A car moved min(full speed, gap to the car ahead) each tick, so it went from full speed (half a tile a
   tick) to a dead stop in one tick and back the next.
2. **One decision at the line.** It decided whether to go into the next tile only at the stop line, so it drove flat
   out at a red light or a full lane and stopped dead on the line.
3. **The drawing.** The client drew each car in a straight line at a constant speed from where it was drawn to the
   newest of the server's five positions a second. The drawn speed jumped at every position, and whenever the next
   position came a little late (the server's timer, the network) the car stood parked on the last one for a frame or
   more.

**Outcome.** The drawing was most of it. Offline (below), with positions arriving ±10 ms either side of their time,
drawn stops fall from 30 to 5.5 per 1,000 moving car-frames and frame-to-frame speed jumps from 2.9% of frames to
0.3%; the drawing alone takes them to 6.3 and 0.5, so about 97% of what reads as stop-start on screen was rendering. In
the simulation, on the Commons at the peaks over 24 seeds, dead stops fall by a third and all stops by 8%, with speed,
give-ups and overlaps unchanged within the noise. Halving stops per 10 tiles, the target, was not reached: the
Commons is saturated all day (two-thirds of car-ticks are queued), and most stops are a queue moving up one car
length when its front moves, which no driving style removes.

### What is measured

`ab.ts` now also reports smoothness, from each road vehicle's position tick to tick (the speed a player sees, in tiles
a tick; full speed is 0.5):

- **Stops per 10 tiles**: the speed falls under 0.01 after being over 0.05 since the last stop, per 10 tiles driven.
- **Dead stops per 10 tiles**: the stops from at least half of full speed in one tick, the ones that read as a jolt.
- **Jerk**: mean |Δv| per car-tick.
- **Standing in the stream**: share of car-ticks standing anywhere but first at a junction's or a level crossing's
  stop line.
- **Where the stops are** (`smooth.stopsAt` in the JSON, `Traffic.standing`): first at a junction's stop line (40%),
  at a plain-road stop line waiting for room in the next lane (23%), behind a car (25%), elsewhere (11%).

```sh
npx tsx packages/server/src/loadtest/ab-matrix.ts --hours 8,17 --seeds 1,2,3,4,5,6,7,8,9,10,11,12 --table smooth --row "off=smooth=0" --row "new="
npx tsx packages/server/src/loadtest/smooth-trace.ts --hour 8 --cars 5      # a few drivers' speed, tick by tick
npx tsx packages/server/src/loadtest/ab.ts --set districts=2,smooth=0 --then follow=1,platoon=2 --ticks 400   # same-traffic tick cost
npx tsx packages/client/scripts/render-smooth.ts --hour 8 --ticks 300 --jitter 10   # the drawing, offline
```

`--set smooth=0` turns every new rule off; `--then` changes tunables only for the measured window, after the fill, so
two runs measure the same traffic; `districts=2` builds the 2×2 city. Two harness fixes came first: passengers riding
in a shared car (sim/carpool.ts) were counted as pedestrians inside a car, eight "contacts" a tick, and a delivery bike
filtering past a car counted as two cars touching (now bike–car, on its own). With those out the Commons has 0 car–car
overlaps and 0.05 car–pedestrian contacts a tick as drawn.

The differences below are paired by seed (mean ± standard error). Give-ups move by ±15 between seeds at 08:00, so a
difference has to be about twice its standard error to count.

### The techniques, one at a time

All behind `TRAFFIC_TUNING` knobs. "Lights" is the Commons as seeded (the Commons player has the signals technology,
so every junction of three arms or more has lights); "no lights" is the same city with `noSignals=1`, every junction
give-way, which is what every town has until its owner researches signals.

| technique (setting) | seeds | lights 08:00: stops, dead stops, speed points, give-ups | lights 17:00 | no lights 08:00 | no lights 17:00 |
| --- | --- | --- | --- | --- | --- |
| car following, acceleration 0.15 (`follow=1, accel=0.15`) | 12 | 0.0, −0.97, **−3.1**, −13 ± 17 | −0.1, −0.80, **−2.8**, −16 ± 12 | | |
| car following, acceleration 1, braking for turns (`follow=1`) | 24 | 0.0, −0.38, −0.4 ± 0.3, 0 ± 13 | 0.0, −0.32, −0.4 ± 0.3, +3 ± 8 | +0.05, −0.27, **−1.5 ± 0.6**, +24 ± 16 | +0.07, −0.23, **−1.9 ± 0.7**, +12 ± 10 |
| car following, no braking for turns (`followTurn=0`) | 24 | 0.0, −0.38, −0.7 ± 0.3, **+31 ± 10** | −0.06, −0.32, −0.2 ± 0.4, +11 ± 6 | −0.06, −0.30, −0.3 ± 0.4, +8 ± 11 | 0.0, −0.24, −0.4 ± 0.6, +3 ± 10 |
| + platoons at lights (`platoon=2`), on the line above | 24 | −0.23, −0.20, +0.5 ± 0.3, −12 ± 9 | −0.18, −0.17, +0.1 ± 0.3, 0 ± 6 | (no lights: no change) | |
| platoons everywhere, give-way junctions too (`platoon=1`, no following) | 12 | −0.15, −0.06, 0.0 ± 0.4, +14 ± 16 | −0.13, −0.03, −0.2 ± 0.3, +6 ± 10 | −0.07, −0.01, −1.2 ± 0.7, **+47 ± 17** | −0.08, −0.03, −0.7 ± 1.0, +20 ± 14 |
| start gap 0.9 tiles in queues (`startGap=0.9`, added to following + platoons) | 12 | −0.29, 0.00, +0.7 ± 0.3, −24 ± 11 | −0.21, −0.02, +0.5 ± 0.3, −4 ± 11 | see below | |
| look-ahead 1, the full entry rules on arrival (`lookAhead=1`, added) | 24 | −0.08, −0.31, −0.3 ± 0.3, +14 ± 13 | −0.02, −0.25, −0.4 ± 0.3, +13 ± 7 | | |
| look-ahead 2, only what will still be there (`lookAhead=2`) | 12 | 0.0, −0.09, −0.3 ± 0.5, +15 ± 18 | 0.0, −0.09, −0.2 ± 0.7, +3 ± 18 | | |
| look-ahead 3, the lights only (`lookAhead=3`) | 12 | 0.0, −0.04, **−0.8 ± 0.3**, **+32 ± 15** | 0.0, −0.04, −0.5 ± 0.5, +14 ± 14 | | |
| green waves timed for 0.3 tiles a tick (`greenWave=1`) | 12 | +0.10, 0.0, **−1.2 ± 0.3**, **+33 ± 10** | +0.09, 0.0, **−1.1 ± 0.5**, +11 ± 12 | | |
| actuated lights (`signalActuated=1`) | 12 | +0.07, 0.0, **−1.1 ± 0.5**, **+49 ± 20** | +0.03, 0.0, **−1.1 ± 0.5**, +24 ± 15 | | |
| main road at T-junctions (`mainRoad=1`) | 12 | | | −0.07, −0.02, +0.5 ± 0.6, −30 ± 17 | −0.03, −0.01, −0.5 ± 1.0, +4 ± 13 |
| main road at T-junctions and crossroads (`mainRoad=2`) | 12 | | | −0.05, −0.03, +0.5 ± 0.7, −33 ± 19 | +0.03, 0.00, −0.3 ± 0.9, −4 ± 13 |

Stops and dead stops are per 10 tiles (the baseline is 3.86 and 1.78 at 08:00 with lights). Reading it:

- **Car following** ([`safeSpeed`](../packages/server/src/sim/traffic.ts)): each mover keeps the distance it moved
  last tick (`Mover.v`, 0 when it pulls out or a save loads, so saves are unchanged) and goes no faster than lets it
  stop, braking at `brake` (0.2 tiles a tick a tick), behind the car ahead (allowing for that car braking too, with a
  `headway` of half a tick), before a bus halt, and before a turn. The gap, MIN_GAP, the stop lines, the conflict table
  and the body guard stay hard limits, so it can only ever make a car slower. It cuts dead stops by a fifth to a third.
  **Bounded acceleration costs throughput**: at 0.15 tiles a tick a tick (full speed in four ticks) speed falls 3
  points, because a junction box is held longer by every car moving off. A tick is 36 game seconds, so a car really
  can be at full speed a tick after it moves off; `accel` is 1 (trucks and buses take two ticks), and the drawing eases
  the start instead. Each driver's acceleration is their own (±25%, from a hash of their id).
- **Braking for turns** helps with lights and hurts without: at a give-way junction a turning car that slows early gets
  to the box later and loses its gap to the cross traffic (1.5 to 1.9 speed points). `followTurn=2` brakes only for a
  turn into a junction with lights.
- **Platoons**: a car close behind one that went into a junction by the same approach and exit (moving, within
  `platoonGap` 0.6 tiles) may follow it in before it has left the box; every other entry rule still applies. At lights
  it is the one technique that cuts stops without a cost. At give-way junctions a platoon holds the box against the
  cross traffic, and give-ups rise by a sixth, so `platoon=2` allows it only at lights.
- **Start gap** (a car standing behind a standing car moves up only once 0.9 tiles are free) cuts the queue
  shuffling, the biggest share of stops, but it doubles car–pedestrian contacts as drawn (0.054 to 0.104 a tick),
  together with the rest costs 2.7 speed points and 21% more give-ups without lights, and doubles give-ups in the
  saturated bridge bench (`bridges.ts`). It is off. A version that let a car move up once it had stood a third of the
  stuck limit was worse.
- **Look-ahead** (brake for the line when the next tile will not take the car on arrival, the light read at the tick
  the car will decide): the full entry rules cut dead stops by a quarter more, but braking early also costs a little
  speed and some give-ups (+13 a peak), and reading only the lights is the worst variant. It is off. (A first version
  read the light a tick later than the tick the car decides at, and cost about twice as many give-ups.)
- **Green waves and actuated lights** both lose: a 15-tick phase on blocks five tiles long already gives most cars a
  green within a few ticks, a common period throws away the ±20% that keeps neighbouring lights from switching
  together, and an actuated green holds the whole box for one approach.
- **Main-road priority** without lights is within the noise (−30 ± 17 give-ups at 08:00, +4 ± 13 at 17:00). It is
  off; R3 made `Traffic.roadRank` the road class's rank (see "Road classes" below, where it is measured again).

### Chosen values and the result

`follow: 1`, `accel: 1`, `accelVar: 0.25`, `heavyAccel: 0.6`, `brake: 0.2`, `headway: 0.5`, `followTurn: 2`,
`platoon: 2`, `platoonGap: 0.6`, `platoonV: 0.1`; off: `startGap`, `lookAhead`, `mainRoad`, `greenWave`. One fix is in
both rows and is not switchable: a car arriving at a building follows a car pulling out of it the same way (the
pulling-out car starts at the middle of the tile, where the arriving one ends; it was the only car–car overlap left in
these runs, once in about twenty runs, old rules included).

24 seeds (1–24), 1,500 ticks:

| | stops / 10 tiles | dead stops / 10 tiles | jerk (tiles/tick²) | standing in the stream % | speed % | queued % | give-ups | car–car / tick (path / drawn) | car–ped / tick (drawn) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lights 08:00, before | 3.86 | 1.78 | 0.055 | 41.6 | 25.8 | 67.8 | 428 | 0 / 0 | 0.054 |
| lights 08:00, after | 3.57 | 1.17 | 0.052 | 41.3 | 25.9 | 67.1 | 432 | 0 / 0 | 0.061 |
| lights 17:00, before | 3.32 | 1.57 | 0.058 | 38.4 | 29.5 | 64.5 | 248 | 0 / 0 | 0.024 |
| lights 17:00, after | 3.06 | 1.06 | 0.055 | 37.9 | 29.7 | 63.6 | 251 | 0 / 0 | 0.026 |
| no lights 08:00, before | 3.12 | 1.51 | 0.063 | 39.3 | 32.7 | 59.7 | 382 | 0 / 0 | 0.052 |
| no lights 08:00, after | 2.98 | 1.06 | 0.060 | 39.7 | 32.1 | 60.0 | 393 | 0 / 0 | 0.057 |
| no lights 17:00, before | 2.54 | 1.25 | 0.062 | 37.1 | 36.5 | 56.4 | 228 | 0 / 0 | 0.018 |
| no lights 17:00, after | 2.43 | 0.88 | 0.059 | 37.2 | 35.9 | 56.8 | 238 | 0 / 0 | 0.021 |

Paired, after − before: with lights, stops −0.29 ± 0.03 (08:00) and −0.26 ± 0.03 (17:00), dead stops −34% and −32%,
speed +0.0 ± 0.4 and +0.2 ± 0.4, give-ups +4 ± 15 and +3 ± 7. Without lights, stops −0.14 and −0.11, dead stops −30%,
speed −0.6 ± 0.4 and −0.6 ± 0.6, give-ups +11 ± 12 and +10 ± 10. The two halves of the seeds agree: with lights,
seeds 1–12 give stops −0.28 / −0.23 and give-ups +7 / +5, and seeds 13–24 −0.30 / −0.29 and +2 / 0. Car–car overlaps
are 0 in every run.

**Cost.** The 2×2 city, the same traffic switched for the measured 400 ticks (`--then`), nine pairs: 2.69 ms a tick
before, 2.78 after, +3.2 ± 2.1%.

### The drawing (client)

`render/glide.ts`: each new server position starts a stretch from where the car is drawn now, leaving at the speed it
is drawn moving and arriving at the speed of the server's last step (a cubic Hermite curve), so the drawn speed changes
smoothly across positions instead of jumping at each. Both speeds are capped at twice the stretch and dropped when
they point back along it, so a car never overshoots or rolls backwards, and one that stops arrives still. A stretch is
planned to take 1.3 times the gap between positions (`STRETCH`), so a position that comes a little late finds the car
still moving: drivers are drawn about a fifth of a tick further behind the server than before (1.20 ticks against
0.98). Walkers are drawn as before. `?glide=0` draws drivers the old way.

`render-smooth.ts`, the Commons at 08:00, 300 ticks, positions sent as net.ts sends them and delivered with jitter (a
local server under load measured 202.7 ± 9.7 ms between messages, 95th percentile 210, worst 282), per 1,000 moving
car-frames at 60 frames a second:

| | jolts (drawn speed changes over 0.5 tiles/s in a frame), % of frames | hitches (standing a frame between moving ones) | drawn stops |
| --- | --- | --- | --- |
| before (old rules, old drawing), ±10 ms | 2.9 | 13.5 | 30.4 |
| new rules, old drawing | 2.6 | 12.1 | 29.4 |
| old rules, new drawing | 0.5 | 0.1 | 6.3 |
| after (new rules, new drawing) | 0.3 | 0.0 | 5.5 |
| before, ±25 ms | 3.6 | 21.3 | 43.3 |
| after, ±25 ms | 0.6 | 1.4 | 6.9 |
| before, no jitter | 1.8 | 0.7 | 10.0 |
| old rules, new drawing, no jitter | 0.5 | 0.0 | 6.4 |

17:00 is the same within a few tenths. Live, in headless Chrome against a 1×1 test city with both drawings side by side
on the same traffic for 40 s (`drawn.mjs`, in the session's scratch): jolts 3.5% → 1.4%, hitches 9.8 → 2.2, drawn stops
31.4 → 12.8 per 1,000 moving car-frames; headless Chrome on a loaded machine drew at 27–44 frames a second and handled
the messages in bursts, which is harsher on both than a player's browser.

### Specials

`junctions.ts --rates 15,25,35 --mix turns` (yield, lights, roundabout and flyover, 60/100/140 cars an hour over the
four approaches): throughput within one car an hour of before everywhere (the roundabout 81 → 80 and 76 → 75 at the two
higher rates), give-ups the same or fewer (give-way at 140: 22 → 11), overlaps 0. `bridges.ts` at 120/240/360 cars an
hour: throughput 55/37/20 → 54/36/20, give-ups 8/9/6 → 4/7/9, overlaps 0. `crossings.ts` (car–train overlaps 0, nobody in a crossing box beside a train), `busroutes.ts` (every
lap and three-point turn as estimated), and the fires, death, media, motivation, utilities and ranks probes pass.
Emergency vehicles keep ignoring lights (`m.priority`); a bus brakes for its halt instead of stopping dead at it;
kerb parking, car sharing and level crossings use the same hard limits as before.

**Known gaps.**
- The stop count is set by saturation. What would halve it is less queueing: capacity (R3's avenues and classes),
  junction design, or less demand at the peaks.
- A car still stops dead when it is refused at the line without warning (no look-ahead): about a third fewer than
  before, and the drawing cannot soften those, since it does not know the stop is coming.
- The test city is a grid of short blocks; long roads between junctions, where a car reaches and holds full speed,
  are where following and look-ahead would show more.

## Road classes (R3, 2026-10-21)

Docs/roads.md "Classes" has the model: two lanes on every one-way tile (a one-way street, each carriageway of an avenue
or motorway), a lane per strand with its own following and room, lane changes through the box check, the conflict
tables extended by strand (the all-zero entries are the old tables), class speed and route cost, slip give-way, and the
over-the-median rule at an avenue's crossings. A world with no road of another class than the street takes none of the
new code paths (`World.anyRoadClass`): **on the plain Commons `ab.ts` gives output identical to main**, line for line,
and on the 2×2 city (`districts=2`) the output is identical too and the tick cost 2.70 against 2.69 ms (three
interleaved pairs, +0.6%, within the noise).

**Variants** (`ab.ts --set`): `avenues=2` makes every district's doubled edge road (local 20 and 21, two street tiles
side by side) an avenue; `avenues=1` also widens the middle street (10) into an avenue over the row of lots beside it
(11), which loses those lots; `oneway=1` makes the inner streets (5, 10, 15) one-way, alternating, the edges two-way.

Six seeds (1-6), 08:00, 1,500 ticks; give-ups are the window's, means over the seeds (the differences paired by seed,
± one standard error):

| Variant | Lights: give-ups, mainRoad 0 → 1 | Give-way everywhere (`noSignals=1`): give-ups, mainRoad 0 → 1 | Drivers' commute (ticks) | Car-car overlaps |
| --- | --- | --- | --- | --- |
| plain (doubled edge streets) | 431 → 445 (+14 ± 32) | 378 → 388 (+10 ± 20) | 97 | 0 |
| `avenues=2` (edge pairs as avenues) | 436 → 467 (+31) | 443 → 420 (−23 ± 51) | 105 | 0 |
| `avenues=1` (and the middle streets widened) | 566 → 571 (+4 ± 7) | | 125 | 0 |
| `oneway=1` (inner streets one-way) | 621 → 603 (−18 ± 14) | 599 → 609 (+10 ± 24) | 179 | 0 |

Reading it:

- **One controller for an avenue's crossing** (the two junction tiles lit as one junction, one timing, a car already
  inside not stopped again at the second half: R4's junction group, docs/roads.md "Junctions") took the avenue grid from 508 give-ups to 436, level
  with the doubled streets it replaces (431). Before it, each half had its own lights out of step, and a car crossing
  waited at the second half's red in the first half's box.
- **mainRoad with real hierarchy** (`Traffic.roadRank` is the class rank now) is within the noise or worse: +31 on the
  avenue grid with lights (it was −46 with each half on its own lights, where priority was making up for them), −18
  ± 14 on the one-way grid with lights, and within the noise with give-way everywhere and on the plain grid. It stays
  off; R4 (turn lanes and signal timing on avenues) changes what an avenue junction is.
- **An avenue matches, not beats, the two streets it replaces on this grid.** The doubled edge road was already four
  lanes (two street tiles); as an avenue it has the same lanes, but each carriageway goes one way, so a lot on the far
  side is reached by going on to the next junction and crossing (drivers' commute 105 ticks against 97), and the
  reservation stores no car waiting to cross. Widening the middle streets (`avenues=1`) loses a row of lots and
  lengthens commutes. Where an avenue replaces a single street on a through route it carries more (the corridor bench
  below). R4's turn lanes and wider reservations are where an avenue grid should start to pay.
- **One-way grids lengthen trips** (drivers' commute 179 ticks against 97): in a 22-tile district most trips are
  short and the detours dominate; the junctions have fewer conflicting movements but not enough to pay for them.
- No car-car body overlaps in any run, on any class. The tick cost of a world with classes is higher where the trips
  are longer (the one-way grid 1.2 ms a tick against 0.85: more cars on the road for longer, and longer searches).

**The corridor bench** (`loadtest/classbench.ts`: a corridor 25 tiles long crossed by a two-way street at its middle,
cars from both ends and a quarter as many over the crossing street, give-way): at 40 cars an hour each way an avenue
carries 87 an hour to a street's 75, with a quarter of the give-ups, the one-way street 53 (one way only), the motorway
90; at 60 an hour, 79 to 66. No car-car overlaps on any class. Most give-ups left are cars from the crossing street
waiting for a gap in a busy road, as at any unsignalled crossing.

## Junctions (R4, 2026-10-21)

Docs/roads.md "Junctions" has the model: junction groups (an avenue crossing's two or four tiles as one controller, the
lights gating only cars coming in, four phases with protected lefts where two avenues cross), turn lanes, the median
box, mini-roundabouts, the 5×5 two-lane roundabout, the diamond interchange, turn bans and signal crossings. Every rule
has a knob in `TRAFFIC_TUNING` that puts R3's back (`groupSignals`, `medianBox`, `turnLanes`, `miniOne`, `greenWave`);
with all of them at 0 the avenue grid's output is R3's, line for line.

**The city** (`ab.ts`, 08:00, 1,500 ticks, twelve seeds 1-12; give-ups, means, differences paired by seed ± one standard
error). R4 is measured against main after c3ebc48 (R3's late fix that made an avenue crossing one controller: most of
item 1), on the same machine:

| Grid | main (c3ebc48) | R4 | R4 − main |
| --- | --- | --- | --- |
| plain (doubled edge streets) | 430 | 430 | identical, line for line, on all twelve seeds |
| `avenues=2`, lights | 459 | 453 | −6 ± 16 |
| `avenues=2`, give-way everywhere (`noSignals=1`) | 409 | 367 | **−42 ± 19** |

Against R3's rules (the knobs at 0) the avenue grid with lights goes from 491 to 453 (−38). The acceptance asked for
fewer than R3's 508 (met) and no worse than the plain grid (430): 453 is +24 ± 26 above it, within the noise but not
below it. The test city's avenues meet only streets (their own crossing is an L at the district's corner), so it has no
four-phase group: protected lefts and the turn lanes they hold are measured on the junction bench below.

What each rule did on the avenue grid with lights (before the merge with main, R3's rules as the base, twelve seeds
where given, six otherwise):

| Change | Give-ups | Reading |
| --- | --- | --- |
| R3's rules | 491 (12) | |
| all of R4, turn lanes held everywhere (`turnLanes=1`) | 455 (6) | |
| turn lanes only at four-phase groups (`turnLanes=2`, the default) | 451 (12) | the same as no held lanes (`turnLanes=0`) here: no four-phase group |
| and green waves at the groups (`greenWave=2`, the default) | 437 (12), −14 ± 12 | waves along each avenue's crossings; single junctions keep their own timing |
| green waves at every light (`greenWave=1`) | 424 (12) | better again on avenues, but it changes the plain grid (433 against 430), which must stay identical |
| main-road priority (`mainRoad=1`) | no change | every avenue junction has lights, and the rule acts only where there are none; with give-way everywhere it was +16 (6 seeds): it stays off |
| after the merge: the avenue's axis given 60% of a two-tile group's cycle (`groupSplit=0.6`) | −17 ± 21 (12) | within the noise; 67% was +25 ± 20: the even split stays |

The median box needed one fix on the way: the body guard keeps a margin on both bodies (0.03 a side), and a car waiting
in the median clears the reservation-side lanes by 0.05 of a tile, so the guard held the next car in that lane, which
was committed into the box the median car was waiting for: a lock. On the give-way corridor bench it took an avenue from
83 cars an hour to 20. The guard now tests a car in the median body to body (no car ever touches another: car-car
overlaps were 0 in every run).

**Avenue × avenue** (`loadtest/avenuebench.ts`: two avenues crossing, every one of the twelve moves at the same demand,
one seed, 2,600 ticks; cars through / give-ups):

| Demand (all moves) | four phases (the default) | two phases (`groupSignals=2`) | give-way | 5×5 roundabout | R3's rules |
| --- | --- | --- | --- | --- | --- |
| 36 / h | 891 / 4 | 904 / 0 | 904 / 0 | 894 / 5 | 784 / 82 |
| 48 / h | 1165 / 26 | 1212 / 1 | 1102 / 112 | 1193 / 8 | 468 / 572 |
| 60 / h | 1207 / 125 | 1484 / 2 | 1065 / 331 | 1472 / 18 | 411 / 625 |

R3's rules locked this junction above about 40 an hour (each tile its own lights, out of step). With the twelve moves
equal (a third of the traffic turning left), two phases, the lefts giving way from the median box, carry more than four
with protected lefts; protected lefts pay where opposing traffic is heavy and the lefts many, which this bench does not
have. The four phases stay, as the brief asks, with the left phase half a through phase (`leftPhase`: five ticks instead of eight tripled the
give-ups at 48 an hour). The 5×5 roundabout carries as much as two-phase lights with no lights at all.

**Mini-roundabouts** (`loadtest/junctions.ts --mix turns`, a crossroads of streets, 20/40/60 cars an hour per arm,
three seeds, 2,000 ticks; served / give-ups):

| Demand per arm | give-way | signals | mini-roundabout | one car at a time (`miniOne=1`) |
| --- | --- | --- | --- | --- |
| 20 | 63 / 14 | 49 / 10 | 60 / 8 | 32 / 86 |
| 40 | 52 / 10 | 37 / 8 | 47 / 7 | 22 / 90 |
| 60 | 39 / 14 | 26 / 9 | 36 / 11 | 10 / 72 |

A mini-roundabout carries within a tenth of a give-way crossroads, a fifth more than lights, with fewer give-ups than
either at the lower loads (giving way to the left shares the box out fairly). The brief's model, one car in the box at a
time, carries half: the default lets movements that do not cross share the box, as the box rules always have.

**The corridor bench with a crossing** (`classbench.ts --junctions`, 40 and 60 cars an hour each way along, a quarter as
many over the crossing street; served / give-ups):

| Corridor, crossing | 40 / h | 60 / h |
| --- | --- | --- |
| street, give-way | 76 / 95 | 69 / 100 |
| street, signals | 49 / 0 | 45 / 7 |
| street, mini-roundabout | 70 / 85 | 61 / 77 |
| avenue, give-way | 96 / 6 | 105 / 18 |
| avenue, signals (one group) | 88 / 1 | 82 / 3 |
| avenue, 5×5 roundabout | 83 / 39 | 76 / 51 |

On a straight-through corridor the street crossing is the weak arm everywhere: give-way and the mini-roundabout starve
it (the give-ups are cars on the crossing street), lights do not. The 5×5 roundabout takes the avenue's straight traffic
round two sides of its ring, so on a corridor it carries a little less than lights; its side streets go once they have
waited `minorWaitMax` (without that, 67 give-ups at 40 an hour). Holding the turn lanes at every junction
(`turnLanes=1`) cost the give-way avenue corridor a sixth (83 to 70 an hour): the straight-on traffic is squeezed into
one lane where the side street's traffic joins; at four-phase groups only, nothing is lost.

**Tick cost** (the 2×2 city, `districts=2`, plain: no road classes, so the output is identical to main's, line for line):
2.73 ms a tick against main's 2.63, +3.7 ± 0.3% over six interleaved pairs. The first cut cost +9%: R4's entry rules had
grown the traffic model's hottest functions past what the engine inlines, and the bus router made a closure on every
expansion; they now sit behind one test a town of streets fails (`r4Entry`), and the closure is gone.

**Probes** (`loadtest/junctions.ts`, 50 checks): a group's every tile on its anchor's phase for 400 ticks as the client
works it out; no car coming into a four-phase group against its phase (888 entries); the median box never holding two
cars a way; one car at a time in a mini-roundabout with `miniOne`; both ring lanes used, the inner never by a first-exit
car; all eight moves of a diamond routed legally and driven; turn bans honoured by A*, the bus router and a driver's
re-route, ignored by a fire engine on a call; no car onto a signal crossing on its amber or red; car-car overlaps 0
throughout.

## Traffic control (R5, 2026-10-21)

Docs/roads.md "Traffic control" has the model: street rules per tile (HGV ban, bus lane, double yellows, 20 zone), the
visitor limit, freight routing round bans and zones, the lorry curfew, the Traffic panel and the overlay's explanation. A
world with no street rule, no gateway limit and no curfew takes none of their code paths (`World.streetAny`,
`World.gatewayLimits`, the policy): **on the plain Commons `ab.ts` gives output identical to main**, line for line, on all
24 runs (seeds 1-12 at 08:00 and 17:00).

**Variants** (`ab.ts --set`, on the Commons): `hgv=1` an HGV ban on its two busiest freight streets (each district's
doubled south edge, local rows 20 and 21: measured, seeds 1-3 at both peaks, they carry the most lorry-ticks); `zone20=1`
a 20 zone on its residential street tiles (homes beside them and no shop, works or office: about a third of the town's
straights); `visitorLimit=1` the visitor limit at every entry (half the visitors come); `noLots=1,yellows=1` no parking
lots and double yellows wherever shops or offices front the street, against `noLots=1`; `curfew=1` the lorry curfew for
the town's owner; `busLane=1` bus lanes on every avenue carriageway, with `busAv=N` a bus line of N buses round district
A1's avenue corner (laid two hours before the window, so its depot, a coach station, does not slow the fill).

New measures (`AbResult.control`): freight and visitor trips (ticks from setting off to arriving), bus laps and the avenue
line's avenue section, car-pedestrian near misses (a walker on the carriageway within half a tile of a car moving at over
0.2 tiles a tick; "fast": over 60% of full speed, more than a 20 zone allows), lorries on the road overnight and the
lorries the curfew held.

**08:00**, twelve seeds, means; in brackets the difference paired by seed against the Commons as it is, ± one standard
error:

| Variant | give-ups | speed % | driver commute | freight trip | visitor trip | car-ped contacts / tick |
| --- | --- | --- | --- | --- | --- | --- |
| the Commons | 430 | 26.0 | 103 | 45.6 | 69.8 | 0.022 |
| HGV ban, two busiest freight streets | 505 (+75 ± 26) | 23.9 (−2.1 ± 0.7) | 117 (+14 ± 5) | 52.2 (+6.6 ± 1.7) | 69.5 (−0.2 ± 1.2) | 0.028 (+0.006 ± 0.006) |
| 20 zone on residential streets | 428 (−2 ± 24) | 24.9 (−1.0 ± 0.6) | 105 (+1 ± 5) | 46.2 (+0.6 ± 1.7) | 71.3 (+1.6 ± 1.2) | 0.015 (−0.006 ± 0.003) |
| visitor limit | 372 (**−58 ± 17**) | 27.3 (+1.3 ± 0.4) | 96 (−7 ± 4) | 45.8 (+0.2 ± 1.5) | 62.9 (−6.9 ± 1.2) | 0.016 (−0.006 ± 0.003) |
| no lots | 369 (−61 ± 21) | 27.2 (+1.2 ± 0.6) | 97 (−6 ± 5) | 44.7 (−0.9 ± 1.3) | 59.0 (−10.7 ± 1.2) | 0.018 (−0.004 ± 0.003) |
| no lots, double yellows (against no lots) | 390 (+21 ± 25) | 26.1 (−1.1 ± 0.6) | 98 (+1 ± 7) | 46.4 (+1.6 ± 1.7) | 63.2 (+4.1 ± 1.4) | 0.024 (+0.006 ± 0.008) |

**17:00**

| Variant | give-ups | speed % | driver commute | freight trip | visitor trip | car-ped contacts / tick |
| --- | --- | --- | --- | --- | --- | --- |
| the Commons | 252 | 29.7 | 85 | 45.2 | 65.5 | 0.015 |
| HGV ban, two busiest freight streets | 280 (+28 ± 14) | 28.1 (−1.6 ± 0.6) | 75 (−11 ± 12) | 50.3 (+5.1 ± 2.7) | 66.5 (+1.0 ± 1.7) | 0.015 (+0.001 ± 0.003) |
| 20 zone on residential streets | 257 (+5 ± 13) | 28.2 (−1.6 ± 0.6) | 106 (+20 ± 10) | 44.4 (−0.8 ± 2.0) | 66.5 (+1.0 ± 1.4) | 0.010 (−0.005 ± 0.003) |
| visitor limit | 219 (**−33 ± 8**) | 29.6 (−0.2 ± 0.6) | 66 (−19 ± 13) | 43.3 (−1.9 ± 2.1) | 67.9 (+2.4 ± 2.2) | 0.010 (−0.005 ± 0.003) |
| no lots | 216 (−36 ± 9) | 30.4 (+0.7 ± 0.6) | 59 (−27 ± 9) | 42.6 (−2.6 ± 1.6) | 58.6 (−6.9 ± 1.4) | 0.011 (−0.003 ± 0.003) |
| no lots, double yellows (against no lots) | 225 (+8 ± 14) | 29.8 (−0.6 ± 0.5) | 60 (+2 ± 8) | 45.9 (+3.3 ± 1.4) | 59.4 (+0.8 ± 1.8) | 0.018 (+0.006 ± 0.008) |

Car-car body overlaps were 0 in every run.

Reading it:

- **The visitor limit is the one that pays here**: a quarter fewer give-ups at 08:00 and an eighth fewer at 17:00, and
  faster trips for everyone else, for half the visitor tax through that gate. It confirms the load finding above: much of
  the jam is visitors the player did not create, and now the player can choose.
- **An HGV ban on the busiest freight streets makes the town worse.** The lorries do not go away: they go round, by
  streets that were carrying cars, and their trips take an eighth longer. A ban belongs on a street lorries have no need
  of (the Showcase's South Parade, a residential street), not on their trunk route; the ghost's detour number says which
  is which before the player pays.
- **A 20 zone on the residential streets costs a point or two of speed and no give-ups, and it is safer**: car-pedestrian
  contacts (bodies touching, as the client draws them) fall by a quarter to a third at both peaks.
- **Double yellows change nothing measurable** even with the lots gone: the drivers who would have parked on the kerb
  park on the street before instead, so the lost lane slot moves rather than goes, and visitors walk a little further.
  They are for a street that must keep its lane (a bus route, a junction's approach), not a cure for a jam.
- Removing the four lots is better than the Commons as it is in this run of seeds (−61 ± 21 at 08:00); the R0 table above
  had it level. The lots sit on the busiest streets, and a lot's entrance is a junction of its own.

**The lorry curfew** (`curfew=1`, from 20:00 for 1,500 ticks, so the whole of 22:00-06:00; twelve seeds): it held 6.3
lorries a night, the lorries on the road overnight went from 0.81 to 0.66 a tick (−0.15 ± 0.16, within the noise: most of
those are lorries that set off before 20:00 and are still driving), and the freight trips completed over the window went
from 214 to 220 (+5 ± 5): the deliveries come in the morning, none is lost. Industry sends lorries only from 06:00 to
20:00 already, so the curfew catches the late ones, rail freight's last mile and the harbours' early fish.

**Bus lanes.** On a queued one-way street (the probe in `loadtest/control.ts`: a one-way street east to a signalled
crossing, 70 cars an hour, a bus every 150 ticks) a bus takes 122 ticks along it with a bus lane against 197 without
(−38%), and the cars lose a lane: 893 got through against 1,129. On the 2×2 city with `avenues=2` and a bus line round
district A1's avenue corner (`busAv=4`, twelve seeds, the lanes on every avenue carriageway) the gain is within the
noise:

| 2×2, avenues=2 | give-ups | driver commute | bus lap (ticks) | the avenue section (ticks) |
| --- | --- | --- | --- | --- |
| 08:00, no bus lanes | 1,098 | 91 | 448 | 125 |
| 08:00, bus lanes | 1,097 (−1 ± 28) | 94 (+3 ± 2) | 414 (−31 ± 24) | 118 (−7 ± 7) |
| 17:00, no bus lanes | 595 | 46 | (no lap completed) | 100 |
| 17:00, bus lanes | 600 (+6 ± 13) | 53 (+7 ± 4) | (no lap completed) | 106 |

On this grid the avenue's blocks are four tiles between lights: a bus loses its time at the red lights and behind the bus
ahead at a stop, and in the boxes of junctions blocked by the town's gridlock, not in a queue of cars along a link, which is
the only place a bus lane helps (a trace of what held each bus, `Traffic.whyHeld`: at 08:00 its held ticks on the avenue are mostly at a red). A bus lane
pays on a long link that queues, as the probe's does.

**Near misses** (a walker on the carriageway within half a tile of a car moving at over 60% of full speed, faster than a 20
zone allows; twelve seeds): with the 20 zone on the residential streets 1.47 to 1.41 a tick at 08:00 (−0.05 ± 0.04) and
0.96 to 0.93 at 17:00 (−0.04 ± 0.04), down but within the noise; the contacts above are the firmer sign.

**Tick cost** (the 2×2 city, `districts=2`, plain: no rules, so the output is identical to main's, line for line, eight
seeds): 0.996 ± 0.008 of main's time a tick, R5 and main run side by side so both had the same machine (its load average
was 20 to 37 from other work: run one after the other, pairs scattered from 0.77 to 1.26). The first cut cost about 10%:
a curfew field set only on lorries gave freight vehicles an object shape of their own, and the vehicle loop slowed for
every vehicle (`moveVehicles` 218 to 466 ms in a profile); the holds now live in a map beside the vehicles.

**The knobs**: `TRAFFIC_TUNING.visitorLimit` (0; 1 the visitor limit at every entry, for ab.ts), `VISITOR_LIMIT_SHARE`
(0.5, the visitors a limited gateway lets in), `ZONE20_SPEED` (0.6), `ZONE20_COST` (1.4), `ZONE20_FREIGHT` (1.5),
`POLICY.curfewFrom` / `curfewTo` (22, 6) and `curfewPerDay` ($10); the rules' costs and upkeep are `STREET_RULE_DEFS`
(`shared/src/roadrules.ts`).

**The Showcase's bus lane** (`loadtest/showbus.ts`: bus line 4, a small loop of two buses round North Parade's bus lane,
Market Street, South Parade and the west street, 24 game hours after the fill, seeds 1 and 2; with the bus lane and with
it taken off before the fill):

| Seed | bus lane | laps | lap (ticks) | North Parade legs | leg (ticks) |
| --- | --- | --- | --- | --- | --- |
| 1 | off | 24 | 177 | 9 | 23 |
| 1 | on | 22 | 162 | 13 | 16 |
| 2 | off | 21 | 210 | 8 | 22 |
| 2 | on | 34 | 232 | 12 | 28 |

Mixed, and within what two seeds can tell apart. The buses lose their time waiting to get into the Market Street
junction and are withdrawn by the stuck rule now and then (a bus on a one-way street before a busy junction: a follow-up),
not in a queue along North Parade. Measured where a bus lane can help (the probe's queued link) it takes a bus a third
less time.

**Drawing** (the Showcase at the road classes section, 40 tiles out, after the town's fill): the road mesh in view has
262,544 triangles with the street rules drawn against 262,402 without them (+0.05%: the bus lanes, yellow lines, humps and
roundels are a few hundred decals over 57 tiles), the same nine road meshes, and the junction signs' one merged mesh goes
from 4,387 to 8,579 triangles (the HGV and 20 signs; no new draw call). Frame times at street zoom with and without the
rules differ by less than the live scene moves from one pass to the next.

## Motorway speed (UTD card e771510f, 2026-10-26)

Rich: "motorways should be way faster, 2x-3x". A motorway tile is now driven at **2.5 times a street** (`speed` 2.5, `routeCost` 0.5 on both entries of the table: the road, id 4, and the interchange deck, id 7). The avenue stays at 1. The probes are `loadtest/motorway.ts` (a trunk with two diamond interchanges, 160 tiles; a busy motorway; a queue) and `loadtest/mwlondon.ts` (London from one save, per class).

**What capped the speed.** `Traffic.step` moved a car across at most one tile edge a tick and put it into the next lane no further than 0.3 along it (where the next stop line is), dropping whatever was left of the move. A street car (0.56 tiles a tick at most) rarely had anything left. The old 1.25 motorway (0.55 to 0.7 tiles a tick) ran **0.61 then 0.39 tiles on alternate ticks: a street's pace**. Measured door to door on the 160-tile trunk, the old motorway took 403 ticks against the street's 405 (1.00x, the ramps counted). At 2.5 the loss would have been half the move, and a car at 1.4 tiles a tick crosses more than one edge.

**What changed** (`sim/traffic.ts`; only a car whose free pace is over 0.7 tiles a tick, `FAST_PACE`, takes any of it, so streets, avenues and every world without a motorway run the single step they always did: `ab.ts` on the 2x2 and the Commons is identical, `perf:check` the same game):

- **A second leg.** A fast car that crosses an edge goes on, from the lane it came into, with what it had left (`step` runs `leg` again, at most three times in all): the car ahead, the stop line and its entry rules, the body guard all apply in the new lane. A car crosses at most two edges a tick at 1.4 tiles; no tile is skipped and the box rules see it at each one. The tick's speed `v` is the distance really moved.
- **Looking along the route** (`horizon`, up to 8 tiles, from the stopping distance): down to the pace of a slower road or a turn by its near edge, the nearest standing or crawling car in a lane ahead, a lane out of a tile with no room, and the junction box of a slip road's mouth (`boxCaution`: slow to arrive as it clears). Braking is the usual 0.2 a tick, so a car that used to see a queue one tile off now sees it from the 5 or 6 tiles it takes to stop.
- **Following through a slip road's mouth** (`platoonFast`): on a motorway a car may go in behind a moving leader of the same approach within `platoonGap` times the class speed; holding it at the line stopped it dead from speed. A plain motorway tile admits as many as the following gap lets in (`laneRoom`), and a merger from a slip road waits for a gap scaled with the class speed (`slipGap`, 4 tiles at 2.5, the old 2 at 1.25).

**Measured** (same trunk, same sixteen drivers, same demand; before is the code on main with the old table):

| | before (1.25, cost 0.8) | after (2.5, cost 0.5) |
| --- | --- | --- |
| door to door, 160-tile trip, street 405 ticks | 403 ticks, 1.00x | 226 ticks, 1.79x |
| busy motorway, 30 an hour each way (load 1): mean pace between the interchanges | 0.49 tiles a tick | 1.16 |
| trips, give-ups, car-car overlaps in 3000 ticks | 3017, 1, 0 | 3299, 0, 0 |
| falls in speed over 1 tile a tick (a dead stop from speed) | 0 | 120 of 468,000 fast car-ticks |
| falls over half a tile a tick | 0 | 2,119 |
| most tile edges crossed in a tick, longest step | 1, 0.73 | 2, 1.45 |
| overloaded (load 2): trips, give-ups, share of car-ticks crawling | 3710, 3, 0.4% | 4892, 86, 63% |

The last row is the price: the old motorway never carried what was offered (cars waited to get on at its end), so the interchanges' street junctions never saw more than they could take; fast cars deliver more, and past about a third more than load 1 the slip roads and the street junction behind them lock, as the old model did at load 1.5 (18% crawling at 1.25). The few dead stops from speed are at a slip road's mouth, when a merger or an exit is in the box as a platoon arrives. In London (docs/demo.md), at 08:00 to 10:00 the motorways carry half a percent of the cars (the M4 and the A13 are on its edge and jammed at 0.13 tiles a tick); with the cost at 0.5 the avenues' count did not move beyond the run to run noise, so the route cost is the principled one (1 over the pace the probe measured, 2.3), not a lever on London. A* explores a third more nodes a search in a world with a motorway (87 to about 116 at 0.45 to 0.5), because `World.minRouteCost`, the distance estimate's scale, is the cheapest class: a follow-up could scale it per search.

**London, same save, 07:00 to 10:00 of the next day** (`mwlondon.ts`; the first column is main):

| | main | this branch |
| --- | --- | --- |
| motorway cars on the road, mean a tick (standing) | 11.1 (6.9) | 14.6 (10.4) |
| motorway mean pace, tiles a tick | 0.14 | 0.13 |
| avenue cars on the road | 852 | 882 |
| standing motorway car-ticks: behind a car / box ahead blocked / waiting for a gap | 1468 / 488 / 364 | 2718 / 525 / 191 |
| A* nodes a search | 91 | 120 |

The motorways were already jammed on main (62% of their cars standing): the queues are the street junctions where the M4 and the A13 end, and the share waiting for a gap at a slip's mouth fell. The avenue count moves with the chaos of a whole city (a different run of the same save differs by about as much).

**Client.** The picker prints 250% speed. The cab's dial reads to 200 km/h (a motorway car is 130 to 165). The ride's engine keeps its old mapping up to 3.6 tiles a second (every street ride sounds as it did): above that a car's or lorry's ride speed goes past 1, to 1.6, so a motorway reads as faster than the top of a street (`KNEE` in `audio/fpv.ts`; the synthesis follows to 1.6). `render/glide.ts` draws a car between ticks on a cubic from one tick's position to the next. `loadtest/motorway.ts` draws exit and entry trips through it and measures the distance from the lane's own centre line: 0.062 tiles on the entry; on the two exits 0.145 and 0.126 at the worst frame, which sits where the car changes lane ten tiles before the slip, not at its bend (a lane change is a tile-long ease across 0.38 tiles that a 1.4-tile step cuts); 0.066 at most for the same trips at the old pace.

## Congestion (UTD card 62b58b5c, 2026-10-26)

Rich, on UAT: "traffic is absolutely snarled up yet the overlay is hardly orange". The overlay's ramp (green 0, yellow
0.5, red 1) was right; the number under it was not.

**The old formula** (`Traffic.endTick`): one moving average per tile of `min(1, (n * 0.25 + st * 0.75) / (2 * laneCap))`,
n the cars on the tile this tick and st those held (moving under 30% of free speed, the HUD's "queued"), EMA 0.08 a tick,
with a 75-tick decay applied on every update. That is how full the tile is against four cars (two lanes of two), not how
held up its cars are. A one-way standstill holds two cars a tile at most, so a dead stop read 0.5 at best (yellow); a
queue spaced a car a tile read 0.25 (green). The decay on every update also left a steady target reading only 0.87 of
itself. The same number weights routing, so drivers under-rated jams as well.

**The new one.** Each tile keeps two moving averages, per tick, of its held cars S and of its cars N (`Cong { s, n, at }`,
runtime state, never saved). A tick nobody drove on the tile counts as a tick with no cars, so between visits both fall by
`1 - EMA_ALPHA` a tick; that replaces the separate decay. Then

    congestion = S / max(N, CONG_FULL)        EMA_ALPHA 0.03, CONG_FULL 0.75 cars a tick

the share of the tile's cars that are held, with fewer than 0.75 cars a tick weighing as a share of that. A standstill
reads 0.9 to 1 (red); a signal approach held half the time reads about 0.5 (yellow); a busy street whose cars keep moving
reads 0 (green); a lone car held at a red light on a quiet road reads about 0.35 at its highest and fades as it leaves.
A fast car's second leg (motorways) is no longer counted as a car on the tile it reaches, so N and S count the same cars:
one each a tick, on the tile it started the tick on.

**Why not the per-tick target `(st / n) * min(1, n / laneCap)`** (the card's first proposal) with the old average. Measured
by shadow averages fed the same per-tick counts on the UAT save: it lifted the standstill tiles reading 0.6 or more from 0
of 55 to 14. Two things held it down. A queue moves off on every green, which drops the target to 0 for a few ticks, and
an 0.08 average (a 12-tick memory) follows that down by 0.4 within ten ticks: the overlay swung with the lights. And a
queue spaced a car a tile (most of them: 37 of the 55 standstill tiles carry under 1.5 cars a tick) is capped at 0.5 by
`n / laneCap`. A 0.03 average (about 33 ticks, one signal cycle of two phases) carries a queue through its green; averaging
the counts and dividing, rather than averaging a per-tick ratio, lets an empty tick lower the presence without reading as
"free"; and full at 0.75 cars a tick counts a queue a car a tile as the jam it is.

| shadow average on the UAT save, warm 150, span 60 | standstill tiles at 0.6+ | the twelve busiest at 0.75+ | back-and-forth on held tiles |
| --- | --- | --- | --- |
| main: fullness, EMA 0.08 | 0 of 55 | 0 | 0.08 |
| held share × min(1, n / laneCap), EMA 0.08 | 14 of 55 | 2 | swings with the lights (range 0.39) |
| S / max(N, 1), EMA 0.03 | 53 of 55 | 10 | 0 |
| **S / max(N, 0.75), EMA 0.03 (kept, in the sim)** | **48 of 48** | **12** | **0** |

**The probe**: `packages/server/src/loadtest/congestion-probe.ts --load SAVE [--warm 150 --span 60] [--json FILE] [--check]`
(or `--demo london`, `--districts N`). Per driven tile over the span: cars a tick, the share held, the ticks with a car
and the congestion value; the table below, the twelve busiest standstill tiles, signal approaches, the lag (ticks from a
queue forming to 0.5) and flicker. `--check` fails unless 90% of the tiles held 70%+ of the time with 0.8+ cars a tick
read 0.6+, the twelve busiest 0.75+ (or within 0.1 of a held share under 0.85, since the value is that share), tiles held
under 10% read under 0.2, and no standstill tile held through the last ten ticks goes back and forth by 0.1. Its range
over them is printed too: a jam still forming or easing moves steadily, which is not flicker.

**On the UAT save** (marg's city, 1,942 citizens), warm 150, span 60, tiles with a car at least a tick in four; rows how
held up their cars were, columns the value at the end of the span:

| main | <0.2 | 0.2-0.4 | 0.4-0.6 | 0.6-0.75 | 0.75+ |
| --- | --- | --- | --- | --- | --- |
| held 70%+ | 31 | 42 | 6 | 0 | 0 |
| held 40-70% | 43 | 7 | 0 | 0 | 0 |
| held 10-40% | 33 | 0 | 0 | 0 | 0 |
| held <10% | 53 | 0 | 0 | 0 | 0 |

| this branch | <0.2 | 0.2-0.4 | 0.4-0.6 | 0.6-0.75 | 0.75+ |
| --- | --- | --- | --- | --- | --- |
| held 70%+ | 1 | 4 | 4 | 13 | 50 |
| held 40-70% | 6 | 24 | 22 | 19 | 1 |
| held 10-40% | 12 | 6 | 0 | 0 | 0 |
| held <10% | 56 | 0 | 0 | 0 | 0 |

| UAT save | main, 150/60 | branch, 150/60 | main, 300/120 | branch, 300/120 |
| --- | --- | --- | --- | --- |
| vehicles, queued, speed | 173, 57%, 36% | 168, 57%, 35% | 257, 74%, 21% | 250, 63%, 30% |
| standstill tiles (held 70%+, 0.8+ cars a tick) reading 0.6+ | 0 of 55 | 48 of 48 | 0 of 130 | 80 of 89 |
| the twelve busiest | 0.22-0.52 | 0.71-0.95 | 0.28-0.45 | 0.67-0.96 |
| tiles held under 10% reading 0.2+ | 0 of 53 | 0 of 56 | 0 of 6 | 0 of 21 |
| signal approaches held 40-65% of the time (0.8+ cars a tick) | 0.11-0.15 | 0.49-0.57 | 0.14-0.28 | 0.45-0.78 |
| lag, a queue forming to 0.5: median, p90 (ticks) | 7, 26; 7 queues never got there | 3, 6 | 8, 14; 23 never | 4, 6 |
| back-and-forth on standstill tiles over ten ticks, max | 0.08 | 0 | 0.03 | 0 |

At 300/120 the branch is one tile short of 90% (80 of 89): those tiles carry 0.8 to 0.9 cars a tick held 70 to 75% of
the time, reading 0.55 to 0.6. The longer run also shows routing with a true number: drivers who see the jams go round
them, 63% queued against 74%.

**Routing.** `congestionWeight` stays 8: a standstill now costs about 9 a tile (it was about 5), a busy street whose cars
keep moving 1 (it was 2 to 3). `ab.ts`, 08:00 + 1,500 ticks, seeds 1-6, means:

| | trips | trip mean (ticks) | driven leg mean | commute | queued | speed | give-ups | re-routes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| main | 1,902 | 81.7 | 96.5 | 81.9 | 67.2% | 25.9% | 431 | 223 |
| this branch | 1,933 (+1.6%) | 80.9 (-0.9%) | 94.5 (-2.1%) | 79.2 (-3.4%) | 66.0% | 26.7% | 413 (-4.2%) | 281 (+26%) |
| congestionWeight 6 | 1,906 | 82.0 | 95.1 | 84.8 | 67.2% | 25.7% | 444 | 265 |
| congestionWeight 4 | 1,924 | 80.8 | 95.7 | 83.5 | 66.1% | 26.6% | 405 | 234 |

More drivers re-route (the jam they are in now costs more than the way round), and trips are a little shorter; 8 is as good
as 4 or 6 and the best on commutes, so it stays. The re-route thresholds compare route costs (a new way at under 0.85 of
the rest of the current one), not congestion values, so they need nothing. `meterCongestion` (off at 1) is a congestion
threshold; with the new meaning 0.5 would hold cars in their garages while half the road outside is held.

LONDON_ROWS

**Other readers.** The overlay byte (`net.ts`, 255 × congestionAt) and the client's ramp are as they were. The road
tooltip grades flowing under 15%, slow (was "busy") to 40%, congested to 70%, jammed above. The TV's 430 TRAVEL page lists
tiles at byte 150+ as jams and 220+ as standstill: the old number seldom reached either. Road wear (`render/roads.ts`)
follows a slow average of the same bytes: busy roads whose traffic flows no longer wear, held ones wear faster.
