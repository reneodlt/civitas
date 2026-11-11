# msimcity

A web-based, multiplayer, unbounded city builder platform. three.js on the client,
an authoritative TypeScript simulation server over WebSockets, and a shared
package so both sides agree on the world format.

The core idea: players buy and manage **land parcels**, but **citizens are not
theirs**. A citizen lives in whichever residential building spawned them, looks
for the nearest job anywhere on the connected road network, commutes there every
day, pays income tax to whoever owns the parcel they work in and property tax to
whoever owns the parcel they live in. Players compete and cooperate through
zoning, roads and tax rates, not through walls.

## Run it

```sh
npm install
npm run dev          # server on :8080 and Vite client on :5173, both bound to 0.0.0.0
```

### Opening the game

Open `http://<your-lan-ip>:5173/` (the Vite banner lists the addresses). The page is a home page with three ways in (docs/demo.md, "The home page"):

1. **Explore a city**: a card for every demo the server lists (London, the showcase, the focused demos), live status while one is built; **Open** goes to `?demo=<id>`, read-only on a public showcase.
2. **Play**: your own city in this browser, no server and no account: **Continue**, **New game from zero** or **Sandbox**. The game server serves the offline build at `/play/`, saves live in this browser (docs/local-mode.md).
3. **Multiplayer**: the public servers in `packages/server/servers.json` (ours is listed as closed until sign-in exists), and on a dev or UAT server "This server's live world" with the mayor-name join form, folded.

Above these sits a **showreel** strip: ten building thumbnails, three short clips of the Showcase and three lines on how it plays, all pre-rendered (so the page has no WebGL) by `node packages/client/scripts/showreel.mjs` into `packages/client/src/showreel/` (docs/demo.md, "Showreel").

Every browser that joins a live world shares it. A link with any query (`?demo=london`, `?name=Ana`, `?ws=host:port`, `?local`, `?at=x,y`) skips the home page and opens the game as before; `/?go` is the game's bare page (the join form, or `DEFAULT_DEMO`).

Buildings are data: `packages/shared/src/buildings/` holds one file per kind family, and
`npm run buildings:compile` (run automatically by dev and build) turns it into the tables the
game reads. `/viewer.html` shows every kind, level and design on a turntable by day and night.
Format and a worked example: `docs/buildings.md`. `npm run buildings:check` is its snapshot test.
Landmarks (a famous building, a town hall, a monument): `docs/landmarks.md` is a brief a person or a model can follow on its own, with a template, a worked example and a draft path (`landmark-drafts.ts`, viewer tag `draft`); `npm run landmarks:check` checks them.

Production: `npm run build` (add `npm run build:local` for `/play/`) then `npm start`. The server then serves the built
client, the offline build under `/play/` and the WebSocket on one port (default 8080). A `Dockerfile` is included;
mount `/data` to keep the world across restarts.

Environment: `PORT`, `HOST`, `SEED` (new worlds only), `WORLD_FILE`, `STATIC_DIR`, `PLAY_DIR` (the offline build), `SERVERS_FILE` (the Multiplayer list), `GIT_SHA` (the home page footer's build id; a Docker build arg).
Sign-in (`docs/accounts.md`): `HANKO_API_URL` asks for a Hanko sign-in before the live world (`HANKO_AUDIENCE` checks the token's audience);
`DEV_AUTH_USERS="ana:pass,ben:pass"` is the built-in test sign-in for dev and UAT (`DEV_AUTH_SECRET` keeps its tokens across restarts).
Accounts are bound to mayors in `ACCOUNTS_FILE` (default `accounts.json` beside the world file); `AUTH_CLAIM_EXISTING=1` lets a signed-in
account take a mayor from before sign-in. Without either, the name typed is the identity, as before. `npm run auth:check` tests the flow.
Dev knobs: `SIM_STEPS=10` fast-forwards (ten simulation ticks per interval),
`SEED_BUILT=3` starts a new world with the Commons already built to that level,
and a file named `RESET` next to the world file makes the next start discard it.
Client: `VITE_WS_URL` to point at a server on another host, or `?ws=host:port`. `TEST_CITY_BASE_PORT` (default 8100) moves the test-city ports.
A public showcase (`docs/demo.md`, "A public showcase"): `SPECTATE=1` makes the whole deployment read-only for every client, the
live world and every demo child alike (the children inherit it). The server refuses every intent that changes the world with a
"Read-only showcase" toast (a whitelist in `net.ts`, `READ_ONLY`: subscriptions, inspects, the lines list, the charts), and
the HTTP API refuses demo stop and reset and test-city start and stop (403); starting a demo still works, as that is how a
visitor gets in. The page hides the tool bar, the treasury, the tech tree, Reset demo and the context menu's changes, and joins
at once as a made-up "Visitor 1234" instead of showing the join form. `DEFAULT_DEMO=<id>` (e.g. `london`) sends a page opened
without `?demo=`, `?ws=` or `?city=` to that demo instead of the live world, and the server starts it as it starts; with
`SPECTATE` the server lists, starts and joins only the default, the warmed and the kept demos (a `?demo=<other>` link opens the default instead). The page
reads both from `GET /api/config`; each world also says `spectate` in its welcome. Without them nothing changes.
On a showcase the server also builds its sample cities itself (`WARM_DEMOS`, default all, one at a time; `KEEP_DEMOS`, default `DEFAULT_DEMO`, stay running) and builds again any whose scenario changed since its save (`docs/demo.md`, "Warming and rebuilding").
`DEFAULT_VIEW="x,y,dist,yaw,pitch[,hour]"` (yaw and pitch in degrees, the hour freezes the lighting) is the camera's opening
shot on a bare page (no camera parameters, no `?demo=` or `?city=`: the `DEFAULT_DEMO` or the live world), also through
`/api/config`, so it can be retuned on a running deployment by changing the env and restarting. `msc.viewString()` in the
browser console gives the current view in that form (with the hour when the lighting is frozen, `?hour=` or the light chip).
Test cities (dev servers only, not with `NODE_ENV=production`): the join form lists the live world and pre-built
1×1, 2×2, 3×3, 4×4, 6×6 and 8×8 district cities (about 950 people per district, level 3, every tech) so you can watch where
the simulation slows down. Choosing one starts it as a child server process (same entry, port 8100+n, world file
`data/test-cities/city-<n>x<n>.json`, `CITY_DISTRICTS=n`), fast-fills a new city before it takes clients, and reloads the
page onto it with `?ws=host:port&city=n` and a "not the live world" banner. `GET /api/test-cities` lists them,
`POST /api/test-cities/<n>/start` (or `/stop`) controls them. A city with no clients for ten minutes is stopped
(`TEST_CITY_IDLE_MS` changes that) and saves on the way out. They survive the dev server's restarts (`tsx watch` reloads on every
save): the main server adopts the ones still running, listed in `data/test-cities/running.json`. Ctrl-C on `npm run dev` (SIGINT), or
`TEST_CITY_STOP_ON_EXIT=1`, stops them; a reload (SIGTERM) does not. `?city=n` alone also starts and joins one.
Demo maps (every server, production included; `docs/demo.md`): the join form also lists the **Showcase**, a lived-in
3×3-district town where every placeable kind bigger than 1×1, every size-ladder rung, a runway, track, two bus lines, a
passenger line and a freight line are placed once and running, and three focused demos (Transport, Leisure, Civic). Each
runs as a child process like a test city (port 8190 for the showcase, world under `data/demos/`), reached through this
server at `/demo-ws/<id>` so one published port is enough; `?demo=<id>` opens one. A **guided tour** panel flies the camera
from object to object with a caption from the catalogue's `blurb` and `howTo` (what it does, how to build it, tool,
footprint, rotation, technology, costs) and the object's live tooltip, with its outline and marks and a floating label on
every stop. **Reset demo** puts the town back exactly as first built. The scenario is data in
`shared/src/demo/showcase.ts`; the seeder (`server/src/demo/seed.ts`) builds it through the players' planners.
`npm run demo:check` fails when a placeable kind, a ladder rung, a surface tool, a line mode or a registered feature
(`SHOWCASE_FEATURES`: every bridge style, a level crossing, every plane type, every helicopter service, every merged lot)
is missing from the showcase.
**London** (`?demo=london`, port 8194) is a sample city on London's shape: the Thames as water with its meander, causeway
bridges, the City and Canary Wharf as merged towers, the West End, rings of homes, docks and industry down river, the parks,
four termini with a line each, freight, buses and Heathrow, with a tour by area. The map is data in
`shared/src/demo/london.ts`, painted by `server/src/demo/london.ts` in place of the 3×3 districts.
**Paris**, **New York** and **San Francisco** (`?demo=paris`, `?demo=new-york`, `?demo=san-francisco`, ports 8195-8197)
are sample cities on the city-map kit, each a data file (`shared/src/demo/city-*.ts`): the water, places, parks,
railways, main roads, districts, landmarks, lines and tour of a city as latitudes and longitudes, planned by
`shared/src/demo/citymap.ts` and `citydemo.ts` and painted by `server/src/demo/citymap.ts`. Paris has the Seine round the
Île de la Cité, its six landmarks, Métro 1 and 4 and the Batobus; New York Manhattan's grid between its rivers, the eight
landmarks, the Brooklyn Bridge as a real crossing, the 1 and the 7; San Francisco the Golden Gate and Bay Bridges,
Alcatraz, BART under the bay and the ferries (docs/demo.md "Sample cities and the city-map kit").
The perf readout (top-bar **perf** chip or **Shift+M**, always on in a test city) shows the server tick average, p95 and max
for the last minute against the 200 ms budget (amber over 50 ms, red over 200 ms), agents and bytes per second received,
FPS and frame time, the frames over 20 and 50 ms and the long tasks, and the **frame budget**: one row per cause (the frame's
phases, the network handlers, and what is left to the browser) with its ms and share; agents drawn, chunks loaded, draw calls, the JS
heap and the sound engine's cost per 250 ms tick. **trace 10 s** downloads a trace (ours and a Chrome/Perfetto one, with the server's
`/api/perf`); **jitter 10 s** (`msc.perf.jitter(10)`) names the causes of the frames over 33 ms and says whether the server was late or
the audio coincided; a **chunk rebuilds** row and sentence say how many chunks were rebuilt, their ms and what marked them (one
chunk at a time, about 6 ms a frame, `client/src/render/chunkWork.ts`). The server has `/api/perf` (tick phases, worst ticks, long-tick traces, GC, lag, memory), `POST /api/perf/profile`
(an inspector CPU profile, summarised) and `/metrics` for Prometheus; `npm run perf:check` guards the tick against a committed
baseline. All in [docs/perf.md](docs/perf.md).
Load tests: `nice -n 10 npx tsx packages/server/src/loadtest/run.ts --districts 2 --days 3`
builds an N×N-district test city and times a full game day; results and method in
`docs/load-tests.md`. Traffic A/B: `npx tsx packages/server/src/loadtest/ab.ts --hour 8 --set name=value,...`
runs the Commons through a rush hour with any traffic tunable changed (`docs/traffic-tuning.md`).

