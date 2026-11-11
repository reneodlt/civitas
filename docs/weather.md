# Weather and seasons (design)

Rich, 2026-11-11, from the multiplayer land design (`docs/multiplayer-land.md`): "yes let's have a prevailing wind and
strength - we can start to outline a complete weather and season mechanic." The wind came first because smell and smoke
from nuisance buildings should drift downwind; this document grows that into the whole weather and the seasons.

This is a design. It changes no game code. The questions in section 7 were decided on 2026-11-11.

## 1. Today

- **A TV-only forecast.** `forecast(day, seed)` in `client/src/render/tv.ts` hashes a sky ("Sunny spells", "Showers",
  ...), a high and a low and a wind speed for each game day. Only the TV weather map and teletext page 140 use it.
  Nothing in the simulation reads it; it has no wind direction and no season.
- **Hooks waiting for weather:**
  - `UTIL_WEATHER.faultMul(x, y, tick)` and `UTIL_WEATHER.windMul(tick)` (`shared/src/utilities.ts`,
    `docs/utilities.md` 4.4): storms on overhead lines, wind-turbine output. Both are 1 today.
  - `Ambience.setWeather(rain)` (`docs/audio.md`): rain and thunder recordings wait on it.
- **Lighting** follows the hour of the game day (`client/src/render/lighting.ts`); daylight is the same length every day.
- **The calendar.** A game day is 8 minutes; a game week (56 minutes) is a year of a citizen's life and a school year
  (`LIFE.daysPerYear` 7 in `server/src/sim/life.ts`). There are no seasons.
- **The seed.** The `welcome` message already carries the world's `seed`, which the terrain sampler uses.

## 2. The model: a pure function of the seed and the time

Weather lives in a new `shared/src/weather.ts` and is computed, not simulated or stored: `weatherAt(seed, tick)`
returns the same answer on the server and every client, so nothing goes over the wire and a reload or a local save
needs nothing new. One weather for the whole world (decided, question 19).

**Seasons** (decided, question 18: one cycle a game week). The year is the existing seven-day week: spring, summer,
autumn and winter take about 1¾ game days each (about 14 minutes real time), so a play session sees a season turn. The
season is a smooth position in the year (`yearPhase = (tick / TICKS_PER_DAY / 7) mod 1`), not four steps, so
temperature and daylight glide. The year starts in spring, so a new world opens in good weather.

**The world's climate**, from the seed: a prevailing wind direction (one of 16, weighted towards westerlies), its mean
strength, how wet the world is, and the size of the seasonal temperature swing. A coastal world (much water in the
terrain near the start) gets milder seasons and stronger wind.

**Pressure systems.** Time is cut into systems of 1 to 3 game days, each hashed from `(seed, index)`:

| System | Wind | Sky | Rain | Temperature |
| --- | --- | --- | --- | --- |
| Low (a depression) | swings round from the prevailing side, strong | cloudy | showers to heavy rain; storms in autumn and winter | mild |
| Ridge | prevailing, moderate | bright | rare | near normal |
| High | light, variable | clear, or fog at dawn | none | warm in summer, cold at night in winter |
| Calm high in winter | still | fog and low cloud for days | none | cold; inversions (section 3) |

Successive systems blend over a few game hours so the change is a front arriving, not a switch.

**Each hour:** temperature from the season, the time of day (coldest at dawn, warmest mid-afternoon) and the system;
cloud and rain from the system with hashed showers; wind direction wobbling round the system's direction; gusts. Rain
below about 1 °C falls as snow; snow lies while the temperature stays low and melts over a few hours after.

```ts
interface Weather {
  season: number;      // 0..1 year phase
  tempC: number;
  wind: { dir: number; speed: number; gust: number }; // radians the wind blows towards; tiles per game hour
  cloud: number;       // 0..1
  rain: number;        // 0..1 intensity; snow when tempC < 1
  fog: number;         // 0..1
  snowCover: number;   // 0..1 lying snow
  storm: boolean;
  daylight: [number, number]; // sunrise and sunset, game hours
}
```

**Cost.** A few hashes and blends; memoised per game hour on both sides. The TV `forecast(day)` becomes a reader of the
model, so the weather presenter is right.

## 3. Wind and the neighbourhood value

`docs/multiplayer-land.md` section 4 needs two views of the wind:

- **The climate (for planning).** A wind rose per world: the share of time the wind blows from each of 16 directions and
  its mean strength there, computed once from a year of the model. From it, a plume kernel per nuisance kind (a grid of
  weights round a source, long downwind, short upwind). Boundary limits, impact zones, the planning ghost and land value
  all use this average, so they are predictable before anything is built. The map shows the wind rose; a nuisance ghost
  shows its plume.
- **The day (for complaints).** Today's wind turns the plume: residents downwind today feel it, and complaints, moods
  and the news ("Smell over Eastfield on a still day") use it. Votes and value do not.

What the weather does to a plume:

| Weather | Effect |
| --- | --- |
| Strong wind | spreads further but thinner |
| Light wind | short and strong round the source |
| Calm fog (winter inversion) | pools: smoke and smell stay near the ground; "smog days" |
| Rain | clears smoke and dust from the air for the day |
| Heat | landfill and composting smell more in summer |

