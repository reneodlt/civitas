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

## Built: W2 (2026-11-11)

Weather now shows and sounds. Client only (no wire, shared or simulation change): `render/weather.ts` (new), and edits to `render/lighting.ts`,
`render/materials.ts`, `render/fpv.ts`, `render/perfhud.ts`, `audio/ambience.ts`, `main.ts`, `index.html`, `style.css`.

**One read a frame.** `WeatherView.update` calls `weatherAt(tv.worldSeed, liveTickF())` once and eases cloud, rain, fog, wind and snow cover
towards it (about 1 s time constant, so a clock correction or a front never pops; `reset()` snaps on `welcome`). Everything below reads that
`state`. The wet-ground value is its own: it soaks in about 2 s once it rains (not for snow) and dries over about 40 s (two game hours).

**What landed.**
- **Sky and light** (`lighting.ts`): cloud greys the sky colour (luma-matched, a little darker), cuts the sun to 12% at full cloud (shadows fade
  with it as the hemisphere light fills them; `shadow.radius` softens the edge), desaturates the ground and roofs 40%; fog turns the sky and the
  distance a pale grey. `celestial.veil = min(1, 0.95 cloud + fog)`. In `main.ts` fog shortens `fog.far` (x0.18 at full fog, x0.7 at full rain)
  and `fog.near`; first person gets the same through `Fpv.fogMul` (its 46-tile far plane x0.28 in thick fog). The tube and the map view are
  untouched (the particles are hidden there and underground).
- **Precipitation** (`weather.ts`): a camera-local volume, world-fixed lattice that wraps round the camera so drops do not slide with it.
  Rain: 9000 instanced screen-aligned streaks (one draw), thickness at least a pixel, slanted by the wind (up to about 30 degrees; wind dx, dy
  are tile space so dy goes to world z), tail up-wind, faded at the volume edges and at the lens. Snow: 7000 round points with a drifting
  sway, bigger than rain's width and slower. Intensity sets how many are drawn (`instanceCount`, `drawRange`). The volume is 14 tiles round the
  eye in first person, and round the look-at point sized by zoom (16-72 tiles) in the overhead view, with streak length and flake size scaling
  with it so the look holds from close in to far out.
- **Wet roads, lying snow, cloud shadows** (`materials.ts`, new `sceneUniforms`: `uWet`, `uSnow`, `uCloud`, `uWindOff`, `uSkyCol`, `uSkyLum`):
  wet ground darkens (roads 40%, land 12%), wet roads add a sky-coloured sheen at glancing angles; lying snow blends the ground and roofs to
  white by `snowCover`, each tile and roof with its own threshold so it arrives and melts patchily, roads carrying less than land (they read
  as gritted), water tiles never (blue-dominant colour test); roofs are the faces with an upward normal; and when cloud is over 12% a soft noise
  term darkens the ground by day, drifting with the wind (`uWindOff`). All of it is a uniform-gated branch: clear dry weather costs the
  fragment shader nothing but the tests.
- **Sound** (`audio/ambience.ts`): `Ambience.setWeather(rain, wind, storm)` is called every frame from `weather.ts`. Rain cross-fades light to
  heavy by intensity (zero in snow); the wind bed rises with the wind at every zoom (and brightens), gusts come more often; thunder rolls while
  a `storm` is on (about one every 20 s at full rain). `mixFor` has a trailing `wind` argument (default 0), so `audio-check` is unchanged.
- **The chip**: `#weather` in the top bar, "☂ 9°C · NW 23 mph" (icon for storm, snow, rain, fog, cloud, sun or moon; "calm" under 2 mph; the
  wind is named by where it blows from, mph = 1.8 per tile per game hour). The tooltip has the conditions now and every two game hours for the next
  twelve.
- **`?weather=rain|snow|fog|storm|clear`** forces the conditions (rain 0.7 at 9 C, snow -2 C with 0.95 lying, fog 0.85, storm 1.0 rain, gale
  and thunder, clear everything off); the wind direction stays the world's. `window.msc.weather` exposes the view.

**Frame cost.** The weather state, uniforms and chip are about 0.005 ms a frame on the CPU (5000 calls timed: 5 us; the perf HUD has a `weather`
phase for it, `weather.costMs` averages it over 60 frames). The rain draw adds about 1.0 ms to a frame in headless Chromium on SwiftShader, a
software rasteriser doing every pixel of 9000 quads on the CPU (3.3 against 2.3 ms and 6.3 against 5.3 ms over two alternating runs of 8 renders), so
the real GPU cost is well below that; submission is one draw call. Over the 0.5 ms budget only in that software test; measure on a real GPU
with Shift+M and `?weather=rain` before trusting it on a weak one.