## Controls

The scheme follows city builders (Cities: Skylines, Anno) for the mouse and map apps (Google Maps, Mapbox) for the
trackpad. It works the same on a three-button mouse, a two-button or Magic Mouse and a Mac trackpad, and never
guesses the device: browsers cannot tell a smooth-scrolling mouse from a trackpad (`client/src/gestures.ts`).

| | Three-button mouse | Two-button / Magic Mouse | Trackpad | Keys |
| --- | --- | --- | --- | --- |
| **Zoom** (about the cursor) | wheel | scroll | pinch, or two-finger scroll | + − (Page Up / Down) |
| **Pan** | right drag, or drag the map with the select tool | right drag, or drag the map with the select tool | drag the map with the select tool; Shift + two-finger scroll | WASD / arrows |
| **Rotate and tilt** (about the point under the cursor) | middle drag | Alt/Option + drag | Alt/Option + drag, Alt/Option + two-finger scroll (sideways turns, up and down tilts), twist (Safari) | Q E turn, R F tilt |
| **Select** | click | click | click | 1, Esc |

Shift+drag pans with any tool. The **scroll** setting in the help line (bottom left) makes plain scroll pan instead of
zoom, trackpad style; pinch still zooms. A press that moves less than 5 pixels is a click, so a slightly shaky click
still selects. A click, a hover and the ghost pick the building under the cursor, its upper floors and roof included, not the ground behind it (`client/src/pick.ts`: the ray is walked tile by tile from the camera and meets each building's drawn column); the road, rail, runway and street-rule drags still read the ground, so a drag across a building does not hop to its roof. Bridges, flyovers and rail decks pick as the ground. The mouse cursor hints the active tool (`client/src/cursors.ts`): a bulldozer for bulldoze, a road mark for the road, rail, runway, pylon, cable and street-rule tools, a crosshair for the other placing tools, and a pointing hand over a building, person or vehicle in select mode.

| Action | Input |
| --- | --- |
| Panels | the panel on the right (land, a building, a person) keeps its head with ✕ in view while its body scrolls; **Esc** or ✕ closes it. A parcel's panel (on a frontier "<name>'s charter") also folds to its title (–), and its build list shows eight sites with "show all" for the rest (up to 50; the head counts them: "30, showing 8"). `client/src/ui.ts` |
| Context menu | right-**click** (press and release without dragging) a person, car, train, plane, building, road, track or land for the actions that exist for it: inspect, follow, first-person view, go to home or work, build priority, parcel settings, buy this tile, demolish (asks again to confirm, shows the cost). Greyed entries say why in a tooltip. Esc closes; also on the FPV inset. `client/src/contextmenu.ts` |
| Performance | Server tick split into twelve phases with a rolling minute, the ten worst ticks and long-tick traces (`/api/perf`), an on-demand CPU profile (`POST /api/perf/profile?ms=5000`, summarised), a hand-written `/metrics` with a Grafana dashboard (`docs/perf/`), and a client frame budget (Shift+M) with a downloadable trace and a jitter finder; `npm run perf:check` fails on drift from `packages/server/perf-baseline.json` (`server/src/perf/`, `client/src/render/perfhud.ts`, docs/perf.md) |
| Sound | Web Audio over real recordings from Freesound.org (all CC0; credits in `client/src/audio/CREDITS.md`), each loaded the first time it is wanted, with procedural synthesis as the fallback (`client/src/audio/`, docs/audio.md). Nothing plays before your first click or key press. **M** mutes and unmutes (the status line says "Sound off"; Shift+M is the perf readout); **Shift+S** or the **audio** chip opens the audio readout, every voice sounding now with its level and why plus a log of the last 40 starts and stops; a **sound** switch and a 0 to 100 volume slider sit in the help line at the bottom left and the **sound** chip in the top bar toggles it; the choice is kept in this browser, in local mode too. The city has a bed for what is on screen: traffic rumble, wind that rises as you zoom out, a crowd murmur where people are, works and power-station hum, water; street life drawn from what is on screen (each car, van, lorry, bus, moped and bicycle passing close is heard as it goes by, panned along its path and falling in pitch, footsteps and talk follow the walkers close in, and a fire engine or ambulance on a call carries its siren, louder as it nears), birds by the hour (a dawn chorus 04:30 to 07:00 over parks and homes), owls at night, the hour struck by a churchyard or Parliament in view, a signal crossing's beep while it holds the cars. In first person the vehicle takes over and the city drops 6 dB: a bus's diesel rattle with door hiss and stop bell, a train's whine over rail joints, a tube train's tunnel boom, a boat's chug, an aircraft's roar. Pick, place, refuse and undo have clicks. Each district has a sound of its own, picked by which kind of building most of the street is (a soft-max over the zone shares): factory floor, metal and a reversing lorry over the works; tills, shop doors and a busker over the shops; air handling and lift bells over the offices (quieter after 19:00); a quiet street with doors, children and a radio over the homes; a murmur and camera shutters at a landmark; birds only by day where there are parks and homes, and digging only where a site is going up. Recordings add a market, a pub, a playground, a stadium and a fountain, gulls, pigeons, a dog, a police station's siren, builders' hammering, fireworks, and a bell peal at ten; rain and thunder wait for a weather system (`Ambience.setWeather`). Each voice varies per instance; the manifest (`audio/manifest.ts`) names every recording's Freesound source, and docs/audio.md says how to re-run the fetch and swap a clip |
| Tools | 1 select · 2 buy land · 3 road (opens its class picker on the class last used: country lane, street, one-way street, avenue, motorway, pedestrian street, locked ones greyed with their technology; drag: straight or one corner, the way the traffic goes on a one-way, Shift held while dragging for a loop, Esc lets go, built on release with its cost shown; over a road of another class to upgrade it in place; across water for a bridge; Ctrl/Cmd+Z undoes the last drag for 30 s; docs/roads.md) · 4 residential · 5 commercial · 6 industrial · 7 office · 8 police · 9 fire · 0 health · Y builders · P parking · G parks · L libraries · cinemas (tool bar only) · B sport · V theatres (each opens its size picker on the size last used; docs/buildings.md "Groups and tiers") · J airport terminal · U runway (drag) · [ rail halt · ] rail station · `\` freight yard · railway track (drag, tool bar only) · K bus depot · bus stop (tool bar only) · roundabout (the 5×5 two-lane one on an avenue), mini-roundabout, flyover, interchange (click a junction or a motorway, tool bar only; a flyover clicked again swaps the deck) · turn rules (click the road before a junction: no left, no right, no straight on, no entry) · signal crossing (click a street; docs/roads.md "Junctions") · street rules (opens its picker: HGV ban, bus lane, double yellows, 20 zone; click a street to set it along the whole street, drag along part of one, click a street that has it to take it off, Ctrl/Cmd+Z undoes; the ghost gives the cost, the day's upkeep and an HGV ban's detour for lorries; docs/roads.md "Traffic control") · X bulldoze · Esc back to select |
| Turn a footprint | Z turns the footprint of a building bigger than 1×1 anticlockwise, C clockwise, in quarter turns, while its tool is active (airport terminal, bus depot, rail halt and station). The choice sticks for that tool until you change it; before the first press the footprint faces a road by itself. The preview shows each tile's outline, an arrow from the door towards the road (green with a road, red without) and the building's marked parts (platform, apron, stands, vehicle gate); hovering a placed structure shows them faintly |
| People and cars | hover anyone for who they are and what they are doing; click to select them in a side panel with a **follow** camera |
| Trains and planes | hover a train or plane to highlight it; click to select it: a panel with its line or flight, what it is doing, speed, its crew and everyone on board (a train's riders are clickable citizens; plane passengers are visitors), and **follow**. `client/src/vehicles.ts`, docs/rail.md and docs/airport.md |
| First person | with someone selected, **FPV** in the panel or I opens a 16:9 inset (bottom right) from their eyes, **full** or O fills the window (Esc leaves); the view follows their heading and leans into corners, walkers bob, drivers sway, and it ends when they go indoors or arrive. Out at a bar or restaurant, the picture takes a slow swim, a double image and a soft blur that build with the hours the server says they have been there and are heavy after three ("a little tipsy", "tipsy", "very drunk" in the panel; the walk home eases off over half an hour to an hour and a half by how drunk they left; the cinema, theatre and cafés stay clear), `docs/fpv-night-out.md`. With a train selected it rides in the driver's cab, with a plane in the cockpit, or as a passenger: a bus, a carriage, a tube car (a followed citizen who boards, or a name from the roster), a seat from the plane's manifest. `render/fpv.ts`, `render/nightout.ts`, `render/passenger.ts` |
| Money | click the treasury chip for the ledger (yesterday and today by category, grouped into running costs and one-off spending with a total each, and the daily running balance that leaves building and buying out; overdraft interest included). While the treasury is below zero, in administration or with a service mothballed, a chip beside it opens the money panel: the balance, the $5,000 overdraft limit, the interest a day, midnights below zero or days in administration, the running balance a day, and the recovery plan as buttons (raise tax, sell land back, mothball services, each with what it would raise or save; in local mode also "Start again from the last autosave"). It opens by itself when administration begins. A police, fire or health building or a builders' yard of yours has **Mothball** / **Reopen** in its panel. `client/src/finance.ts` |
| Overlays | H cycles the overlays: traffic congestion on the roads (green → red), then service coverage, leisure, happiness and jobs against homes tinted on the ground and the buildings (colour-blind safe ramps: viridis, and blue against orange for jobs/homes), then off; the top-bar **overlay** chip opens a menu to pick one, with its legend, and the **Traffic panel** (R5: cars on the road by who drives them, arrivals by gateway, the worst junctions and longest queues, each a link; with the congestion overlay on, hovering a red road says why it is slow). `client/src/overlays.ts`, `client/src/trafficpanel.ts`, `server/src/overlays.ts`. T opens the technology tree; Shift+M shows the perf readout (M alone is the sound mute) |
| Problems | a badge floats over any of your buildings or lots that is stuck: on fire, no road, no builders, unstaffed, parking full, no customers, very unhappy; hover it for what is wrong and what fixes it, click it to open the building. The top-bar **problems N** chip (red while there are any) lists them by kind, each with **show me**. `server/src/sim/issues.ts`, `client/src/render/issues.ts`, `client/src/problems.ts` |
| Fires | homes and works catch fire now and then (bigger and older ones more often). The nearest staffed fire post or station within 14 tiles sends its engine on blue lights; it drives down the middle of the road past stopped traffic, and the damage is what had burnt when it arrived. With no engine in reach the building burns down. Flames, smoke and a scorch show on the building, an **On fire** badge leads the problems list, a toast names who is coming, and the bill is **Fire damage** in the ledger. Your first fire is a warning the neighbours always put out. docs/incidents.md, `server/src/sim/fires.ts`, `client/src/render/fires.ts` |
| World map | **Tab**, the top-bar **map** chip, or zoom out past the 3D limit (zoom back in to return; `?map` opens on it): the whole world flat and north-up, land use in colour, every owner's land outlined and named, bus, rail and underground lines. Scroll, pinch, + and − zoom, drag pans, click a parcel for its area, buildings, population, jobs and book value; on your land shift-click neighbours and **Combine** (a rectangle up to 48 a side merges, the rest become an estate sharing name, colour and tax), **Split** along a dragged line, rename and colour. `client/src/mapmode.ts`, `docs/world-map.md` |
| Adverts | about one shop or venue in three carries an empty ad frame (a poster on its flank, a billboard over a flat roof or a car park, banners by a stadium's gates), and so does every bus shelter and every building site's hoarding. Once **Advertising** (zoning track, T) is unlocked, the top-bar **ads** chip opens the **Campaigns** panel: make a campaign (a theme, a claim from the table filled with one of your parcels' or workplaces' names, colours, layout and icon; $150 artwork), then **Pick frames** (free frames glow; click a building to rent its frame; Esc stops) or **Rent 3 nearest** (around the middle of the view). Each campaign shows its frames, cost a day and how its posters are wearing; **Take all down** and **End**. Rent ($2-10 a day by size) goes to whoever owns the frontage, so frames on your own land cost you nothing. Posters fade, get tagged and tear over game days, fast in streets with people out of work and no services, slowly in well-served ones. The goal "Run your first campaign" teaches it. docs/adverts.md, `client/src/adverts.ts`, `client/src/render/adverts.ts`, `server/src/sim/adverts.ts` |
| Bus lines | the top-bar **lines** chip: make a line from your stops (click them in order), number, colour, loop or there and back, buses per line; ribbons show the lines while it is open. `client/src/lines.ts`, `docs/transit.md` |
| Debug | `?dev` shows draft kinds in the tool bar (a dev server accepts them, also on unclaimed land) and, on a dev server, skips technology locks, `?airport=x,y,dir[,gates[,fph]]` previews planes at a placeholder airfield on open land, `?name=…` skips the login form, `?at=x,y&dist=n&yaw=deg&pitch=deg` positions the camera (yaw 0 looks north, 90 west; pitch 90 straight down), `msc.viewString()` prints the view as a `DEFAULT_VIEW` string, `?hour=h` freezes lighting, `?fx=0..2` pins shadow quality, `window.msc` exposes client state |

Buy land by dragging a rectangle. Your first parcel can go anywhere; every
later purchase must share an edge with land you already own (touching at a
corner does not count, and public roads on unclaimed land do not count). You
also cannot island someone else: a purchase is refused if it would wall in
another owner's parcel (the Commons included) so that it can no longer reach
the open country around your holdings, or if it would enclose a pocket of
unclaimed land bigger than four tiles. Small notches are fine and water never
counts as an enclosure. The buy rectangle turns red and the status line says
why before you let go; the server makes the same check and is the authority.
Roads are dragged and built on release: the ghost shows each tile's cost and, in red, why anything will be refused,
and a road over a building asks first (demolish it, or build round it). Zones are painted by dragging; zoning and
parking lots go round road tiles and buildings (bulldoze first to rebuild there), and the server says how many lots
it left alone and which newly zoned lots have no road beside them (the hover turns amber over such a lot: it builds
only once the building in front grows back into it, or a road reaches it). Streets are named, British style, and
their owners can rename them (right-click a road); a building's panel gives its address (docs/roads.md).
Roads can be laid on unclaimed land too (at a premium) so parcels can be joined
up; zoning needs land you own. Nothing gets built until builders can reach it:
connect to a road network that has a builders' yard, or place your own (your
first opens at once; later ones are built at urgent priority by whichever
builders can reach it). Once a game hour the server tells an owner with eight or
more lots waiting why: no yard of their own while the Commons' yard works its own
streets, or a yard that no road links to them. Select a parcel
for its population, jobs by kind, tax income, build list and tax rate.

## Architecture

```
packages/
  shared/   tile encoding, chunk coords, terrain noise, wire protocol (TS types)
  server/   World (chunks, parcels, players, buildings) · Simulation · Net · Store
  client/   three.js renderer, chunk streaming, input tools, DOM overlay UI
```

**World.** An unbounded grid of 32×32-tile chunks. Terrain is a pure function of
`(seed, x, y)`, so a chunk is generated the first time anything touches it and
never needs to exist before that. Each tile is one uint16 (terrain, road, kind family code,
building level); parcel ownership is a parallel int32 per tile, a third byte per
tile (the aux layer) marks the tiles of multi-tile structures (`docs/aux-layer.md`), and a fourth
(the sub layer) holds the catalogue kind id where a family has more kinds than the tile's 16 codes (`docs/sub-kinds.md`). Chunks a player
has changed are persisted; all others regenerate from the seed.

**Simulation** (`server/src/sim/simulation.ts`) runs at 5 ticks/s, 2400 ticks
(8 real minutes) per in-game day, 7 days a week. Every per-tick rate in the sim
is written relative to `TICKS_PER_HOUR`, so the day length can change without
changing behaviour in game time.

- *Growth.* Zoned lots next to a road want to grow when there is demand
  (residential demand follows job surplus and vice versa) and only upgrade when
  mostly occupied. Top-tier housing wants a staffed service nearby. A 1×1 lot
  tops out at level 3; from level 1 a building may instead **merge** with
  neighbouring lots of its zone and owner into a bigger kind (terrace row,
  department store, office tower, heavy plant and twelve more, up to 4×4) that
  climbs to level 7, keeping everyone who lived or worked there
  (`docs/buildings.md` "Merged lots"). Growth does not build anything by itself:
  it opens a **construction site**.
- *Block interiors.* The middle of a block has no road, so nothing grows there
  on its own. Zoning round a block zones its middle too, and a frontage building
  of the same zone and owner grows back into it as a **deep plot** (1×2, levels
  2-4), with its door still on the road; bigger merges reach in as well. When the
  twelve tiles round a 2×2 middle are all homes, the residents plant it as a
  **communal garden**: a small park only those homes count, free to its owner
  (`docs/buildings.md` "Block interiors").
- *Builders.* A builders' yard employs builders. On shift they pick a site by
  priority first and road distance second, travel there, and work it down;
  several builders finish a site faster. Placing a civic building opens a site
  too. If the yard belongs to someone else, the site's parcel owner pays the
  yard's owner a fee per unit of work. Owners can raise, lower or pause each
  site from the parcel panel; paused sites are abandoned by their crews.
- *Occupations and shifts* (`shared/src/occupations.ts`). The workplace kind
  decides the job: office workers are mostly 9–5 Monday to Friday, shops run
  early, day and late shifts with rotating days off, factories run three shifts
  round the clock, police do three 8-hour shifts, firefighters 24 on / 48 off,
  hospital staff 12-hour shifts. Each citizen has a fixed personal jitter and
  leaves home early enough for their own commute, so traffic is staggered.
- *Getting around.* About half of citizens own a car (office workers more) and
  drive anything beyond a short walk; everyone else walks. A trip is a list of
  legs: walk to the car, drive, park, walk the last stretch. Walkers use the
  sidewalk side; routes are re-planned if a road disappears.
- *Traffic* (`server/src/sim/traffic.ts`). Every road tile has one lane per
  direction holding two cars, and a one-way tile (a one-way street, or one
  carriageway of an avenue or motorway) two lanes its way. The server works out real positions: right-hand
  lanes 0.19 from the centreline, tight arcs round right turns and wide arcs
  round left turns, so a car's corners stay where a car's corners would be.
  Drivers follow bumper to bumper plus a personal gap (never closer than the
  two vehicles' lengths allow), pull out of a building only when the last car
  to leave has cleared the start, and never overtake. At the edge of every
  tile a car decides once whether to go in: there must be room in the exit
  lane beyond the box, no movement already in the box that conflicts with its
  own (a precomputed conflict table of all approach/exit pairs, built from the
  lane geometry), no pedestrian on that tile's carriageway, and a green light
  where the owner has signals. Pedestrians walk the right-hand sidewalk,
  wait at the kerb for cars already in the box before crossing (at junctions,
  on left turns and when their door is on the far side), and cars hold at the
  stop line while someone is on the crossing. Each tile keeps a congestion
  average that drivers route around (A\* with turn and junction costs,
  re-routing after a long wait with hysteresis), that the heat overlay shows,
  and that road tooltips report. Behind all of these rules a body guard is the
  last resort: no car moves its body onto another car or a pedestrian, and no
  pedestrian steps into a car. Each car keeps a speed and brakes in time for
  the car ahead, a bus halt and a turn into lights rather than stopping dead;
  at lights a car close behind one going the same way follows it into the box;
  and the client draws cars along a curve between the server's five positions a
  second so their speed changes smoothly (`client/src/render/glide.ts`). A
  driver who has not reached a new tile for 60
  ticks gives up, so a jam can always clear. The rules and their values live in
  `TRAFFIC_TUNING` (`shared/src/tuning.ts`); `docs/traffic-tuning.md` has the
  measurements they were chosen from. With Junction design (Transport tier 3) a
  junction can be rebuilt as a **roundabout** (a 3×3 one-way ring round a planted
  island, anticlockwise since traffic drives on the right, give way to the ring on
  entry, no lights) or a **flyover** (one road lifted over the other on a deck, no
  conflicts and no turns): `shared/src/junctions.ts`, aux bytes 0xf0–0xfa.
  **Junctions** (R4, docs/roads.md "Junctions"): an avenue crossing's two or
  four junction tiles work as one set of lights (two phases, or four with
  protected left turns where two avenues cross), the last two tiles of a one-way
  approach hold its turn lanes, and a car crossing an avenue waits in the
  reservation's median box. Junction design adds a mini-roundabout (painted on
  a street junction, aux 0xfb), a 5×5 two-lane roundabout on an avenue (aux 0xfc
  and road class 6) and, with Motorways, a diamond interchange (a street over a
  motorway with slip roads; road class 7 under the deck). With Traffic signals a
  junction's arms take turn bans and no-entry signs, which every router honours
  (emergencies on a call ignore the bans), and a street takes a signal crossing
  walkers press; a pedestrian street crossing a street has one already.
  **Traffic control** (R5, docs/roads.md "Traffic control"): with Traffic
  signals a street takes an HGV ban (lorries go round but to deliver there), double
  yellow lines (no kerb parking) and a 20 zone (humps, 60% speed, routes avoid it);
  with Public transport a one-way street or an avenue's carriageway takes a bus lane
  (its kerb lane for buses, bikes, taxis and emergencies). The rules are per tile in
  the road rule records, set per street. A motorway connection's panel has a visitor
  limit (half the visitors come in by it); the Traffic panel (overlays menu) shows
  who is on the roads, arrivals by gateway, the worst junctions and the longest
  queues, and with the congestion overlay on a red road's tooltip says why it is
  slow. The Lorry curfew policy keeps lorries off your streets 22:00-06:00.
  With Civil engineering (Transport tier 3) a road dragged straight across up to
  12 tiles of water, from a road on one bank to dry land on the other, becomes a
  **bridge** (stone arch, steel girder or suspension by span and hash; $120 a
  deck tile): plain straight road to the traffic, nothing joins it from the side,
  bulldozing any of it removes the whole bridge (`shared/src/bridges.ts`, aux
  bytes 0xd8–0xdf, drawn by `client/src/render/bridges.ts`).
  **Road classes** (`shared/src/roadclass.ts`, docs/roads.md "Classes"): a
  country lane (cheap, slow, grass verges; the frontier's first road), the
  street, a one-way street (two lanes the way it was dragged), an avenue and a
  motorway (each two tiles wide, a one-way carriageway either side of the
  reservation, two lanes each; the motorway fast, with no frontage, joined by
  slip roads and never crossed) and a pedestrian street (walkers, bikes,
  emergencies and deliveries out of shop hours). Routers never go against a
  one-way or across a reservation but at a junction; the class sets speed,
  lanes and route cost, and `Traffic.roadRank` its rank at a junction. Classes
  live in aux bytes 0x01–0x3d; the street has none, so old worlds are streets.
  Besides commuters the roads carry delivery trucks (industry → commerce, a
  fee per drop), visitors driving in from the edge of the network at peak
  hours, and, with the Patrols technology, police patrols, fire engines and
  ambulances that ignore signals.
- *Parking.* Buildings have a few surface spaces, or many more underground
  once the owner has Deep foundations; an arriving car drives in and holds a
  slot until it leaves. When the destination is full the driver heads for the
  nearest parking lot within ten tiles (a buildable kind: twelve bays, a fee to
  the parcel owner, visible parked cars), parks and walks. With no lot in reach
  they park at the kerb, which costs that lane a slot and slows the street.
  Tooltips show spaces, turned-away counts and lot income.
- *Car sharing* (`server/src/sim/carpool.ts`). A driver leaving home may take
  household members due out within half an hour (same workplace, or dropped
  at the door on the way when the detour is small) and a neighbour working
  nearby (picked up from home), at most three passengers and two stops; a
  parent driving to an outing takes the children who come along. Going home,
  people without their car at work or a venue wait up to an hour for family,
  a colleague living near or a friend leaving by car. Passengers are not road
  users while aboard: they get out at their stop or where the car parks and
  walk the rest with the driver. How readily people share is per household and
  per pair (hash-seeded, rolled per trip or per day). The car's panel lists who
  is in it (names select them); a passenger's says whose car they are in.
  `CARPOOL=0` switches it off for before/after runs.
- *Technology* (`shared/src/tech.ts`). Four tracks of three tiers (zoning,
  construction, transport, civic). Each tier needs a counter the player's own
  city drives (construction work done on their land or by their builders, road
  tiles, residents housed, jobs filled) and a one-off price. Costs and conditions
  were tuned for the first two hours (docs/early-game-audit.md "After Gauntlet 3"). A new player starts with roads,
  residential zoning and a builders' yard; the Commons has everything, so it
  shows what the tree leads to. The server enforces the tree when building and
  when zones try to grow; the client greys out locked tools.
- *Sizes* (`shared/src/buildings/groups.ts`, `shared/src/tiers.ts`, docs/buildings.md "Groups and tiers"). Services and
  leisure come in size ladders, from a GP surgery or a police box on one tile to a 4×4 teaching hospital, a 3×3 police
  headquarters, a construction company, a multi-storey car park, an opera house or a floodlit stadium. The tool bar
  shows each ladder once; its size picker lists every rung with a snapshot, footprint, capacity, coverage, upkeep, cost
  and the technology it needs. Bigger rungs cover homes further and more strongly, send more patrols and ambulances,
  bring more and faster builders or hold bigger crowds; the larger ones open late in the Civic, Construction and
  Culture tracks.
- *Landmarks* (`shared/src/buildings/landmarks-london.ts`, docs/buildings.md "Landmarks"; docs/landmarks.md for contributors). Real London buildings (the
  Gherkin, the Shard, the Walkie Talkie, One Canada Square, the Royal Opera House, and five more to come), tagged
  `london`, each working as an office tower or a venue. The tool bar's Landmarks section has one London button whose
  picker lists them. Their tech node, London landmarks, is locked until its unlock rule is decided, so for now they are
  placed only in sandboxes (test cities and demos, where the London demo has them in their real places).
- *Buses* (`server/src/sim/transit.ts`, `docs/transit.md`). Public transport, a fifth transport tier, opens bus
  stops (a shelter beside a plain stretch of road), a 3×2 bus depot whose staff drive the buses (one bus out per
  driver on shift, 05:30–00:30) and the Lines panel. Buses are 0.6-tile vehicles in the ordinary traffic model: they
  pull in on the stop's road tile, dwell while people get off and on (40 aboard at most, $2 a ride to the line's
  owner, children free, retirees half), and hold briefly when they catch up with the bus ahead. A citizen whose car
  is at home weighs a line (a stop within 5 tiles of each end, one change allowed, a short walk between stops) against
  walking and driving, with a hash-seeded personal taste for each; riders wait in a small crowd at the stop, ride
  hidden in the bus and walk on from their stop. Lines are drawn as ribbons while the panel is open; stop and bus
  tooltips show lines, waiting, the next arrival, load and delay.
- *Airports* (`shared/src/airport.ts`, `docs/airport.md`). Aviation, a fourth
  transport tier, opens an 8×7 airport terminal (placed facing a road, staffed
  by ground crew on early and late shifts) and the runway tool: drag a straight
  line of 10 or more tiles five tiles behind the terminal and a six-row strip
  of runway, shoulders and taxiway is painted. A finished terminal with an
  intact strip is an airport. Planes fly a timetable that is a pure function of
  the tiles, so the server and every client agree without a wire message, and
  each landing pays the owner a fee. Bulldozing any strip tile grounds it.
- *Railways* (`shared/src/rail.ts`, `docs/rail.md`). Rail, the transport tier after Public transport, opens track
  (painted by dragging on your own land, one corner per drag, joined up where drags meet; it crosses a straight road at right
  angles on a level crossing, whose barriers close ahead of each train while cars, buses and walkers wait, and no water yet), a 4×2 halt and a 6×3 station whose platform runs along the back row, behind which the track
  must run. Rail lines are transit lines: pick stations in order in the lines panel, loop or there and back, and
  trains. Consecutive stations must be joined by track and no two lines may share track (no signals yet). A train
  is a locomotive and two to four carriages; where it is is a pure function of the line, its route and the tick,
  so only the lines and their routes go over the wire. Trains run 05:00–01:00 spaced by a headway, brake into every
  platform and dwell there, reverse at the ends of a there-and-back line (one train) or run round a loop (as many
  as fit), and riders board and alight through the transit registry. Bulldozing a track tile grounds the line.
  A line of freight yards (6×3, a loading dock on the track and a truck gate on the road) is a freight line: a
  locomotive and 4–8 mixed wagons (container flats, tankers, hoppers, vans) that stand longer to load. Industry
  within 12 tiles of a yard sends most deliveries by train when the line reaches a yard near the shop: a truck to
  the yard, the train, a last-mile truck from the far yard, and $4 a container to the line's owner.
- *Gateways* (`server/src/sim/gateways.ts`, `shared/src/gateways.ts`). Newcomers arrive and leavers go through the town's
  gateways: the **motorway connection** (a 2×3 dual carriageway end placed at a road end on the edge of town, no technology
  needed, tool bar only), rail halts and stations, the bus depot (intercity coaches) and the airport terminal (plus a share
  of every plane's passengers). Each gateway's `gateway`, `gatewayModes` and `arrivalsPerHour` are catalogue attributes.
  When a home has room, a newcomer queues at the best gate (nearest, weighted by capacity), is released at a jittered
  time within the gate's hourly capacity, appears there and travels home with a suitcase on foot, by taxi or driving
  their own car with a roof box (hash-seeded per person), moves in and looks for work. Leavers (idle too long, broke,
  taxed out, living alone and moving on) pack up, travel to the gate that suits them and are removed there; their bed
  frees when they have gone. With no gateway in town people spawn in place and leave at once as before (the home's owner
  gets a notice once a day). Visitors and inter-city freight (lorries in to shops, a quarter of factory deliveries out)
  enter and leave by the motorway connections instead of the farthest road tiles. The stats line shows today's net
  migration and who is waiting at the gates; a gateway's panel shows arrivals and departures today and yesterday.
  Fast fills (test cities, demos) bypass the gates. `npx tsx packages/server/src/loadtest/gateways.ts --days 2` probes it.
- *Lives* (`server/src/sim/life.ts`). Every citizen has a birthday (one game week is about a year), health and a
  household. Newcomers arrive as adults aged 18–45; children are born to couples living together once their home has
  a free bed (the home then holds its next free bed from newcomers), grow up at 18 and look for work, and people
  retire in their sixties and die of old age, more often past 75. Health drifts with age, factory and site work,
  time stuck in traffic and hospital coverage; flu comes in seasonal waves and spreads at home, factory and site
  workers get injured, chronic illness comes with age. The ill skip shifts, see a doctor at the nearest staffed
  hospital, and stay in when very ill. Singles pair up with colleagues or neighbours and move in together, grown-up
  children move out, people living alone leave town now and then (more when unhappy or crowded), and friendships
  (at most five) start at work and over a drink; friends and children come along on evenings out. Happiness
  (commute, money, health, services, nights out, company) and the last week's money in and out show in the
  citizen panel, where family and friends are clickable; homes list residents by household. A life step runs once
  per game day per citizen, staggered over the day. `npx tsx packages/server/src/loadtest/lives.ts --weeks 4`
  fast-forwards a test city and prints its population pyramid, households, births and deaths.
- *Cafés, bars and restaurants.* Commercial buildings double as venues: some
  people stop for a coffee before work, many go out after an evening shift, and
  people on their day off go out in the afternoon and evening. Visitors spend
  money and the venue's parcel collects sales tax.
- *Mobile jobs* (`server/src/sim/mobile.ts`, `shared/src/fleet.ts`, `docs/mobile-jobs.md`). Some workers work on the
  road: a hashed share of shops are cab offices whose staff drive cabs (roof sign lit for hire, waiting at a station or
  airport rank) or private hire from home in their own car; a quarter of café and restaurant staff deliver meals on
  bicycles and mopeds that filter past queues at the kerb edge; waste and recycling depots (a share of industry) send
  bin lorries round each district on its weekday, stopping at every home's kerb while a bin is tipped, and street
  sweepers two days later; warehouses and distribution centres send courier vans in a morning and an afternoon wave.
  A citizen without a car (or out for the night) weighs a taxi against walking, the bus and driving; homes order food
  at lunch and dinner and get parcels. The workers keep their ordinary jobs, so jobs and housing stay balanced; fares,
  meals, collection fees and parcel fees go to the owners. Tooltips show cab offices, takeaways and depots at work and
  a home's bin day; a worker's panel links to the vehicle they are out in. `loadtest/mobile.ts` probes it.
- *Parks and leisure venues* (`shared/src/buildings/leisure.ts`, `shared/src/leisure.ts`). Parks (no
  staff; a pocket park grows into a park and a large park with use), libraries and community halls, cinemas,
  sports halls and theatres (Culture tech track) are placed like civic buildings. Every citizen has a leisure
  need that drains over a few days; a visit restores it by the place's leisure value, and parks near home
  top it up a little each day. An outing (after a shift, a free afternoon or evening) scores the open places
  in reach by time of day, life stage, the citizen's hash-seeded taste for that kind of place, an event about
  to start and distance, against a bar: cinemas peak in the evening and on premiere nights, retirees and
  children favour parks and libraries by day, and children old enough go to a free park or library on their
  own. Friends and children still join. Tickets are spent like bar tabs (sales tax to the parcel) and staff
  are paid from the takings; visitors drive and park like anyone else. Homes count the leisure places in
  reach (their leisure coverage), which raises growth, the taxes residents will bear and happiness
  ("+5 park nearby", "−4 nothing to do"). Trees and benches in parks are instanced (`client/src/render/parks.ts`).
  `npx tsx packages/server/src/loadtest/leisure.ts --days 2 [--ages 6-90]` places a park, a cinema and a library
  in a test city and prints arrivals by venue type and hour, the mean leisure need and happiness reasons.
- *Money.* Wages, income tax (to the work parcel), property tax (to the home
  parcel), sales tax (to the venue parcel), road upkeep, civic upkeep and public
  payroll (police, fire, hospital and builders are paid by the parcel that
  hosts them; public services' wages are half grant-funded, `ECONOMY_TUNING.civicPayroll`
  in `shared/src/tuning.ts`). The treasury chip shows yesterday's running balance and, on
  click, the ledger: income and spending by category for yesterday and today in two groups, each with its
  total: **running** (taxes, fees, wages, upkeep, utility bills and fuel, interest, funeral fees, billboard rent)
  and **one-off** (construction, builders' fees, land, technology, advert campaigns, fire damage, charter grants
  and rewards), then the net and the **daily running balance**, which says whether the town pays for itself
  (`shared/src/protocol.ts` `LEDGER_GROUP`, `client/src/finance.ts`). Sent
  with the players message once a game hour (`PlayerDTO.ledger`). High taxes make workers quit and residents leave; nearby staffed
  services raise what people will put up with.
- *The first five minutes* (`docs/first-five.md`, `server/src/sim/firstfive.ts`, `shared/src/buildings/camp.ts`,
  `client/src/moment.ts`). A new player's third act is to pitch a **pioneer camp** ($150, 2×2, tents and caravans
  round a fire that glows from dusk): it opens at once and eight settlers come up the road within the game hour
  (through a gateway when there is one), the camera flies to meet the first of them for a few seconds, and the
  player's first builders' yard hires them on the spot and sends them to the nearest sites now rather than with
  tomorrow's shift. A first house is 20 units of work (levels 2 and 3 unchanged). Settlers move out of the tents into
  finished homes nearby over the following days and newcomers fill them behind; bulldozing the camp rehomes its people
  first. Numbers in `START_TUNING` (`shared/src/tuning.ts`).
- *Onboarding* (`shared/src/goals.ts`, `server/src/goals.ts`, `client/src/onboarding.ts`). A chain of 14 goals for the
  first two hours (claim a plot, a street, pitch camp, homes, your own builders' yard, 12 residents in homes, shops, 50 residents,
  Masonry, police and fire cover, a park, a day in the black, 250 residents, a bus line), measured server-side a few times a game
- *Settlement ranks* (`shared/src/ranks.ts`, `server/src/ranks.ts`, `client/src/ranks.ts`, `client/src/render/fireworks.ts`;
  docs/ranks.md). A town climbs Camp → Hamlet → Village → Town → City on needs measured on its own land (residents,
  jobs filled, shops, a park, police and fire cover, two-storey buildings, days in the black, pupils or a bus line).
  Each rank pays a charter grant ($2,500 to $10,000) and, on a frontier, grows the free charter by a ring of land
  (32 → 48 → 64 → 80 → 96 tiles a side; the holder buys beyond it only as a City, nobody else inside it). The rank
  chip beside the treasury shows the next rank's progress; its card (in the goals column, taking the goals card's
  place once the chain is done) lists the needs, the grant and a milestone feed (opened from the chip, its ×, Esc or a press elsewhere closes it), and each new milestone comes up in a
  ticker under the top bar. A rank-up gets a banner, fireworks over the town (every shell its own) and the camera
  pulling up to show the new land. Saved with the player (`Player.ranks`); older saves derive their rank on load
  without a grant. None in sandboxes; the showcase tour's "Settlement ranks" stop plays the celebration.
  `npx tsx packages/server/src/loadtest/ranks.ts` is the probe.
- *Money that can run out* (`server/src/sim/finance.ts`, numbers in `ECONOMY_TUNING`; docs/early-game-audit.md "After
  Audit #5"). A player may spend down to a **$5,000 overdraft** (`overdraftLimit`); a build, purchase, unlock or policy
  that would go further is refused with a toast naming the limit and what can still be spent (`World.spendable`,
  `World.shortOf`). Running costs can still take the treasury past it. Below zero, **2% interest a day** of the negative
  balance is charged at midnight (`overdraftInterestPerDay`, ledger line "Overdraft interest"). Three midnights in a row
  below zero (`adminAfterDays`, `Player.adminDays`) put the city into **administration** (`Player.admin`, both saved and
  optional): every build, buy, zone, road, track, unlock, policy and line intent is refused with "In administration: …"
  (bulldozing, parcel settings, build priorities and the recovery plan still work), and the regional grant is withdrawn,
  so the owner pays all of the civic payroll rather than `civicPayroll` (half). It ends at the first midnight with the
  treasury at zero or above. The **recovery plan**: *raise tax* puts every parcel of the player's below
  `recoveryTaxRate` (20%) up to it; *sell land back* returns every parcel holding no building, site, structure or civic
  kind (only roads and empty zoned lots) to the region at `landBuyback` (80%) of the land price, through the ledger's land
  line, its roads taken up and its tiles unclaimed; *mothball* closes police, fire and health services (and, from a
  building's panel, builders' yards): staff let go, no hiring, no upkeep, no payroll, no cover until reopened
  (`World.mothballed`, saved in the snapshot as doors). Hints: the deficit hint names the overdraft, an `overdraft`
  alert at the first midnight below zero names the three levers, an `admin` alert on entry. Sandboxes never enter
  administration and the Commons pays no interest. `npm run finance:check` drives all of it over a fake client.
  hour from the player's parcels and progress counters, one active at a time with the next two previewed, each paying a
  modest reward (cash through the ledger, or Commercial zoning free). The card sits beside the tool bar with progress
  bars and a "show me" (picks the tool, flashes its button, opens the panel, looks at the plot); the `goals` chip in
  the top bar hides it, and "skip the tutorial" is saved with the player (`Player.onboarding`, absent in older saves;
  goals a returning player has already met are marked done without a reward). Advisor hints (`HINTS`) come as a strip
  under the card, at most one per two game hours, never again once "got it" is pressed: the server sends builders,
  deficit, overdraft, administration, jam, boredom and newcomers hints (messages `goals` and `hint`), the client raises night and empty-treasury
  ones. The tech chip pulses with the node's name when one becomes ready and affordable. Test cities and demos get none.
- *Fires* (`server/src/sim/fires.ts`, `shared/src/fires.ts`, `client/src/render/fires.ts`; docs/incidents.md). Hash-seeded
  hourly rolls per home and works weighted by density, age and cover; the nearest staffed fire building in reach sends a
  priority engine (stopped by traffic, it drives down the crown of the road); the share burnt when it parks sets the levels
  lost and the bill (ledger `fire`); unattended it burns out. A player's first fire is a warning that always survives, and
  ordinary fires wait a day after it. Issue code 7 (**on fire**) is set at once and outranks the rest.
- *Problems and overlays* (`server/src/sim/issues.ts`, `shared/src/issues.ts`, `client/src/render/issues.ts`,
  `client/src/problems.ts`, `client/src/overlays.ts`; docs/audit-2026-10.md 4.4). Every building and zoned lot is looked at
  every quarter of a game hour, a hashed slice each tick, and gets one code: **no road** (a lot no road and no frontage
  neighbour of its zone reaches, or a building with none at its door), **no builders** (a site nobody worked for an hour
  while builders were at work elsewhere; sites wait out the night), **unstaffed** (a civic building or staffed venue
  with staff at work or on the way under half of what its roster expects at that hour, for an hour; it clears when
  enough turn up, when new hires fill half the places or when the road joined to its door changes, and the crew then
  has a day to turn up), **no customers** (a shop or staffed venue standing all of yesterday with nobody yesterday or
  yet today; it clears with the first customer, or when the road joined to its door changes, for a fresh day),
  **parking full** (drivers it turned away who found no lot within ten tiles and parked at the kerb, a count halving
  every 12 game hours; it clears at once when parking in reach grows) and **very unhappy** (a home whose residents'
  mean happiness is under 35, until it is over 45). When several hold, that order decides which shows. Thresholds are
  `ISSUE_TUNING` in `shared/src/tuning.ts`; nothing is saved, so a restart recomputes them. The Commons' own buildings
  get no badges outside sandboxes. A badge is an instanced billboard over the roof (one draw call, its own bob and size
  by hash), fading out past the name boards' distance and hidden in the map, underground and first-person views. The
  zoning "no road" toast stays; the builders hint now comes at most once in three game days, since the badges show
  waiting sites all the time.

Hover any building for its live stats: residents and where they work,
staff on shift or commuting, shift patterns, customers, construction progress,
payroll, upkeep and parking. Hover a road for its congestion, cars, speed and
junction control. Hover a person or a car for their name, job, shift, where
they are going, whether they are held up and where their car is; click to pin
them in a panel and follow them.

**Networking** (`server/src/net.ts`). Clients subscribe to the chunks around their
camera and receive full chunk snapshots on subscribe, then only tile deltas and
moving citizens for those chunks. Agent frames carry only what changed since the
last tick (a quad in the Home state removes an agent), and a subscribe sends the
chunk's current agents. Congestion and lot occupancy go out as one byte per tile
per chunk every two seconds. Per-client bandwidth therefore depends on what they
look at, not on how big the world is. Parcels and players are small and
broadcast to everyone for now; `PlayerDTO.fin` (the overdraft, the count of midnights, administration and what each
recovery action would raise) rides on the players message only while it applies. The recovery plan is one client
message, `{ t: 'recover', action: 'tax' | 'sell' | 'mothball' | 'unmothball', keys?: ["x,y", …] }` (keys: those
buildings' doors only). On a dev server `{ t: 'dev', action: 'money', amount }` grants (or, negative, takes away)
money, for economy runs from a lower start. Issue codes (`issues`, a byte per tile per chunk, sent on subscribe and when a chunk's
codes change) ride beside them; your own problems come as flat `x, y, code` triples (`problems`, at most every half game
hour when they change), and the overlay you asked for (`{ t: 'overlay', ch }`) as a byte per tile per subscribed chunk
(`overlay`), refreshed every half game hour with only the chunks that changed. Fires burning, being put out or in their
aftermath go to everyone as one short list (`fires`) whenever it changes; the client animates them from the clock.

**Client rendering** (`client/src/render/`).

- *Ground.* One mesh per chunk, UV-mapped into a procedurally drawn atlas
  (`atlas.ts`): grass, water, sand, pavement, zone markers, dirt, and 16 road
  tiles auto-selected from each tile's N/E/S/W neighbours, which is how a road
  looks from far off. Chunk edges re-tile when a neighbour arrives.
- *Streets.* Within about 75 tiles of the camera every road tile is geometry
  (`roads.ts`, `roadGeo.ts`, one mesh per chunk in the ground's material, so
  lamp pools, overlays and the underground fade come with it). Pavements stand
  behind a kerb with a granite top and a gutter. Corners are rounded where roads
  meet and round the outside of bends, and every junction mouth has dropped kerbs
  with tactile paving. Verges lie beside gardens and open grass. The paint
  follows the layout and the lights (`shared/src/roadlook.ts`): centre lines that
  turn to warning lines before a junction, stop lines and turn arrows at lights,
  give-way lines and triangles where the side road or the shorter road gives way,
  signal crossings, zebras with flashing Belisha beacons (at a third of quiet
  junction mouths and mid-block on quiet straights), and yellow boxes on busy
  crossroads. Roundabout rings, level crossings and the road under a flyover
  have their own shapes. Lamp columns of three designs, street trees (species,
  size and lean per tree), bollards, bins and name-plate posts are instanced
  across the near chunks. Patches, manholes, gullies and wheel-track wear vary
  per tile, and wear follows the traffic a street carries. Street lamps are
  placed for every loaded chunk into a lamp map (one texel a tile) that the
  ground shader pools light from, and each lantern glows from the same bytes.
  The cross-section is a profile (carriageway width, lanes, a central
  reservation, one-way) ready for road classes; `msc.roads.preview(profile)`
  draws every street with another one.
- *Buildings.* Low-poly models built from boxes, prisms and cylinders with
  baked vertex colours (`kit.ts`, `models.ts`): four designs per kind and
  level, chosen per tile by hash, so a street mixes cottages, bungalows and
  L-shaped houses, cafés, diners and corner stores, silos, refineries and
  container yards, ziggurats, twin towers and glass slabs. A construction site
  raises the shell of the design that will stand there. Facades take a subtle
  per-kind tint on top. Every building in every loaded
  chunk is an instance in a single `BatchedMesh` (`buildings.ts`), so the whole
  city is one draw call. Buildings face the nearest road. Sites show the new
  building rising with progress under a crane tinted by priority.
- *Detail by distance.* Buildings draw in three tiers by distance from the camera (`buildings.ts`). Past about
  120 tiles (each building at its own hashed threshold, with hysteresis) a building swaps to a far model built
  from the same recipe without its small parts and with plain walls (`models.ts` `farOps`), roughly halving the
  city's building triangles in a zoomed-out view. Within about 37 tiles a chunk gets name boards (`signs.ts`):
  shops, offices, works, venues and civic buildings carry a name (`shared/src/names.ts`) on a fascia over the
  ground floor, homes a street number over the door, all drawn once into one canvas atlas; each board fades in
  by its own distance and shop and venue boards light up at night. `msc.buildings.setLod(false)` turns the
  tiers off for comparison.
- *Windows by day.* The same shader draws glazing at every hour on the lit-window grid: dark panes in a
  frame and sill a little lighter than the wall, reflecting the hour's sky with a Fresnel term, each window
  with its own curtains, blinds or open sash. The window class sets the layout: small sashes on homes, full
  height shopfronts under a signboard, curtain-wall bands with mullions and spandrels on glass offices,
  arched civic windows, tall venue windows and clerestory strips only on factories. Detail fades to the class
  average once a cell is a few pixels, and unlit panes at night stay dark glass (`materials.ts`; `Kit.add`
  gives every part an `aTop` height so a factory can find its eaves).
- *Lighting.* A sun that follows the in-game clock (click the clock chip to
  freeze it), filmic tone mapping, soft shadows from a camera-following shadow
  frustum, a blue hour between sunset and night, and a window shader in which
  every window keeps its own hours: homes light up as people get in and go dark
  at bedtime, shops close through the evening, offices empty early with a few
  cleaners left, hospitals and stations stay lit, factories run night shifts,
  TVs flicker, early risers switch on before dawn. Street lamps pool light
  along roads from their columns, sodium-warm or LED-white by street, each coming
  on at its own moment, a few dead or sputtering (`roads.ts`, `materials.ts`,
  `lighting.ts`). Shadow quality adapts to frame time; `?fx=0|1|2`
  pins it.

  **Standing rule: every effect gets an organic distribution.** Nothing in the
  city switches in lockstep. Seed per-instance offsets from a hash and vary
  onset, intensity and duration rather than using one global threshold.
- *People and vehicles.* Capsule-and-head pedestrians with a walking bob on
  the sidewalk side, sedans, emergency vans with light bars and builders'
  flatbeds in the right-hand lane, all instanced and interpolated between
  server ticks (`citizens.ts`).
- Chunk views are created and disposed as the subscription set changes while
  you pan, so you can scroll indefinitely in any direction.

## Why TypeScript on the server

At the scale of a few hundred players the bottleneck is the citizen simulation
and update fan-out, not player input. Sharing the protocol, tile codec and terrain
generator between client and server removes a whole class of desync bugs, and a
single Node process handles hundreds of connections and tens of thousands of
citizens at this tick rate. What gets the world to "unlimited" is the chunked
design: the next step is running regions of chunks in separate processes behind
a gateway. The simulation is isolated from networking and storage precisely so a
hot shard could later be rewritten in Go or Rust without the client noticing.

## Roadmap

- Accounts: sign-in with Hanko (or the dev sign-in) has landed for the live world (`docs/accounts.md`); in-game account
  settings, parcel protection, rate limits and admin tools are still to come (the remaining list is in that doc).
- Region sharding: one simulation process per block of chunks, a gateway that
  routes subscriptions, and citizen hand-off between shards.
- Database-backed store (Postgres for parcels/players, chunk blobs in object
  storage or Redis) replacing the JSON snapshot in `data/world.json`.
- Binary wire format (the protocol is already flat numeric arrays for the hot
  messages, so this is mechanical).
- Selling parcels and a market land value (subdividing and combining are on the world map), utilities, avenues and transit,
  and a proper economy loop for commercial/industrial income.
- Frustum-based subscriptions instead of a radius (far out, the world map takes over: docs/world-map.md).
- Griefing controls: public roads can currently be bulldozed by anyone.

## Licence and contributing

Copyright (C) 2026 Rich Green.

Civitas is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public
License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; see `LICENSE` for details.

In short: you may use, change and host Civitas, but if you run a modified version as a network service, you must offer
its source code to the players who use it. The official multiplayer servers are run by the project.

Contributions, especially new buildings and landmarks, are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the ten-minute
building workflow, the one-hour landmark workflow and the terms contributions are made under. "Civitas" is the project's name; please rename forks you
publish or host. The community page is the subreddit [r/civitas_game](https://www.reddit.com/r/civitas_game/).