Noise leans a little downwind. The consequence is real geography: upwind land is worth more, downwind is where industry
ends up, and the east ends of cities with westerly winds stay cheaper.

## 4. What weather and seasons do

| Area | Effect | Where |
| --- | --- | --- |
| Utilities | heating gas demand in the cold, cooling power in the heat, street lighting with the length of night; wind-turbine output (`windMul`) | `sim/utilities.ts` |
| Storms | overhead-line faults ×10 for a few hours (`faultMul`); fallen trees closing roads until a crew clears them | `sim/utilities.ts`, a road-closure event |
| Floods | heavy rain over days raises rivers; low land beside them floods for hours: closed roads, damaged ground floors, people stay home | `shared/src/waterways.ts`, `docs/incidents.md` |
| Traffic | rain moves trips from walking and cycling to cars and buses, lowers speeds and raises collisions; snow slows everything until gritted | `sim/simulation.ts` mode choice, `TRAFFIC_TUNING` |
| Gritters and ploughs | a new fleet service from the highways depot, built like refuse rounds | `sim/mobile.ts`, a new round |
| Leisure | parks, sport and outdoor venues fuller in summer and dry weather; cinemas, theatres and bars on wet nights | leisure scoring in `sim/simulation.ts` |
| Building | site work slows in frost and heavy rain | construction progress |
| Health | flu season in winter fills clinics; heatwaves and cold snaps are harder on the elderly | `sim/life.ts`, `sim/death.ts` |
| Mood | sunny days lift happiness a little; long grey spells lower it | happiness |
| Transport | storms and fog delay flights, ferries and boats | `sim/airports.ts`, `sim/ferry.ts`, `sim/harbours.ts` |
| Refuse | summer heat makes missed collections smell (a disorder and smell source) | `sim/refuse.ts` |

**Damaging events** (decided, question 20: on). They are fair because they hit everyone by place, not by player, and
they come with warnings: a storm or flood warning a game day ahead on the TV, the news and a toast; flood risk shown on
the map before land is bought (land value and price take it in). They give flood defences, gritting and, later,
insurance a purpose. A player away from the game is protected by the same pause rules as the empty-land tax: a flood
damages but never demolishes.

## 5. How it looks and sounds

- **Sky and light:** cloud cover dims and greys the sun (`render/lighting.ts`); sunrise and sunset move with the season;
  fog shortens the view distance and greys the far scene.
- **Precipitation:** rain and snow as a camera-local particle volume (one instanced draw), heavier with intensity, slanted
  by the wind; wet roads darker and shinier; puddles after heavy rain; lying snow as a white blend on ground and roofs.
- **Seasons:** trees bud in spring, full in summer, turn and drop in autumn, bare in winter (a per-tree tint and density
  by year phase and a hash, so a street does not turn at once).
- **Cloud shadows** drifting with the wind.
- **Sound:** `Ambience.setWeather` with rain on roofs and thunder in storms; wind louder with speed.
- **The forecast:** the TV weather map and teletext 140 read the model; a weather chip in the top bar shows now and the
  next few hours.

## 6. Phased plan

| # | Subtask | Depends on | Main files |
| --- | --- | --- | --- |
| W1 | **The model.** `shared/src/weather.ts`: climate from the seed, seasons, systems, the hourly weather, the wind rose and plume kernels; the TV forecast reads it; a check script (a year of weather per seed: rain share, temperature range, the rose). | none | new `shared/src/weather.ts`, `client/src/render/tv.ts` |
| W2 | **Look and sound.** Rain, snow, fog, cloud dimming, wet roads, lying snow; ambience; the weather chip. Frame cost under 0.5 ms. | W1 | `render/lighting.ts`, a new `render/weather.ts`, `client/src/audio/` |
| W3 | **Plumes for the value field.** The climate kernel in `sim/value.ts`, today's plume for complaints, the wind rose on the map, the plume on the ghost. | W1, `docs/multiplayer-land.md` M1 | `sim/value.ts`, client overlay |
| W4 | **Effects.** Mode choice in rain, speeds and collisions, leisure, mood, utilities' demand and wind output. | W1 | `sim/simulation.ts` (hot), `sim/utilities.ts` |
| W5 | **Seasons in full.** Daylight with the season, trees through the year, heating and cooling, flu season, construction in frost. | W1, W2 | `render/lighting.ts`, `render/parks.ts`, `sim/life.ts` |
| W6 | **Severe weather.** Storm and flood warnings, line faults, fallen trees, river floods and the flood-risk map layer, gritters. | W4 | `sim/utilities.ts`, `shared/src/waterways.ts`, `sim/mobile.ts`, `docs/incidents.md` |

W1 first and alone: everything reads it. W2 and W4 can run side by side after it; W3 waits for the value field.

## 7. Decisions (Rich, 2026-11-11)