**Screenshots** (`?name=w&weather=...&at=0,0&hour=14`, 1280x720, scale 1, swiftshader): `rain` (dist 40, pitch 30): the sky and light go grey, the
grass and roofs dull, roads near black, long grey streaks slanting NW to SE with the wind, denser at the front; `rain` close (dist 14): the
same over the streets, streaks fade at the lens; `storm`: the same at full density with a darker sky and a steeper slant; `snow` (dist 25 and
40): the ground and every roof white, roads patchy dark, grey sky, flakes of 2-4 pixels; `fog`: the far city washes out to a pale grey within
about 60 tiles, the ground fades to the sky colour, the sun veiled; `clear`: unchanged from before.

**Not done or noted.** First person was not looked at (a new world has no citizens to ride; the code path sets `fogMul` and the small eye volume, and is
type-checked only). Trees stay green in snow (W5). No lightning flash (thunder only). No puddles. The void beyond the world's edge draws
black (as before) rather than fogged; with fog the world's own ground fades correctly. Precipitation is camera-local in both cameras, so the
first-person inset shows its own volume, not the overhead one's.

## Built: W4 (2026-11-11)

The weather now changes the simulation. Server and shared only (no client change, no save change; the wire gains a story kind,
`weather`): `shared/src/weatherfx.ts` (new: the effects as pure functions of a `Weather`), `WEATHER_TUNING` in `shared/src/tuning.ts`,
`server/src/sim/weatherfx.ts` (new: `weatherNow(world)`, the effects for the world's tick, memoised per tick), and small additive
edits to `sim/simulation.ts` (mode choice, leisure scoring, site work, the mood input), `sim/traffic.ts` (road pace), `sim/taxis.ts`,
`sim/utilities.ts`, `shared/src/utilities.ts` (the `UTIL_WEATHER` hooks, `UtilityField.served`), `sim/airports.ts`, `sim/timetabled.ts` and
`sim/ferry.ts`, `sim/harbours.ts`, `sim/news.ts` and `game.ts` (the hold story), `sim/life.ts` (`HappyInputs.weather`), `shared/src/leisure.ts`
(`LeisureSpec.outdoor`, catalogue attribute `outdoor`), `shared/src/weather.ts` (`meanWindOf`) and three catalogue entries.

**One read.** Everything goes through `weatherFor(World.seed, tick)`: W1's `weatherAt`, or a forced condition. `weatherNow(world)` computes the
walk multiplier, road pace, collision factor, darkness, site-work factor and hold once per tick; the utilities solve, the mood and the
`UTIL_WEATHER` hooks read `weatherFor` directly. All of it is a pure function of the seed and the tick (no Math.random in the new code; the
personal "takes the car in the rain" draw is `hash2(id, 79)`), so a replay repeats: `weathersim:check` runs the same seed twice in the rain
and compares trips, visits, speed and every citizen's position.

**Forced weather for tests.** `WEATHER=rain|snow|fog|storm|clear|warm` in the server's environment (read once through `env.ts`, so local mode
never sees it) or `setForcedWeather(...)` in-process forces that condition at every tick, with the values of the client's `?weather=` (rain 0.7
at 9 C; snow -2 C with 0.95 lying; fog 0.85 at 6 C; storm: rain 1, gusts 48; clear 16 C; `warm`, server only: a sunny 24 C). Not sent to
clients: a client shows its own `?weather=` or the real weather. Never set it on a live server.

**What it does** (numbers are `WEATHER_TUNING` defaults):