| # | Question | Decision |
| --- | --- | --- |
| 6 | A prevailing wind with a strength | yes |
| 18 | Season length: (a) a season a game day, (b) a cycle a game week, matching "a week is a year", (c) a slower cycle | (b) |
| 19 | One weather for the whole world, or fronts moving across the map | one world weather (moving fronts possible later) |
| 20 | Damaging events (floods, storm damage), with warnings and flood risk on the map | on |

(Numbers follow the shared list in `docs/multiplayer-land.md` section 10.)

## Built: W1 (date 2026-11-11)

`shared/src/weather.ts` (exported from `shared/src/index.ts`), `npm run weather:check` (`server/src/weather-check.ts`), and the TV
forecast reading the model. No wire change, no stored state, no simulation or rendering change.

**API** (as briefed): `climateOf(seed)`, `weatherAt(seed, tick)`, `seasonOf(tick)`, `dayForecast(seed, day)`. Results are
shared objects (do not mutate). `Weather.wind.dir` is a bearing in radians (see below).

**Compass convention (tile space).** North is -y, south +y, east +x, west -x (the camera looks along (-sin yaw, -cos yaw) in x,z with
z = tile y: yaw 0 north, 90 west; the map is north-up with y down). A wind is the direction it blows TOWARDS. Bearing b is
clockwise from north, `dx = sin b`, `dy = -cos b`; a westerly (from the west) is `dx = +1, dy = 0`. `rose[i]` blows towards
i * 22.5 degrees clockwise from north (0 N, 4 E, 8 S, 12 W). `dayForecast().windFrom` names where it comes from (`'W'` for a westerly).

**What it does.** Climate from the seed: prevailing bearing (86% of worlds from the west, towards east, spread up to about 80 degrees,
rounded to 16 points; 14% anywhere), mean speed 6-14 tiles/h, wetness 0.2-0.85, swing 6-14 C, annual mean 10-12 C. Year = one
game week, phase 0 the start of spring, warmest at 0.33 (summer's middle), coldest at 0.83. Systems: 48 h slots whose edges are
moved by up to 12 h (so 24-72 h each), low / ridge / high / calm (calm only for highs in the cold half of the year), each with
its own speed, cloud, rain level, temperature anomaly, fog and a wind swing; 8 h blends at fronts. Per game hour: cloud,
showers from smooth hashed noise, wind direction wobble, gusts, diurnal temperature (coldest 05:00, warmest 15:00, bigger swing when
clear), dawn fog in highs, all-day fog in calm winter highs, snow when raining below 1 C, storms (stormy low, rain, strong gust).
Daylight 12 +/- 4 h with the season. `weatherAt` interpolates between whole game hours. Snow cover is simulated for each game
day from a fixed 72 h before it, so it does not depend on cache state.

**Differences from the design.**
- `prevailing` is the biggest bin of the computed rose (the model is driven by a hashed base bearing; the rose peak is where the
  wind actually blows most, usually the same or the next point).
- The rose is counted over 8 years of the model, not 1: a year holds only about 3 systems and its biggest bin would often not be
  the prevailing one. Cost once per seed, about 30-40 ms.
- Not done: the coastal bonus (milder seasons, more wind near water) needs terrain and so is not a pure function of the seed;
  plume kernels (W3, with the value field).
- `dayForecast.wind` is in mph at 1.8 per tile/hour so the TV's old range (5-30) stays; sky words include "Snow", "Snow showers",
  "Gales", "Sunny"; the TV map and teletext 140 now also print the wind's point ("Wind NW, 25 mph").
- `forecast(day, chSeed, worldSeed)` in `render/tv.ts`: the world seed comes from `welcome` (`tv.worldSeed`, set in `main.ts`); the
  channel seed only varies the map's local temperatures.

**`weather:check` output (6 years of hours per seed).** All checks pass: determinism (repeat, reversed, strided, after the seed
cache evicted the world, neighbouring seeds differ); rose of 16 bins summing to 1 with the prevailing direction on the largest;
snow only below 1 C; systems never shorter than about a day. Sample rows (wetness, wet hours, rose peak, mean temp by season, snow):

| seed | wetness | wet hours | peak bin | spring | summer | autumn | winter | snow |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1234 | 0.39 | 30% | 38% | 13.3 | 17.7 | 8.3 | 4.1 | 0.3% |
| 987654321 | 0.53 | 37% | 42% | 14.4 | 18.1 | 9.3 | 5.6 | 0.8% |
| 55 | 0.53 | 43% | 35% | 12.8 | 16.8 | 9.7 | 5.8 | 0.6% |
| 42 | 0.78 | 57% | 37% | 14.5 | 21.1 | 7.3 | 1.4 | 11% |

Temperatures run about -8 to 32 C; storms 0-5% of hours; seed 42's rose puts 37% in the ESE-towards bin, 22% either side.
Cost: `weatherAt` 0.1 us warm, about 2 us a call playing on hour by hour from a fresh world, about 170 us for a random jump to a
cold hour (the snow day's 96 hours), `dayForecast` 40 us. Wet share rises with wetness; wetness over 0.7 gives 55-60%, a little
wet for a rainy world, tune the constants in `recOf` if it matters.