| Area | Effect | Where |
| --- | --- | --- |
| Mode choice | the walk's perceived cost × (1 + 1.2 rain), × (1 + 1.5 intensity) in falling snow, + 0.6 × lying snow, + 0.04 a degree under 6 C (at most 0.5); the transit and taxi choices weigh it. Car owners: a hashed share, 0.5 × (walk cost − 1), also drive trips of 2-3 tiles (`DRIVE_MIN_TILES` 4 otherwise). There is no cycling mode in the game, so walking takes the whole effect | `Simulation.plan`, `transitChoice`, `Taxis.choose` |
| Road speed | pace × 0.9 in rain (from intensity 0.15, full at 0.7), × 0.75 on full lying snow where `ROAD_WEATHER.gritted(x, y)` is false (always, until W6's gritters), × 0.9 in thick fog; in the leg and in a fast car's look-ahead | `Traffic.weatherPace` |
| Collisions | `collisionMul(w)`: 1 + 0.5 rain + 1.5 snow + 0.8 thick fog. A hook: the incident system has no road collisions yet | `shared/weatherfx.ts` |
| Leisure | a place's outdoor share (`outdoor`: parks 1, botanical garden 0.6, open-air lido 0.8, London Eye 0.5, the rest 0) scores × (1 − 0.75 rain) × (1 − 0.05 a degree under 10 C, at most 0.6) × (1 − 0.35 dark), and up to × 1.35 on a warm (18 C+) dry clear day; the indoor share × (1 + 0.4 rain) in the evening | `Simulation.pickLeisure` |
| Utilities | demand × (1 + 1.2% a degree under 14 C, at most +30%) and (+2.5% a degree over 22 C, at most +30%); street lighting 0.02 u/h per served road tile in the dark; turbines × the wind against the world's mean (at most 1.5, 0 when gusts pass 40 tiles/h); storm faults ×3 overhead, ×2 nodes and buried. `gasDemandMul` is the hook for a gas network | `Utilities.solve`, `UTIL_WEATHER` |
| Mood | + up to 3 "a sunny day" (sun up, cloud under 0.4, dry, 15 C+; the full lift at 19 C); − up to 3 "a grey spell" / "days of grey, wet weather" when more than 75% of the last 72 game hours (sampled every 3) were grey (cloud over 0.8, rain over 0.15 or fog over 0.5). Pure in seed and hour, memoised | `weatherMood`, `happinessParts` |
| Transport | while a storm blows or fog is over 0.6: landings are held and land late when it lifts (diverted after 4 game hours); river buses keep their timetable but take nobody on and the planner skips them (status "sailings held: thick fog"); harbour events (catches, calls, cast-offs) wait and happen when it lifts. One news story per hold ("Fog grounds flights at ...", "River buses tied up in the storm at ...", "Ships wait out the fog off ..."), its headline changed when it lifts ("Flights land again at ... after the fog") | `Airports`, `Ferry.heldWhy`, `Harbours`, `News.weather` |
| Construction | site work × 0.7 in frost (0 C or lying snow over 0.3), × 0.8 in rain over 0.75 | `Simulation.workSite` |

**How often, real weather** (6 years of hours, five seeds): the walk costs over 1.3× in 28-59% of hours (dry worlds to wet; W1's wettest
worlds rain 55-60% of the time), roads are slowed in 30-59% (mean pace 0.93-0.98), sunny mood 1-12% of hours and grey 13-67%, site work
slowed 18-46%, flights and boats held 2-4%, turbines feathered 0-5%.

**Measured.** `ab.ts --hour 8 --ticks 1500 --set bus=2` (1×1 Commons built 3, two bus lines, seed 1; Math.random seeded). The pre-change commit,
the real weather of that morning, `clear` and `warm` give identical numbers (nothing changes on a mild dry day): planned walk 441, drive 348,
transit 6, 38 taxis; vehicle speed 37.5% of free flow. Under forced weather (runs vary a few percent with the mood's knock-on effects):

| | walk | drive | transit | taxis | walk share | speed |
| --- | --- | --- | --- | --- | --- | --- |
| dry (base) | 441 | 348 | 6 | 38 | 55% | 37.5% |
| rain | 298-327 | 447-453 | 14-16 | 47 | 39-41% | 31-33% |
| snow | 238-253 | 485-503 | 21-25 | 53-63 | 31-32% | 30% |
| storm | 290-315 | 418-443 | 13-24 | 38-52 | 38-41% | 33-34% |
| fog (6 C) | 416 | 376 | 1 | 36 | 52% | 31% |

`loadtest/leisure.ts --days 2` (a park, a cinema and a library in the 1×1 Commons; unseeded, about ±10%), arrivals at bars / cinema / library /
park and mean happiness: pre-change 768 / 111 / 51 / 105, 54.4; `clear` 727 / 101 / 49 / 82, 56.2 (fewer evening park visits after dark, and
the sunny lift); `warm` 770 / 108 / 42 / 90, 56.0; `rain` 753 / 104 / 51 / 35, 50.1; `snow` 733 / 103 / 44 / 13, 49.6; the real weather of seed 1's
days 2-3 (wet and cool) 781 / 108 / 50 / 60, 53.2. Parks lose most; the cinema did not gain in absolute terms (its evening slots were already
nearly full), so the indoor share of outings rises rather than the count.

`weathersim:check` (a 1×1 city, seeded, half a day from 08:00 on day 2): walk share 52% clear, 41% rain, 33% snow; speed 25.1%, 24.2%, 22.7%
(that city is congested, so the pace change shows less than in ab.ts); park visits 35, 22, 11; happiness 54.1, 49.3, 49.8. Utilities, 4
substations over 197 road tiles: noon demand 403.5 clear, 481.0 at -2 C (×1.19), 423.7 at 24 C (×1.05); 23:00 demand 270.9 of which 3.9 is
street lighting (1.4%), 322.1 in snow.

Transport: `loadtest/ferry.ts` (two river bus lines across a lake) carries 22 riders over its day in the real weather; with `WEATHER=fog` all day
both lines say "sailings held: thick fog" and carry none (that loadtest's own "riders board" lines then fail, as they should).

**Cost.** `ab.ts` sim ms a tick, the pre-change commit against this one on the same machine, three alternating runs: 1.21 / 0.96 / 1.00 against
1.02 / 1.04 / 1.07, within the noise. `perf:check` is unreliable on this machine and was not used. The motivation loadtest: 1.14-1.16 ms a tick
both ways.

**Judgement calls and not done.**
- No cycling mode exists, so "walking and cycling" is walking; the shift goes to cars (owners), taxis and the bus.
- Collisions are a hook (`collisionMul`), since the incident system has no road collisions.
- Holds are server-side: clients still draw planes landing and boats sailing to the timetable during a hold (they could read
  `holdReason(weatherAt(...))` themselves; left for W6's warnings). A held landing's passengers arrive late; a diverted one's never.
- Heating gas is a hook (`gasDemandMul`): there is no gas network. The electric share of heating and cooling goes on power demand. Nobody is
  billed for street lighting: the network's owner pays for its units.
- `windAt` (the turbines and the client's rotors) is now the hashed local gust signal × the weather's wind against the world's mean, capped at
  1; a windy world's turbines average a little more than before, a calm one's a little less.
- Forced weather is per process (`WEATHER`), not per world or GameConfig, to keep net.ts untouched while M5 and M7 work there.
- Hooks left for W5 and W6: `ROAD_WEATHER.gritted`, `collisionMul`, `gasDemandMul`, `faultMulOf` (storms ×3 now, W6 ×10), `holdReason`.

## Built: W6 (2026-11-11)

Severe weather: storm and flood warnings a game day ahead, fallen trees and road crews, river floods with flood walls and
the Flood risk layer, gritters. New: `shared/src/severe.ts` (the pure parts), `server/src/sim/severe.ts` (`Severe`, one per
game, a fleet service on `sim.mobile`), `client/src/render/severe.ts` (trees, water, walls), `npm run severe:check`
(`server/src/severe-check.ts`). Small additive edits: `shared/src/terrain.ts` (`makeElevationSampler`, `WATER_LEVEL`),
`shared/src/weatherfx.ts` (`setWeatherScript`, `weatherGen`), `shared/src/land.ts` (`landPriceOf`'s optional per-tile
multiplier), `shared/src/fleet.ts` (fleet kinds 12 road crew, 13 gritter), `shared/src/protocol.ts` (`severe`, `floodWall`,
ledger `flood`), `shared/src/issues.ts` (`OVERLAY_FLOOD` = 31, `isOverlayChannel`), `shared/src/value.ts` (the hazard kind's
words); server `sim/traffic.ts` (`closures`, `CLOSED_COST`, a per-world `gritted` hook), `sim/simulation.ts` (`stayHome`,
`closedAt`, a builder out with a unit does not look for a site), `sim/mobile.ts` (vehicle classes), `sim/value.ts` (flood
risk in the hazard byte), `sim/land.ts` (price and tax by tile risk), `sim/news.ts` (`severe`), `overlays.ts`, `net.ts`,
`game.ts`, `world.ts` and `snapshot.ts` (optional `severe` field, no version bump); client `main.ts`, `world.ts`,
`overlays.ts`, `input.ts`, `ui.ts`, `render/tv.ts`, `render/fleet.ts`, `audio/street.ts`, `style.css`.

**Pure, so everyone agrees.** Flood risk, the river level and the outlook are functions of the seed, the tile and the
tick (through `weatherFor`, so the W4 forced conditions and the new test script apply). The client's weather chip, the TV
and the buy-land preview compute the same outlook and risk the server warns and prices from; only fallen trees, the
water now and the walls go over the wire (`severe` message, on hello and when they change).

**Flood risk** (`floodRiskAt`, `floodRiskChunk`). The world is drawn flat, but the terrain noise has a height: water is
where it is under -0.22 (`WATER_LEVEL`). A land tile is at risk when its height is within `riskMargin` (0.1; sand is the
first 0.08) of the water level and it is within `riskNear` (6) tiles of water; risk is 1 at the water's own height and 0 at
the margin. A byte a tile, precomputed per chunk (0.8 ms a chunk, cached). About 9% of the land within 128 tiles of the
origin is at risk in seeds 1, 42 and 4242.

**The river level** (`riverLevel`). Each game hour's run-off is the rain over `heavyFrom` (0.3), a quarter of it in snow;
the level reads the decayed sum over the last 48 hours (×0.96 an hour). To make every world flood about as often, wet or
dry, the sum is scaled between the world's own 94th and 99.5th percentiles over eight years of its real weather
(`riverClimate`, once per seed, about 10 ms): 0 below, 1 above. A tile floods while the level is at least 1 − its risk
(`floodsAt`), counted from `floodFrom` (0.15). Real weather, six years per seed (seeds 1, 1234, 987654321, 55, 42, 7, 4242):
2-9 flood spells (about one a game week, one a real hour), 17-64 flood hours; seed 1 (the wettest) never goes deep.

**Warnings** (`severeOutlook`, `warningText`). Storms (W1's `storm` hours) and flood spells under way or starting within
`leadHours` (24) game hours. Once a game hour the server reads it and announces each spell once (the first hour it is
seen; saved): a news story ("Storm warning for X: gales and falling trees from 14:00 tomorrow", "Flood warning for X:
rivers rising ..."), and a toast to every mayor with land in a storm, or with tiles that flood at a flood's peak level
("... 226 of your tiles by the water (116 buildings) could flood. Flood defences (the Flood wall tool) hold the water
back"). The client: a ⚠ on the weather chip (amber) with the warnings at the top of its tooltip, a red band on the TV
weather map and the warning on teletext 140. Forced scenarios for tests: `setWeatherScript(tick => ForcedWeather | null)`,
a pure function of the tick (the check scripts "clear, then a storm from hour H for 6 or 40 hours"); never set live.

**Storms.** Overhead-line faults stay W4's ×3 (`faultMulOf`; not raised to the design's ×10). Fallen trees: in each storm
hour every road tile in a built chunk that is beside a tree (a park's grounds, or open grass with a wild tree on it, one
tile in four by hash) has `treePerHour` (1.2%) of a tree coming down across it, hashed from the tile, the hour and the
seed; at most `treeMax` (12) at once. The tile goes into `Traffic.closures`: the routers (`Traffic.cost`, so cars, buses,
fleet units and emergency vehicles) price it at `CLOSED_COST` (400), so new routes go round while any way round exists. A
crew from the nearest builders' yard within 48 tiles (a builder on shift with no site, `FleetKind.RoadCrew`, a hi-vis van)
drives there, works `crewMinutes` (45) and the road opens; with no crew, a contractor clears it after `treeClearHours` (8).
The owner of the road gets a toast, the news a story per storm.

**Floods.** Once a game hour, at `floodFrom` and over, a flood fill from the water's edge through the floodable land of
built chunks (only those, so which wild chunks a client has loaded never matters). Flooded road tiles join
`Traffic.closures`; flooded buildings (by door) shut: `Simulation.stayHome` keeps their residents home instead of setting
out for a shift (and the staff of a flooded workplace), `closedAt` takes a flooded venue out of outings. Each flooded
building's owner pays `damageShare` (8%) of its book value once a flood (ledger `flood`, "Flood damage", one-off), one
toast per owner and hour; no level is lost and nothing is demolished. An owner not seen for `LAND_TUNING.awayPauseDays`
(3, the empty-land tax's pause) pays nothing; `floodInsured(owner)` (`sim/severe.ts`) is the hook for insurance and is
false for everyone. The news: "Floods close 64 roads in X; 116 buildings under water", then "Floodwater goes down in X:
roads reopen".

**Flood defences: the simple rule.** A flood wall is a tile of `Severe.walls`, not a catalogue building: the **Flood
wall** tool (after the builders' yard; dragged along a bank like track, $30 a tile, only on the player's own empty land;
a click on a wall takes it down for half back; a road, zone or building put on the tile later removes it). Wall tiles
stop the flood fill while the level is at most `wallHold` (0.85), so the land behind a **continuous** wall along the risk
edge stays dry; a gap lets the water round; above 0.85 it tops the wall and the land behind floods. Chosen over per-tile
protection within a radius: the fill is cheap and a wall does what a wall does.

**Flood risk on the map and in the price.** The **Flood risk** overlay (channel `OVERLAY_FLOOD`, in the H cycle after
Neighbourhood): the risk on every dry tile at risk, a third of it on tiles a wall protects and on walls, the top where the
water is now. The buy rectangle's status line: "flood risk: 40 of 64 tiles by the water (12 flood in a bad spell), priced
lower". Land price: `landPriceOf(r, bytesOf, mulOf)` multiplies each tile by `floodPriceMul(risk)` = 1 − 0.45 × risk on
both sides (so preview and charge agree; `land:check` compares them), and the empty-land tax reads the same per-tile
price. The value field's hazard byte is at least 0.6 × the cell's mean risk, so households mind it too; in a cell with a
field that lowers its land value a little more (a small double count, left: the per-tile price works where there is no
field, the hazard where people choose homes).

**Gritters.** While snow lies (cover over 0.05) or falls within `gritAhead` (6) hours, each builders' yard plans a round:
road tiles within 28 tiles, main roads first (avenues, motorways and ring roads, then junctions, then the rest; nearer
first), as the waypoints of a nearest-neighbour walk (24, every second tile), and its first free builder on shift drives
it (`FleetKind.Gritter`, an orange lorry with its beacon). Every road tile a gritter drives over is gritted for
`gritHours` (10): `ROAD_WEATHER.gritted(x, y)` is true there (and `Traffic.gritted`, the same per world), so the W4
lying-snow slowdown is lifted (pace 1.00 against 0.76 ungritted in full snow). Builders work day shifts, so night snow is
gritted on the morning round.

**`severe:check`** (all pass, about 16 s): risk only on land by water; the level a pure function of the hour; on a low
shore of seed 4242 (Bob's 20×20 town at (206, -254)), a scripted 40-hour storm: the flood warning issued at hour 23 for a
spell from hour 47, the water at hour 48, Bob's toast and the news; 445 tiles under water, 64 road tiles closed, 116 homes
flooded and shut, people in a flooded home stay home and a dry home's do not; Bob billed $296 once for the 116, no home
lost or demolished; the water down and every road open after; a second run identical. A continuous wall along the risk
edge (181 tiles) keeps all 184 tiles behind it dry at level 0.8 and is topped above 0.85; the overlay byte 124 open, 39
behind the wall; Bob buys 3 tiles of wall for $90; his shore is $525 against $600 without the risk; the hazard byte 29%
by the water, 1% on dry ground; a save mid-flood keeps the walls, the water, the warnings and the buildings already
billed, and bills nothing twice; an old save loads. In a 1×1 test city filled for 30 hours: the storm warning at hour 32
for hour 56 and Ada's toast; two trees down, a closed tile costs 402, a route between the tiles either side goes round (5
tiles); a save mid-storm keeps them; both cleared by road crews from the yard; the same trees in a second world; snow due
at 10:00: three gritter rounds, 76 tiles gritted, traffic's pace 1.00 on a gritted tile and 0.76 on another.

**Cost.** `Severe.tick` in a 2×2 test city (4,978 people) through a storm and a snow spell: 0.05 ms a tick on average
against 5.6 ms for the whole step; the worst tick 16 ms, the first hour after the weather script changed (the outlook's
hundred hours of river level recomputed); in steady play the outlook adds one hour of run-off an hour.

**Judgement calls and not done.**
- Crews and gritters are builders from builders' yards (no highways depot exists); a builder out on a crew does not look
  for a site. Builders work days, so crews and gritters do too (the contractor covers trees at night).
- A closure is a cost, not a wall: a vehicle already routed through the tile drives on through it, and with no way round a
  route still crosses it. The client draws the tree, barriers and water; road tooltips do not yet say "closed".
- Walls are a server-side tile set drawn by the client, not catalogue buildings (no level, no upkeep, no planning).
- Defences do not change the price (the risk is the ground's); the overlay shows them.
- One river level for the world, as one weather (question 19); no catchments.
- Storm line faults kept at ×3, as briefed.
- `ROAD_WEATHER.gritted` is process-wide (the last game made sets it: right for a server or a local game); the traffic
  reads its own world's `Traffic.gritted`, so checks with several games stay right.
- Insurance is the `floodInsured` hook only.

## Built: W5 (2026-11-11)

Seasons in full. Client: `render/seasons.ts` (new), edits to `render/lighting.ts`, `render/materials.ts`, `render/roads.ts`, `render/parks.ts`,
`render/weather.ts`, `render/tv.ts`, `main.ts`, `ui.ts`. Shared: `seasonDate(phase)` in `weather.ts`, a block of `WEATHER_TUNING`. Server: `sim/weatherfx.ts`
(`seasonHealthNow`, `SEASON_FX`), small additive edits to `sim/life.ts`, `sim/simulation.ts` (`lifeHealth`) and `sim/death.ts` (`lifeRoll`). No wire change, no save change.

**Street lamps and lit windows follow the real dusk.** `uNight` already came from the sun's elevation (`sunAt`), so the lamps were not on a clock hour; what
was fixed to the equinox was the sky reflected in window glass (`mscSky(hour)` took the sine of the hour) and the windows' evening schedule. Now:
`Lighting.update` sets `uElev` (the sun's height now), `uDusk` (the hour the sun is 3 degrees up on its way down, bisected from `sunAt` and cached while the
phase moves under 0.002) and `uYear`; the glass reflects `uElev`; the windows' schedule (`mscOnAt`, `mscOffAt`, near panes and the far `mscLitShare`) brings
"lights on" forward to dusk when dusk is early (`on = min(on, dusk - 0.5 + 0.6 (on - 16))`) and keeps people up a little later while the light lasts (`off` moves
0.45 h per hour of dusk from 18:00, -1.2 to +1.5 h). Occupancy stays by the hour (who is home, bedtime, the morning wake). The lamps' pools, lanterns and
vehicle lights keep reading `uNight` (staggered per lamp, between the sun about 4 degrees up and 1.5 below). Dusk by season (sun 3 degrees up, sampled at the mid-day phases of a game week): 15.7 at midwinter, 17.6 at the start of spring, 19.2-19.7 in early summer, 16.9 in late autumn (sunrise 4.4 to 8.4). Server side was already right: `darknessAt` reads `sunAt`.

**Trees through the year** (`render/seasons.ts`). A vertex-shader patch on the trees' Lambert materials (street trees' crowns and columns in `roads.ts`, park
broadleaf in `parks.ts`; conifers evergreen; the trunk meshes untouched), driven by `uYear` and a per-tree hash of the instance's world position (no new
attribute, no CPU work). Leaf amount: buds open over about a quarter of a year (each tree its own start, young leaves a fresher yellow-green), turn from about
phase 0.46 (each tree yellow, orange or red by hash, in step with its own turn), drop from about 0.56 to bare by 0.8 (the canopy shrinks to 55% of its size
towards its centre and takes a branch brown, so bare trees stand as twig masses with the trunk showing; the shadow pass has the matching depth material, so
a bare tree casts a lighter shadow). Snow (`uSnow`, each tree its own threshold) lays white on the canopy's upper faces, on bare and evergreen alike.
Grass: `uGrass` (greener at spring 0.12, a touch yellower by 0.45, copper-dull at 0.62, grey-brown and 55% desaturated in winter), applied in the ground shader to
green-dominant non-road pixels, before the weather. Not done: junction roundabout/meadow trees and hedges are baked into the tile meshes (they stay
green; hedges placed as crowns do follow the year); the buildings' garden trees in the building models; blossom for the cherry (it turns like the rest).

**Seasonal sim effects.**
- Flu: `fluWave` peaked in early spring (phase 0.15, before there were seasons); it now peaks in mid-winter (`HEALTH.fluPeak` 0.9; `fluPeakOld` for A/B), and a cold
  day (the day's low from `dayForecast` under 4 C) multiplies everyone's flu chance by up to 1.6 (`WT.fluCold`).
- Thermal stress (`seasonHealthNow`, memoised per game day): a heatwave is a day's high of 27 C or more, a cold snap a low of -3 C or less, stress 0..1 over the next 6
  degrees. People of 65 and over lose up to 2 health a day at full stress (clinic demand and frailty follow), and from 70 the old-age death chance is up to
  x1.6 (`deathChance(age, health, thermal)`; the Math.random draw count is unchanged). How often: heatwave days 0-11% and cold-snap days 0-10% of the days of a
  seed (seeds 1234, 987654321, 55: under 3% each; 42: 9% and 9%; 7: 11% and 10%; seed 1 none), so some worlds have them and some never do. `SEASONFX=0` in the server's
  environment turns the whole of this off (flu wave back at its old peak, no stress, no cold boost) for A/B loadtests.
- Heating and cooling follow the season (W4's `powerDemandMul`, checked over a game week at mid-day phases, seed 1234 / seed 42): demand x1.05 / 1.05 at the start
  of spring, 1.00 / 1.02 in summer, 1.12 / 1.18 at midwinter; lamp hours (dark share of the day) 9 in summer to 16 in winter. `loadtest/utilities.ts`' own checks are
  unchanged.

**Season indicator.** The weather chip now begins with the season ("Spring · ☂ 9°C · NW 23 mph") and its tooltip's first line is the season and the date; the clock's
"day N" carries the same as its tooltip ("Autumn, 14 Sep (a game week is a year)"). The calendar (`seasonDate(phase)`): phase 0 is 1 March, so spring is March to May,
summer June to August, autumn September to November and winter December to February (a game day is about 52 calendar days). The TV weather map's footer and teletext 140 name
the season and the date ("Sunny spells. Autumn, 14 Sep."). I tried the season in the clock text itself and took it out: the top bar wraps it to three lines.

**`?season=spring|summer|autumn|winter`** forces the year phase (0.1, 0.38, 0.59, 0.86): the sun's path and dusk, tree and grass looks, the chip's season; the weather
is read from a clock moved by whole game days to land in that season (a forced winter has winter's temperatures and snow chances, `?weather=` still overrides).
README Debug row added.

**Measured.**
- Per-season health, 1 district of 55-90 year olds (`lives`-style, 8 game weeks = 8 years, the same code with `SEASONFX=0` against `1`, seeds 7 and 42; about 1400-1600 citizens;
  flu cases a day, doctor visits a day, sick days a day): old (flu peak early spring): winter 11-12 flu, 7-9 visits, 3-4 sick days; summer bucket 92-94 flu, 52-53 visits,
  20-21 sick days. New: winter 129-132 flu, 73-75 visits, 9 sick days; the day-0 spring bucket (winter's wave tail) 130-135 flu, 59 visits, 34-35 sick days; summer 44-46 flu, 8-12
  visits. The wave's peak is about 40% higher (the cold boost).
- Deaths over those 8 years: 309 / 331 (old) against 310 / 321 (new), seeds 42 / 7: no measurable change (stress days are rare and add under 2 deaths a year on a few hundred;
  per-season deaths a day 4-7 both ways, noise). Old-age deaths in winter are not visibly raised: 5.8 and 6.2 a day (new) against 5.1 and 4.9 (old), within the spread.
  `lives.ts --districts 1 --weeks 8 --ages 55-90` printed the same story (about 300-310 deaths either way, doctor visits 783-850, sick days 1300-1560).
- `loadtest/death.ts`: 40/40 with `SEASONFX=0`; with the seasons on, "the 3 dead wait at the mortuary" failed (states 1,3,3): the test kills the first three people at home at 09:00,
  and in a winter flu wave different people are at home, so the hearse needed more than the 1.2 game days it allowed. Its wait is now capped at 3 days (it returns as soon as all three are in): 40/40.
  `loadtest/motivation.ts`: 29/29. `weather:check`, `weathersim:check`, `history:check`, `npm run typecheck` (with `local:check`) and `npm run build` pass.
- Frame cost. CPU: `Lighting.update` adds a few multiplies (`grassFor`, uniform writes) and the dusk bisection only when the phase moved 0.002 (14 `sunAt` calls, a few microseconds
  a few times a second): not measurable. GPU: tree vertex shaders gain a hash and some mixes per vertex (a few thousand vertices); the ground fragment shader gains one
  branch (green-dominance test, a multiply) on land; windows gain two `min`/`clamp` per pane. Headless Chromium on SwiftShader draws about 1 frame a second at this scene (the
  rasteriser, not the shader changes), so the A/B is not measurable here; check with Shift+M on a real GPU.

**Screenshots** (`?name=s&season=...&weather=clear&hour=14&at=-6,-4&dist=15&yaw=200&pitch=32`, 1280x720, scale 1): `spring`: lawns a fresher green, street trees opening, some still
yellow-green; `summer`: full green crowns with a copper beech and pink cherries; `autumn` (0.59): grass duller and warmer, street trees yellow, orange and red tree by tree, some already thin;
`winter`: grass grey-green, trees bare twig masses with the trunk showing; with `weather=snow` the ground and roofs white and the bare crowns capped with white. Dusk: `hour=17`: winter is fully
dark, lamps lit and windows glowing in the early evening; summer is full daylight; `hour=20` summer is at dusk with the lamps coming on and `hour=22` is night.
`hour=17` winter against summer is the clearest pair.
