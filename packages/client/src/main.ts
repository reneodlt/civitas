import { JunctionTools, isJunctionTool } from './junctiontools';
import { junctionArmAt, nextArmState, armState, JAM_WHY_STRIDE, VehicleClass } from '@msimcity/shared';
import { type Material, WebGLRenderer, Scene, Mesh, PlaneGeometry, MeshBasicMaterial, Fog, PCFSoftShadowMap, ACESFilmicToneMapping, Quaternion, Vector3 } from 'three';
import {
  OVERLAY_TEXT, ZONE_TOOLS, CHUNK_SIZE, LAND_PRICE_PER_TILE, spendableMoney, TICKS_PER_DAY, TICK_MS, Terrain, KIND_NAMES, Zone, isCivicId, stopModeOf, kindIdOf, kindManifest, hasFeature,
  terrainOf, isRoad, zoneOf, isDemoId, DEMO_BY_ID, demoLandmarkSpans, levelOf, underConstruction, checkPurchase, planStructure, FRONT_NAMES, planRunway, isAirfieldAux, isRailAux, hash2, planPlatform, isMetroStationKind, classDef, auxClass, AD_RENTAL, lineSides, underMask, type StationStop, trainCrew, flightManifest, flightPassengers, TRAIN_VMAX, type Flight, type FlightManifest, type TrainInfo, type PlaceVerdict, type Placed, type RunwayPlan, type LandRect, chunkKey, parseKey, localIndex, type Tool, type BuildingInfo, type CitizenInfo, type MetroLineDTO, type FerryLineDTO, type BoatInfo, channelName,
} from '@msimcity/shared';
import { NetClient } from './net';
import { LocalGame, AUTOJOIN } from './local/client';
import { mountLocalUi, localLogin, addPlayOffline, registerServiceWorker } from './local/ui';
import { FinancePanel } from './finance';
import { ClientWorld } from './world';
import { CameraRig, parseShot, urlShot, type CameraShot } from './camera';
import { ChunkView } from './render/chunkView';
import { ChunkWork } from './render/chunkWork';
import { DIRTY_CAUSES, DIRTY_SHAPE, DIRTY_BUILD, DIRTY_UNDER } from './world';
import { ParcelsView } from './render/parcels';
import { EduHeat } from './render/eduHeat';
import { CitizensView } from './render/citizens';
import { ParkedCars } from './render/parkedCars';
import { TrafficLights } from './render/signals';
import { ParksView } from './render/parks';
import { PlanesView } from './render/planes';
import { HelicoptersView } from './render/helicopters';
import { BoatsView, FERRY_ID_BASE } from './render/boats';
import { HarbourMock } from './render/boatsMock';
import { boatTipHtml, boatPanelHtml, boatCab, boatKnots } from './boatPanel';
import { AirfieldView } from './render/airfield';
import { TrainsView } from './render/trains';
import { RailClient, trainHtml, setPlatformCrowd } from './rail';
import { RoadTool } from './roadtool';
import { RoadClassPicker } from './roadpicker';
import { StreetRuleTool, StreetRulePicker } from './streetrules';
import { TrafficPanel } from './trafficpanel';
import { RouteView } from './render/route';
import { JunctionView } from './render/junctions';
import { BridgeView, setLandmarkSpans } from './render/bridges';
import { RoadLayer } from './render/roads';
import { LandmarkMotion } from './render/landmarks';
import { UndergroundView } from './render/underground';
import { FootprintOverlay } from './render/footprint';
import { Fpv, type CabEye } from './render/fpv';
import { SeatEyes } from './passengerSeat';
import { vehicleKey, trainPanelHtml, trainKmh, planePanelHtml, planeTipHtml, planeDoing, planeKnots, planeFeet, heliTipHtml, heliPanelHtml, heliDoing, heliTitle, heliKnots, type VehicleSel } from './vehicles';
import { Buildings } from './render/buildings';
import { variant, allVariants } from './render/models';
import { columnHeights } from './pick';
import { applyToolCursor, applyPickHint } from './cursors';
import { Lighting } from './render/lighting';
import { buildAtlas } from './render/atlas';
import { buildingMaterial, groundMaterial as makeGroundMaterial, sceneUniforms } from './render/materials';
import { Input, DEV_TOOLS, structureTool, type Rect, type ToolId } from './input';
import { UI } from './ui';
import { ContextMenu } from './contextmenu';
import { Onboarding } from './onboarding';
import { Reveal, readPref, writePref } from './reveal';
import { GOAL_BY_ID } from '@msimcity/shared';
import { CameraMoment } from './moment';
import { RanksUI } from './ranks';
import { NewsUI, news } from './news';
import { PowerClient } from './utilities';
import { TvGuide } from './render/tv';
import { setTvSource, tvDebug } from './render/interiors';
import { Fireworks } from './render/fireworks';
import { LinesPanel } from './lines';
import { ChartsPanel } from './charts';
import { PolicyPanel } from './policies';
import { AdPanel } from './adverts';
import { PerfHud } from './render/perfhud';
import { Audio, AudioReadout, type RideNow } from './audio';
import { bindReadoutKey } from './audio/controls';
import { WorldPicker, startCity, showCityBanner, reviveCity, testCityOf, cityWsHost, remembered, serverConfig } from './worlds';
import { apiBase } from './serverApi';
import { demoOf, demoWsUrl, startDemo, reviveDemo, showDemoBanner, TourPanel, type DemoInfo } from './tour';
import { MapMode } from './mapmode';
import { IssuesView } from './render/issues';
import { FiresView } from './render/fires';
import { GravesView } from './render/graves';
import { OverlayMap } from './render/overlayMap';
import { ProblemsPanel, issueTipHtml } from './problems';
import { OverlayMenu } from './overlays';
import { SignIn } from './auth';

// ---- renderer & scene ---------------------------------------------------------------------
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new Scene();
scene.fog = new Fog(0x9fc4e8, 120, 420);
const lighting = new Lighting(scene);
const rig = new CameraRig(1);
const world = new ClientWorld();

const atlas = buildAtlas();
atlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
const groundMaterial = makeGroundMaterial(atlas);
const buildings = new Buildings(buildingMaterial());
const views = new Map<string, ChunkView>();
/**
 * Chunk rebuilds (render/chunkWork.ts, docs/perf.md): one chunk at a time, the most urgent first, its passes within a
 * time box a frame, and only the passes that read what changed (world.ts DIRTY_*). The closures run at frame time.
 */
const SB = DIRTY_SHAPE | DIRTY_BUILD;
const chunkWork = new ChunkWork(world, [
  { name: 'view', reads: SB, run: (k, c) => views.get(k)!.rebuild(c, k, getTile, buildings, auxAt) },
  { name: 'roads', reads: SB, run: (k, c) => roads.scanChunk(k, c, getTile, auxAt) }, // streets read the lots beside them (leafy sides, motorway aprons)
  { name: 'lights', reads: DIRTY_SHAPE, run: (k, c) => lights.scanChunk(k, c, getTile, auxAt) },
  { name: 'parks', reads: SB, run: (k, c) => parks.scanChunk(k, c, getTile) },
  { name: 'airfield', reads: SB, run: (k, c) => airfield.scanChunk(k, c, world) },
  { name: 'helis', reads: SB, run: (k, c) => helis.scanChunk(k, c, world) },
  { name: 'boats', reads: SB, run: (k, c) => boatMock?.scanChunk(k, c) },
  { name: 'trains', reads: DIRTY_SHAPE, run: (k, c) => trains.scanChunk(k, c) },
  { name: 'junctions', reads: DIRTY_SHAPE, run: (k, c) => junctions.scanChunk(k, c) },
  { name: 'bridges', reads: DIRTY_SHAPE, run: (k, c) => bridges.scanChunk(k, c) },
  { name: 'landmarks', reads: SB, run: (k, c) => landmarks.scanChunk(k, c, getTile) },
  { name: 'underground', reads: DIRTY_SHAPE | DIRTY_UNDER, run: (k, c) => underground.scanChunk(k, c) },
  { name: 'power', reads: SB, run: (k, c) => power.scanChunk(k, c) },
], (k) => views.has(k), (k) => buildings.countOf(k));
/** ?chunkwork=legacy: the old invalidation and rebuild loop from the first frame (paired warm-up measurements, docs/perf.md) */
const LEGACY_CHUNKS = new URLSearchParams(location.search).get('chunkwork') === 'legacy';
chunkWork.legacy = world.legacyDirty = LEGACY_CHUNKS;
const parcelsView = new ParcelsView();
const citizens = new CitizensView();
const lights = new TrafficLights();
const routeView = new RouteView();
scene.add(buildings.mesh, parcelsView.group, citizens.group, lights.group, routeView.group);
const parked = new ParkedCars(world); scene.add(parked.group);
const parks = new ParksView(); // trees and benches inside park tiles
scene.add(parks.group);
// issue bubbles over stuck buildings and lots, and the data overlays' map (render/issues.ts, render/overlayMap.ts, docs/audit-2026-10.md 4.4)
const issuesView = new IssuesView(world);
scene.add(issuesView.group);
const firesView = new FiresView(world); // house fires (render/fires.ts): flames, smoke, glow and scorch
scene.add(firesView.group);
const gravesView = new GravesView(world); // headstones, plaques and funerals under way (render/graves.ts, docs/remembrance.md)
scene.add(gravesView.group);
const overlayMap = new OverlayMap();

const hoverMesh = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
hoverMesh.visible = false;
const rectMesh = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0x62d2a2, transparent: true, opacity: 0.35, depthWrite: false }));
rectMesh.visible = false;
scene.add(hoverMesh, rectMesh);
const footprint = new FootprintOverlay(); // outline, door arrow and marks of the structure being placed or hovered
scene.add(footprint.group);

const sized = { w: 0, h: 0 };
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return; // not laid out yet (the stylesheet still loading): the frame loop tries again
  sized.w = w; sized.h = h;
  renderer.setSize(w, h, false);
  rig.resize(w / h);
}
window.addEventListener('resize', resize);
resize();

// ---- url params: ?name= skips login, ?at=x,y&dist=n&yaw=deg&pitch=deg places the camera (camera.ts CameraShot), ?hour=h freezes lighting ---
const params = new URLSearchParams(location.search);
let startShot: CameraShot | null = urlShot(params);
if (startShot) rig.setShot(startShot);
if (params.get('hour')) { lighting.mode = 'fixed'; lighting.fixedHour = Number(params.get('hour')); }
// ?fx=0|1|2 pins shadow quality; otherwise it adapts to frame time
const fxParam = params.get('fx');
if (fxParam !== null) lighting.setQuality(Number(fxParam));
// ?anim=0|1|2 pins the leisure places' moving parts (render/leisureAnims.ts: 0 frozen, 1 half rate, 2 all); otherwise they adapt to frame time
if (params.get('anim') !== null) buildings.anims.pin(Number(params.get('anim')));
let frameAvg = 16, qualityTimer = 0;
function adaptQuality(dt: number) {
  if (fxParam !== null) return;
  frameAvg += (dt * 1000 - frameAvg) * 0.05;
  qualityTimer += dt;
  if (qualityTimer < 2) return;
  qualityTimer = 0;
  if (frameAvg > 50 && lighting.quality > 0) lighting.setQuality(lighting.quality - 1);
  else if (frameAvg < 18 && lighting.quality < 2) lighting.setQuality(lighting.quality + 1);
}

// ---- networking ---------------------------------------------------------------------------
// a public showcase (docs/demo.md "A public showcase"): the server says whether it is read-only (SPECTATE) and which demo a bare
// page opens (DEFAULT_DEMO); asked before anything connects. A local game or a ?ws= server elsewhere has no such answer.
const showcase = __LOCAL_ONLY__ || params.has('local') || params.get('ws') ? {} : await serverConfig();
if (showcase.spectate) document.body.classList.add('spectate'); // no tool bar flashing up before the welcome confirms it
// a showcase with a default demo shows only its allowed demos (the default and the warmed and kept cities: the server refuses to start the others):
// ?demo=<other> opens the default like a bare page
if (showcase.spectate && isDemoId(showcase.defaultDemo) && params.get('demo') && demoOf(params) !== showcase.defaultDemo && !(showcase.demos ?? []).includes(demoOf(params) ?? '')) {
  params.delete('demo');
  history.replaceState(null, '', `${location.pathname}?${params.size ? params : 'go'}${location.hash}`); // never an empty query: that is the home page
}
// DEFAULT_VIEW: the opening shot of a bare page (no camera parameters, no ?demo=, ?city=: the world DEFAULT_DEMO or the live one), its hour
// only when there is no ?hour; put on again at the first welcome, after a demo's tour has placed the camera on its welcome stop
if (!startShot && !params.get('demo') && !params.get('city')) {
  startShot = parseShot(showcase.defaultView);
  if (startShot) rig.setShot(startShot);
  if (startShot?.hour !== undefined && !params.get('hour')) { lighting.mode = 'fixed'; lighting.fixedHour = startShot.hour; }
}
const defaultDemo = !params.get('demo') && !params.get('city') && isDemoId(showcase.defaultDemo) ? showcase.defaultDemo : null;
// a demo map (?demo=<id>, tour.ts) is reached through this server's /demo-ws/<id>, which pipes to the demo's process
const demoParam = demoOf(params) ?? defaultDemo;
/** the guided tour, in a demo */
let tour: TourPanel | null = null;
const wsUrl = params.get('ws') ? `ws://${params.get('ws')}` : demoParam ? demoWsUrl(demoParam) : (import.meta.env.VITE_WS_URL
  ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.port === '5173' ? `${location.hostname}:8080` : location.host}`);
/** local mode (docs/local-mode.md): the game runs in a worker in this tab and saves to IndexedDB; ?local, or always in the static build */
const local = __LOCAL_ONLY__ || params.has('local') ? new LocalGame({ devTools: params.has('dev') }) : null;
const net = local ? new NetClient(() => local.socket()) : new NetClient(wsUrl);
let selectedParcel = 0;
/** tile of the building whose people panel is open, if any */
let selectedBuilding: [number, number] | null = null;
let panelShown = 0;
let onlineCount = 0;
/** the game clock as of the last stats message; `rate` is game ticks per TICK_MS (0 while a local game is paused, 2 or 4 fast) */
const clock = { day: 0, frac: 0.5, at: performance.now(), rate: 1 };
/** game days since the last stats message */
const sinceStats = () => ((performance.now() - clock.at) * clock.rate) / (TICKS_PER_DAY * TICK_MS);
const liveHour = () => ((clock.frac + sinceStats()) % 1) * 24;
/** The server's tick as of now, interpolated from the last stats message (signal phases are a pure function of it). */
const liveTick = () => Math.floor((clock.day + clock.frac + sinceStats()) * TICKS_PER_DAY);
/** the same, fractional, for smooth interpolation of planes */
const liveTickF = () => (clock.day + clock.frac + sinceStats()) * TICKS_PER_DAY;
// planes fly from every operational airport in the loaded chunks (render/airfield.ts derives them from tiles);
// ?airport=x,y,dir[,gates[,flightsPerHour]] adds a preview at a placeholder airfield on open land (dir 0 E, 1 W, 2 S, 3 N)
const planes = new PlanesView();
const airfield = new AirfieldView();
scene.add(planes.group, airfield.group);
// helicopters fly between the helipads on the buildings in the loaded chunks (render/helicopters.ts, shared/src/helicopters.ts)
const helis = new HelicoptersView();
scene.add(helis.group);
// boats sail the harbours the server sends (render/boats.ts, shared/src/boats.ts); with ?dev a mock list is derived from the loaded tiles until it does
const boats = new BoatsView();
scene.add(boats.group);
const boatMock = DEV_TOOLS ? new HarbourMock() : null;
// trains run every line the server sends (render/trains.ts); the track tool's preview and tooltips (client/src/rail.ts)
const trains = new TrainsView();
const rail = new RailClient(world);
scene.add(trains.group, trains.under, rail.group);
trains.underAt = (x, y) => world.underAt(x, y); // tube trains follow a crossover's dip
scene.add(citizens.under);
setPlatformCrowd((x0, y0, x1, y1) => citizens.platformCrowd(x0, y0, x1, y1));
citizens.platformAlongX = (x, y) => underMask(world.underAt(x, y)) === 10; // a platform tile's axis (docs/underground.md section 1)
const junctions = new JunctionView(world); junctions.legacySigns = LEGACY_CHUNKS; scene.add(junctions.group); // roundabout islands, flyover decks and ramps
const junctionTools = new JunctionTools(world); // the junction tools' ghost, cost and reasons (R4)
// utilities (utilities.ts, docs/utilities.md): reach from the tiles, the hourly node states, blackouts, the power overlay, pylons
const power = new PowerClient(world, (k) => views.get(k)); scene.add(power.group);
buildings.rotors.output = (x, y) => power.plantOutput(x, y); buildings.rotors.told = () => power.hour >= 0; // the wind turbines turn while their plant generates (render/rotors.ts)
const roadTool = new RoadTool(world, DEV_TOOLS); scene.add(roadTool.group); // the road drag's ghost, cost chip, spacing guide and question (roadtool.ts)
// the Street rules tool's ghost over the street, its chip and the HGV ban's probe (streetrules.ts, R5)
const streetRules = new StreetRuleTool(world, DEV_TOOLS, {
  send: (rule, tiles, on) => net.send({ t: 'streetRule', rule, tiles, on, ...(DEV_TOOLS ? { dev: true } : {}) }),
  probe: (rule, tiles, seq) => net.send({ t: 'ruleProbe', rule, tiles, seq }),
  undo: () => net.send({ t: 'undoStreetRule' }),
});
scene.add(streetRules.group);
const bridges = new BridgeView(world); scene.add(bridges.group); // bridge decks, piers, towers and ramps (render/bridges.ts)
// roads near the camera as geometry, their furniture and the street lamps' map (render/roads.ts)
const roads = new RoadLayer(atlas); scene.add(roads.group, roads.furniture);
ChunkView.onTint = (cx, cy, heat) => roads.setHeat(cx, cy, heat, !roadsOverlay && !power.overlayOn); // the overlays' bytes wear nothing
roads.kindAt = (x, y) => world.kindIdAt(x, y);
roads.rules = world; lights.world = world; // signal crossings and their walk phases (R4)
citizens.roadY = (x, z, hx, hz) => (junctions.roadY(x, z, hx, hz) || bridges.roadY(x, z, hx, hz) || roads.walkY(x, z)) + roads.humpY(x, z); // cars and walkers on a flyover deck or a bridge and their ramps, walkers on a kerbed pavement
const landmarks = new LandmarkMotion(); scene.add(landmarks.group); // the London Eye turning, Big Ben's dials (render/landmarks.ts)
landmarks.auxAt = (x, y) => world.auxAt(x, y); // a Tower Bridge span running on into the next chunk
landmarks.bargeHidden = (seed, day) => boats.liftBooked(seed, day); // real boats booked into a span's lifts replace its decorative barge
// the underground view (N, the "underground" chip): tunnels and platforms from the under layer, street grates, the platform preview (render/underground.ts)
const underground = new UndergroundView(world);
scene.add(underground.group);
underground.surface = [citizens.group, parked.group, parks.group, junctions.group, bridges.group, lights.group, landmarks.group, trains.group, airfield.group, helis.group, boats.group, buildings.mesh, roads.furniture];
underground.buildings = buildings.mesh;
underground.shaderMaterials = [groundMaterial, buildings.mesh.material as Material, roads.material];
const airportParam = params.get('airport')?.split(',').map(Number);
if (airportParam && airportParam.length >= 3 && airportParam.every((n) => Number.isFinite(n))) {
  planes.setPreviews([{ id: 1, x: airportParam[0], y: airportParam[1], dir: (airportParam[2] & 3) as 0 | 1 | 2 | 3, gates: airportParam[3] || 3, runwayLen: 12, flightsPerHour: airportParam[4] || 2 }]);
}
/** Does this junction tile's parcel owner have the Traffic signals technology? */
const signalled = (x: number, y: number) => {
  const p = world.parcelAt(x, y);
  const owner = p && world.players.get(p.owner);
  return !!owner && hasFeature(owner.tech, 'signals');
};

let selectedCitizen = 0;
let following = false;
/** the selected train or plane (vehicles.ts); exclusive with selectedCitizen */
let selectedVehicle: VehicleSel | null = null;
/** the server's last answer about the selected boat (a trawler's crew of citizens, what it landed) */
let boatInfo: BoatInfo | null = null;
/** the server's last full answer about the selected train */
let trainInfo: TrainInfo | null = null;
const ui = new UI({
  onTool: (t) => input.setTool(t),
  onTax: (id, taxRate) => net.send({ t: 'parcel', id, taxRate }),
  onRename: (id, name) => net.send({ t: 'parcel', id, name }),
  onPriority: (x, y, priority) => net.send({ t: 'priority', x, y, priority }),
  onFocus: (x, y) => { following = false; rig.target.set(x + 0.5, 0, y + 0.5); rig.dist = Math.min(rig.dist, 30); },
  onUnlock: (id) => net.send({ t: 'unlock', id }),
  onFollow: (_id, on) => setFollow(on),
  onDeselectCitizen: () => (selectedVehicle ? selectVehicle(null) : selectCitizen(0)),
  onSelectCitizen: (id) => selectCitizen(id),
  onSelectSeat: (seatLabel, who) => selectSeat(seatLabel, who),
  onFpv: (mode) => { if (mode === 'inset') fpv.toggleInset(); else fpv.toggleFull(); },
  onCloseBuilding: () => closeBuilding(),
  onCloseParcel: () => closeParcel(),
});
// the road tool's class picker (roadpicker.ts), hung off the road button and the 3 key
ui.roadPicker = new RoadClassPicker({
  picked: () => roadTool.picked,
  lockOf: (cls) => roadTool.lockOf(cls),
  pick: (cls) => { roadTool.pick(cls); ui.roadClassChanged(); updateStatus(); },
  locked: (msg) => ui.toast('error', msg),
});
// the Street rules tool's picker (streetrules.ts), hung off its button
ui.rulePicker = new StreetRulePicker({
  picked: () => streetRules.rule,
  lockOf: (r) => streetRules.lockOf(r),
  pick: (r) => { streetRules.pick(r); ui.ruleChanged(); updateStatus(); },
  locked: (msg) => ui.toast('error', msg),
});
ui.ruleName = () => streetRules.def.title;
ui.ruleChanged();
net.on('ruleProbe', (m) => streetRules.probed(m));
ui.roadClassName = () => (roadTool.roadClass ? classDef(roadTool.roadClass).title : '');
ui.roadClassCost = () => classDef(roadTool.roadClass).cost;
ui.roadClassChanged();

net.onStatus = (ok) => { ui.setConn(ok); if (!ok) subscribed.clear(); };
net.on('welcome', (m) => {
  buildings.rotors.seed = m.seed;
  world.me = m.you;
  world.sandbox = !!m.sandbox;
  // a read-only showcase (SPECTATE): only looking; the tool bar, the tech chip, Reset demo and the menu's changes go (style.css body.spectate)
  world.spectate = !!m.spectate;
  document.body.classList.toggle('spectate', world.spectate);
  input.readOnly = world.spectate;
  if (world.spectate) input.setTool('select');
  if (tour) tour.readOnly = world.spectate;
  world.applyPlayers(m.players);
  world.applyParcels(m.parcels);
  world.start = m.start === 'frontier' ? 'frontier' : 'commons'; world.home = m.home ?? null;
  const me = world.myPlayer!;
  ui.setWho(me.name, me.color);
  ui.setMoney(me.money, me.ledger, me.fin);
  ui.setLocks(me.tech);
  reveal.apply();
  policies.show(me);
  adPanel.show(me, onboarding.activeGoal === 'adverts');
  finance.show(me);
  ui.hideLogin();
  if (startShot) { rig.setShot(startShot); startShot = null; } // the opening shot, once
  for (const key of [...views.keys()]) dropView(key);
  subscribed.clear();
  streamChunks();
  if (world.overlayCh) net.send({ t: 'overlay', ch: world.overlayCh }); // a new connection starts with none
});
net.on('chunk', (m) => {
  const key = chunkKey(m.chunk.cx, m.chunk.cy);
  if (!subscribed.has(key)) return;
  world.putChunk(m.chunk);
  if (!views.has(key)) {
    const v = new ChunkView(m.chunk.cx, m.chunk.cy, groundMaterial);
    views.set(key, v);
    scene.add(v.group);
  }
});
net.on('aux', (m) => world.applyAux(m.u));
net.on('roadRules', (m) => { world.applyRoadRules(m.r); roads.invalidate(); lights.invalidate(); junctions.rulesChanged(); updateStatus(); });
net.on('walks', (m) => world.applyWalks(m.u));
net.on('sub', (m) => world.applySub(m.u));
net.on('under', (m) => world.applyUnder(m.u));
net.on('tiles', (m) => world.applyTiles(m.u));
net.on('parcels', (m) => { world.applyParcels(m.parcels, m.removed); lights.invalidate(); roads.invalidate(); refreshPanel(); mapMode.parcelsChanged(); eduDirty = true; });
net.on('players', (m) => {
  lights.invalidate(); roads.invalidate();
  world.applyPlayers(m.players);
  onlineCount = m.players.filter((p) => p.online).length;
  const me = world.myPlayer; if (me) { ui.setMoney(me.money, me.ledger, me.fin); ui.setLocks(me.tech); reveal.apply(); ui.showTech(me); policies.show(me); adPanel.show(me, onboarding.activeGoal === 'adverts'); finance.show(me); devPanel?.sync(!!me.devUnlimited); }
  world.parcelsDirty = true; refreshPanel(); mapMode.parcelsChanged();
});
net.on('citizens', (m) => citizens.update(m.c, performance.now()));
net.on('venues', (m) => buildings.anims.setGuests(m.v)); // who is at each leisure place: the moving parts follow the crowd
// bus lines (client/src/lines.ts): the lines chip and panel, ribbons while it is open, and each bus's livery
const lines = new LinesPanel(net, world, (kind, msg) => ui.toast(kind, msg), liveTick);
// city history charts (charts.ts, docs/charts.md): the charts chip, the ` key, and a click on the population or treasury figure
const charts = new ChartsPanel(net);
/** the education policies (policies.ts); opening it closes the tech tree, which sits in the same place */
const policies = new PolicyPanel(document.getElementById('policies')!, document.getElementById('policiesBtn')!, (id, on) => net.send({ t: 'setPolicy', id, on }), DEV_TOOLS);
ui.onOpenChart = (id) => charts.show(id);
/** money that can run out (finance.ts, server sim/finance.ts): the overdraft chip and the administration panel with the recovery plan */
const finance = new FinancePanel({
  el: document.getElementById('admin')!, btn: document.getElementById('adminBtn')!,
  send: (action) => net.send({ t: 'recover', action }), day: () => clock.day,
  restart: local ? () => local.restartFromAutosave().catch((e: Error) => ui.toast('error', e.message)) : undefined,
});
ui.onUtil = (x, y, what, on) => net.send({ t: 'utilNode', x, y, ...(what === 'protect' ? { protect: on } : { importOn: on }) });
ui.mineByName = (name) => world.myPlayer?.name === name;
ui.mayEditByName = (name) => !world.spectate && (world.sandbox || world.myPlayer?.name === name);
net.on('utilState', (m) => power.setState(m));
net.on('utilLinks', (m) => power.setLinks(m));
ui.onMothball = (x, y, on) => net.send({ t: 'recover', action: on ? 'mothball' : 'unmothball', keys: [`${x},${y}`] });
ui.onGatewayLimit = (x, y, on) => { net.send({ t: 'gatewayLimit', x, y, on }); setTimeout(() => { if (selectedBuilding) net.send({ t: 'inspect', x: selectedBuilding[0], y: selectedBuilding[1], full: true }); }, 300); };
charts.me = () => world.myPlayer;
lines.onLivery = (pairs, colours) => citizens.setLivery(pairs, colours);
lines.onEdit = () => input.setTool('select');
scene.add(lines.group);
net.on('lines', (m) => lines.apply(m));
net.on('lineStats', (m) => lines.applyStats(m));
net.on('traffic', (m) => world.applyTraffic(m.cx, m.cy, m.d, m.k));
// issue bubbles, your problems list and the data overlays (render/issues.ts, problems.ts, overlays.ts)
net.on('issues', (m) => world.applyIssues(m.cx, m.cy, m.d));
net.on('fires', (m) => firesView.set(m.f));
// death and remembrance (docs/remembrance.md): the graves and funerals; a headstone's panel
net.on('graves', (m) => gravesView.set(m.list));
net.on('deceased', (m) => { if (m.id === ui.deceasedFor || m.id === deceasedAsked) { deceasedAsked = 0; if (m.info) ui.showDeceased(m.info); else if (ui.deceasedFor === m.id) ui.hideCitizen(); } });
/** a headstone or a remembered name was opened: the citizen or vehicle panel gives way to the deceased's */
let deceasedAsked = 0;
function openDeceased(id: number) {
  if (selectedCitizen || selectedVehicle) selectCitizen(0);
  deceasedAsked = id;
  net.send({ t: 'inspectDeceased', id });
}
ui.onDeceased = (id) => openDeceased(id);
ui.onGoto = (x, y) => flyTo(x, y);
setInterval(() => { if (ui.deceasedFor && net.connected) net.send({ t: 'inspectDeceased', id: ui.deceasedFor }); }, 2000);
net.on('problems', (m) => problems.set(m.p, m.r));
net.on('overlay', (m) => world.applyOverlay(m.ch, m.cx, m.cy, m.d));
const problems = new ProblemsPanel({
  world,
  flyTo: (x, y) => flyTo(x, y),
  flash: (x, y) => issuesView.flash(x, y),
  select: (x, y) => selectTile(x, y, 'building'),
});
/**
 * The road classes overlay (overlays.ts 'roads'): every road tile's byte on the congestion path is its class's,
 * (class + 1) * 32, which the ground and road shaders colour by class (render/materials.ts HEAT, uHeatMode 2).
 */
let roadsOverlay = false, roadsOverlayFrames = 0;
function roadClassHeat(key: string): Uint8Array | undefined {
  const c = world.chunks.get(key);
  if (!c) return undefined;
  const out = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  for (let i = 0; i < out.length; i++) if (isRoad(c.tiles[i])) out[i] = (auxClass(c.aux[i]) + 1) * 32;
  return out;
}
function paintRoadClasses() { for (const [key, v] of views) { v.heat = roadClassHeat(key); v.tintRoads(); } }
// the Traffic panel (trafficpanel.ts, R5): asked for only while it is open
const trafficPanel = new TrafficPanel({
  ask: () => net.send({ t: 'trafficPanel' }),
  jump: (x, y) => { following = false; rig.target.set(x + 0.5, 0, y + 0.5); rig.dist = Math.min(rig.dist, 30); },
  limit: (x, y, on) => net.send({ t: 'gatewayLimit', x, y, on }),
});
net.on('trafficPanel', (m) => trafficPanel.show(m.info));
// the congestion overlay's explanation (R5): why each held-up road is slow, per chunk, asked for only while hovering with it on
const jamWhy = new Map<string, { at: number; u: number[] }>();
let jamAsked = '';
net.on('jamWhy', (m) => {
  jamWhy.set(`${m.cx},${m.cy}`, { at: performance.now(), u: m.u });
  jamAsked = '';
  if (tipTile && !tipAgent && Math.floor(tipTile[0] / CHUNK_SIZE) === m.cx && Math.floor(tipTile[1] / CHUNK_SIZE) === m.cy) net.send({ t: 'inspect', x: tipTile[0], y: tipTile[1] });
});
/** The overlay's why for road tile (x, y): the held cars by cause, and how many are lorries or visitors; asks again when stale. */
function whyAt(x: number, y: number): number[] | null {
  if (overlayMenu.mode !== 'traffic') return null;
  const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), k = `${cx},${cy}`, e = jamWhy.get(k), now = performance.now();
  if ((!e || now - e.at > 2000) && jamAsked !== k) { jamAsked = k; net.send({ t: 'jamWhy', cx, cy }); }
  if (!e) return null;
  for (let i = 0; i + JAM_WHY_STRIDE <= e.u.length; i += JAM_WHY_STRIDE) if (e.u[i] === x && e.u[i + 1] === y) return e.u.slice(i + 2, i + JAM_WHY_STRIDE);
  return [];
}
const overlayMenu = new OverlayMenu({
  trafficPanel: () => trafficPanel.toggle(),
  setTraffic: (on) => setHeat(on),
  setRoads: (on) => {
    const was = roadsOverlay;
    roadsOverlay = on;
    if (on) { sceneUniforms.uHeatMode.value = 2; paintRoadClasses(); }
    else if (was) { if (!power.overlayOn) sceneUniforms.uHeatMode.value = 0; for (const [key, v] of views) { v.heat = world.traffic.get(key); v.tintRoads(); } }
  },
  setPower: (on) => {
    const was = power.overlayOn;
    power.setOverlay(on);
    if (was && !on) for (const [key, v] of views) { v.heat = world.traffic.get(key); v.tintRoads(); } // the roads take the traffic bytes back
  },
  setChannel: (ch) => {
    if (ch === world.overlayCh) return;
    world.setOverlayChannel(ch);
    sceneUniforms.uOvl.value = ch ? 1 + (OVERLAY_TEXT[ch]?.ramp ?? 0) : 0;
    net.send({ t: 'overlay', ch });
  },
});
/** "show me": a short smooth flight to a tile (the tour's easing), close enough to see the badge */
let flight: { at: number; fx: number; fz: number; fd: number; tx: number; tz: number; td: number } | null = null;
function flyTo(x: number, y: number) {
  following = false;
  flight = { at: performance.now(), fx: rig.target.x, fz: rig.target.z, fd: rig.dist, tx: x + 0.5, tz: y + 0.5, td: Math.min(Math.max(rig.dist, 22), 45) };
}
function flyFrame(now: number) {
  if (!flight) return;
  const f = Math.min(1, (now - flight.at) / 1200), e = f * f * (3 - 2 * f);
  rig.target.set(flight.fx + (flight.tx - flight.fx) * e, 0, flight.fz + (flight.tz - flight.fz) * e);
  rig.dist = flight.fd + (flight.td - flight.fd) * e;
  if (f >= 1) flight = null;
}
net.on('stats', (m) => {
  clock.day = m.day; clock.frac = m.dayFrac; clock.at = performance.now(); clock.rate = m.rate ?? 1;
  ui.setClock(m.day, m.dayFrac);
  ui.setWorldStats(m, local ? -1 : onlineCount); // -1: a local game has no one else online
});
net.on('toast', (m) => ui.toast(m.kind, m.msg));
// onboarding goals, advisor hints and the tech chip's pulse (onboarding.ts)
/** the first-settlers camera moment (moment.ts, docs/first-five.md); never over a demo tour */
const moment = new CameraMoment(rig, () => { following = false; });
// adverts (adverts.ts, render/adverts.ts, docs/adverts.md): the ads chip and the Campaigns panel, posters on the rented frames
const adPanel = new AdPanel(document.getElementById('adverts')!, document.getElementById('adsBtn')!, {
  net, world, view: buildings.adverts, liveTick, nameAt: (x, y) => buildings.nameAt(...world.doorOf(x, y)) ?? null, toast: (k, msg) => ui.toast(k, msg),
  centre: () => [Math.floor(rig.target.x), Math.floor(rig.target.z)],
  openTech: () => { ui.toggleTech(true); ui.showTech(world.myPlayer); policies.toggle(false); },
  lookAt: (x, y, height, dir, dist = 7.5, side = 0.35, pitch = 0.32) => {
    // street level, a little to one side of the poster, looking at it
    following = false;
    rig.target.set(x, Math.min(height, 1.2), y);
    rig.yaw = Math.atan2(dir[0], dir[1]) + side;
    rig.pitch = pitch; rig.dist = dist;
  },
});
buildings.adverts.owner = (id) => { const p = world.players.get(id); return { name: p?.name ?? id, color: p?.color ?? 0x888888 }; };
buildings.adverts.tick = liveTick;
net.on('ads', (m) => { buildings.adverts.setAds(m.campaigns, m.r, AD_RENTAL); adPanel.changed(); });
document.getElementById('adsBtn')!.onclick = () => { ui.toggleTech(false); policies.toggle(false); adPanel.toggle(); adPanel.show(world.myPlayer, onboarding.activeGoal === 'adverts'); };
const onboarding = new Onboarding({ net, world, liveTick, tool: (t) => input.setTool(t as ToolId), toast: (k, msg) => ui.toast(k, msg),
  adverts: (near) => adPanel.showMe(near), goalChanged: (active) => adPanel.show(world.myPlayer, active === 'adverts'),
  moment: (x, y, caption) => { if (!tour && !mapMode.on) moment.play(x, y, caption); },
  focus: (x, y) => { following = false; rig.target.set(x + 0.5, 0, y + 0.5); rig.dist = Math.min(Math.max(rig.dist, 30), 60); }, openTech: () => { ui.toggleTech(true); ui.showTech(world.myPlayer); } });
ui.onHint = (id) => onboarding.hint(id);
// settlement ranks (ranks.ts, docs/ranks.md): the rank chip and card, the milestone feed, fireworks on a rank-up
const fireworks = new Fireworks(); scene.add(fireworks.group);
const ranks = new RanksUI({ net, world, liveTick, fireworks, moment: (x, y, caption, o) => { if (!tour && !mapMode.on) moment.play(x, y, caption, o); } });
scene.add(ranks.group);
// progressive disclosure (reveal.ts): a Camp-rank town sees the tools it can use and the chips the first hour needs
const reveal = new Reveal({
  env: () => ({ rank: ranks.rank, sandbox: world.sandbox, spectate: world.spectate, dev: DEV_TOOLS, everything: readPref() }),
  veilTools: (on, keep) => ui.veilLocked(on, keep), visibleTools: () => ui.visibleTools(), fresh: (id) => ui.freshTool(id),
  goalTool: () => { const g = onboarding.activeGoal; return g ? (GOAL_BY_ID.get(g as never)?.show?.tool ?? null) : null; },
  toast: (k, msg) => ui.toast(k, msg),
});
ui.onEverything = (all) => { writePref(all); reveal.apply(); };
ranks.onChange = () => reveal.apply();
// the news (news.ts, docs/media.md): the news chip and panel, the ticker of breaking stories, a media centre's channel
new NewsUI({ net, world, liveTick, flyTo: (x, y) => flyTo(x, y), headline: (h) => buildings.adverts.setNewsHeadline(h) });
// news helicopters (shared newsHelis.ts) and television (render/tv.ts, docs/media.md sections 6-8): the story log flies the
// media centres' helicopters; the FPV's TV sets show the channels' programmes and, while one is over a story, its pictures
helis.news = {
  owner: (x, y) => world.parcelAt(x, y)?.owner,
  channel: (o) => { const p = world.players.get(o); return { name: channelName(p?.name ?? o), color: p?.color ?? 0x888888 }; },
  stories: () => news.all(), version: () => news.version,
};
const tvLiveOff = params.get('tvlive') === '0';
const tv = new TvGuide({ world, helis, tick: liveTickF, setNewsFeed: (t) => buildings.adverts.setNewsFeed(t), lowPreset: () => tvLiveOff || lighting.quality === 0 });
tv.tapNet((fn) => net.tap(fn));
setTvSource(tv);
ui.watching = (info) => tv.watching(info);
/**
 * The tour's TV stop (view 'tv', docs/media.md section 8): ask the homes in its rect who is in, then follow residents at
 * home one by one in the FPV inset until one is in the lounge with the set on; null ends it. Nobody in: the card says so.
 */
let tvHunt: { cands: number[]; tried: Set<number>; timer: number; found: boolean } | null = null;
function watchTv(rect: [number, number, number, number] | null) {
  if (tvHunt) { clearInterval(tvHunt.timer); const was = tvHunt; tvHunt = null; if (was.tried.size) { if (fpv.mode !== 'off') fpv.end(); selectCitizen(0); } }
  if (!rect) return;
  const hunt = { cands: [] as number[], tried: new Set<number>(), timer: 0, found: false };
  tvHunt = hunt;
  const asked = new Set<string>();
  for (let y = rect[1]; y < rect[1] + rect[3]; y++) for (let x = rect[0]; x < rect[0] + rect[2]; x++) {
    const t = world.getTile(x, y);
    if (t === undefined || isRoad(t) || zoneOf(t) !== Zone.Residential || levelOf(t) <= 0) continue;
    const [dx, dy] = world.doorOf(x, y), k = `${dx},${dy}`;
    if (asked.has(k) || asked.size >= 12) continue;
    asked.add(k);
    net.send({ t: 'inspect', x: dx, y: dy, full: true });
  }
  hunt.timer = window.setInterval(() => {
    if (tvHunt !== hunt || hunt.found) return;
    if (selectedCitizen && hunt.tried.has(selectedCitizen) && /watching/.test(fpv.roomLabel)) { hunt.found = true; return; }
    const next = hunt.cands.find((c) => !hunt.tried.has(c));
    if (next === undefined) return;
    hunt.tried.add(next);
    selectCitizen(next);
    fpv.start('inset');
  }, 2500);
}
net.tap((m) => {
  if (!tvHunt || m.t !== 'building' || !m.info?.people) return;
  for (const r of m.info.people.residents) if (r.activity.startsWith('at home') && !tvHunt.cands.includes(r.id)) tvHunt.cands.push(r.id);
});
net.on('railLines', (m) => { trains.setLines(m.lines); rail.setLines(m.lines); });
// underground lines (docs/underground.md): their trains run in the bores, and the bores take the lines' colours
const metroMeta = new Map<number, MetroLineDTO>(); // the metro lines as sent, for station names on a cab ride
net.on('metroLines', (m) => {
  metroMeta.clear();
  for (const l of m.lines) metroMeta.set(l.id, l);
  trains.setMetroLines(m.lines);
  lines.setMetroNames(m.lines);
  underground.setLines(m.lines.filter((l) => l.route).map((l) => ({ colour: l.color, sides: lineSides(l.route!, { under: (x, y) => world.underAt(x, y) }) })));
});
net.on('metroLoads', (m) => trains.setLoads(m.l));
// river bus lines (docs/boats.md 6.2): the piers' names and the sailing lines in the lines panel; B6's BoatsView runs their boats
const ferryMeta = new Map<number, FerryLineDTO>();
net.on('ferryLines', (m) => {
  ferryMeta.clear();
  for (const l of m.lines) ferryMeta.set(l.id, l);
  lines.setFerryLines(m.lines);
  boats.setFerryLines(m.lines); // the river buses sail them (render/boats.ts)
});
// the harbours with their lanes (server sim/harbours.ts): every boat but the river buses sails them; the list replaces the ?dev mock for good
net.on('harbours', (m) => { if (m.list.length || !boatMock) boats.setHarbours(m.list, true); }); // with ?dev and none built yet, the mock keeps the boats
net.on('boat', (m) => {
  const v = selectedVehicle;
  if (v?.kind === 'boat' && m.id === v.id) { boatInfo = m.info; showBoatPanel(); }
});
lines.onUnder = (on) => { if (on) { if (!underground.on) setUnder(true, true); } else if (underAuto) setUnder(false); }; // a metro line being edited shows the tunnels
net.on('sitelist', (m) => {
  const p = world.parcels.get(m.id);
  if (p && m.id === selectedParcel) ui.showSites(m.id, m.sites, world.mayEdit(p.owner));
});
setInterval(() => { if (selectedParcel && !selectedBuilding && net.connected) net.send({ t: 'sites', id: selectedParcel }); }, 2000);

// ---- chunk streaming ----------------------------------------------------------------------
const subscribed = new Set<string>();
const STREAM_MIN_R = 1, STREAM_MAX_R = 6; // chunks either side of the camera target's chunk
/**
 * How far the fog reaches, as a chunk radius: grows with zoom-out and when the camera is tilted toward the horizon.
 * This used to be the streaming radius too; the fog keeps it so the look is unchanged, and streaming now follows
 * what the camera can actually see inside that fog (streamWindow).
 */
function fogRadius() {
  const low = rig.pitch < 0.6 ? 1 : 0;
  return Math.min(STREAM_MAX_R, Math.max(2, Math.ceil(rig.dist / 35) + 1 + low));
}
function fogFar() {
  return Math.min(rig.dist * 4.5 + 140, fogRadius() * CHUNK_SIZE + rig.dist * Math.cos(rig.pitch));
}
/**
 * Chunks to keep loaded: the ground footprint of the view (the four corner rays hitting the ground, cut off where
 * the fog is opaque), plus one chunk of margin all round (two when tilted toward the horizon), clamped to at least
 * STREAM_MIN_R and at most fogRadius() (never more than STREAM_MAX_R) chunks either side of the target's chunk, so
 * it is never bigger than the old fixed square. Worked out from yaw/pitch/dist rather than the camera matrices so
 * it is current even between frames.
 */
function streamWindow(): { cx0: number; cx1: number; cy0: number; cy1: number } {
  const cam = rig.camera;
  const t = Math.tan((cam.fov * Math.PI) / 360), a = cam.aspect;
  const sp = Math.sin(rig.pitch), cp = Math.cos(rig.pitch);
  const height = rig.dist * sp, back = rig.dist * cp, far = fogFar();
  const fx = -Math.sin(rig.yaw), fz = -Math.cos(rig.yaw), rx = Math.cos(rig.yaw), rz = -Math.sin(rig.yaw);
  let x0 = 0, x1 = 0, z0 = 0, z1 = 0;
  for (const v of [-1, 1]) for (const u of [-1, 1]) {
    // corner ray in camera space is (u·t·a, v·t, -1): its depth is the ray parameter, which fog is measured in
    const down = sp - v * t * cp;
    const s = Math.min(far, down > 1e-6 ? height / down : far);
    const f = s * (cp + v * t * sp) - back, l = s * u * t * a; // forward / right of the target on the ground
    const x = fx * f + rx * l, z = fz * f + rz * l;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const m = CHUNK_SIZE * (rig.pitch < 0.6 ? 2 : 1);
  const tx = rig.target.x, tz = rig.target.z;
  const ccx = Math.floor(tx / CHUNK_SIZE), ccy = Math.floor(tz / CHUNK_SIZE);
  const rMax = Math.min(STREAM_MAX_R, fogRadius());
  const clampLo = (c: number, cc: number) => Math.min(cc - STREAM_MIN_R, Math.max(cc - rMax, c));
  const clampHi = (c: number, cc: number) => Math.max(cc + STREAM_MIN_R, Math.min(cc + rMax, c));
  return {
    cx0: clampLo(Math.floor((tx + x0 - m) / CHUNK_SIZE), ccx), cx1: clampHi(Math.floor((tx + x1 + m) / CHUNK_SIZE), ccx),
    cy0: clampLo(Math.floor((tz + z0 - m) / CHUNK_SIZE), ccy), cy1: clampHi(Math.floor((tz + z1 + m) / CHUNK_SIZE), ccy),
  };
}
function streamChunks() {
  if (!net.connected) return;
  const win = streamWindow();
  const want = new Set<string>();
  if (!mapMode.on) for (let cy = win.cy0; cy <= win.cy1; cy++) for (let cx = win.cx0; cx <= win.cx1; cx++) want.add(chunkKey(cx, cy));
  const add: [number, number][] = [], drop: [number, number][] = [];
  for (const k of want) if (!subscribed.has(k)) { subscribed.add(k); add.push(parseKey(k)); }
  for (const k of subscribed) if (!want.has(k)) { subscribed.delete(k); drop.push(parseKey(k)); dropView(k); }
  if (add.length) net.send({ t: 'sub', chunks: add });
  if (drop.length) net.send({ t: 'unsub', chunks: drop });
}
function dropView(key: string) {
  const v = views.get(key);
  if (v) { scene.remove(v.group); v.dispose(); views.delete(key); }
  buildings.clear(key);
  lights.dropChunk(key);
  parks.dropChunk(key);
  airfield.dropChunk(key);
  underground.dropChunk(key);
  helis.dropChunk(key);
  boatMock?.dropChunk(key);
  trains.dropChunk(key);
  bridges.dropChunk(key);
  roads.dropChunk(key);
  landmarks.dropChunk(key);
  power.dropChunk(key);
  chunkWork.dropChunk(key);
  const c = world.chunks.get(key);
  world.dropChunk(key);
  if (c) junctions.unloadChunk(key, c.cx, c.cy); else junctions.dropChunk(key); // after the world forgets it: the neighbours' signs are drawn without its tiles
}
setInterval(streamChunks, 300);

// ---- the world map (mapmode.ts, docs/world-map.md): Tab, the map chip, or zooming out past the 3D limit ----------
const mapMode = new MapMode({
  net, world, rig, canvas, mount: document.getElementById('ui')!,
  toast: (k, msg) => ui.toast(k, msg), status: (t) => ui.setStatus(t),
  onToggle: (on) => {
    if (on) {
      // the 3D tools, panels and tooltips wait; no chunk is streamed while the map is up
      input.setTool('select'); input.hover = null;
      closeBuilding(false); selectedParcel = 0; world.parcelsDirty = true; refreshPanel();
      if (fpv.mode !== 'off') fpv.end();
      clearTimeout(tipTimer); clearInterval(tipRefresh); tipTile = null; tipAgent = 0; ui.hideTip();
    }
    streamChunks();
  },
});
mapMode.onView = (x, y) => { following = false; rig.target.set(x, 0, y); };
document.getElementById('mapBtn')?.addEventListener('click', () => mapMode.toggle());

// ---- input ------------------------------------------------------------------------------------
const input = new Input(canvas, rig, {
  map: mapMode,
  onToolChange: (t) => { applyToolCursor(canvas.classList, t); pickHint = false; ui.setTool(t); rectMesh.visible = false; updateStatus(); toolUnder(t); audio.ui('click'); },
  ladderKey: (t) => ui.ladderKey(t), // 0, 8, 9, Y, P, G, V, B, L open their size picker on the size last used
  isWater: (x, y) => { const t = world.getTile(x, y); return t !== undefined && terrainOf(t) === Terrain.Water; }, // a road drag's end does not snap across water
  isRoad: (x, y) => { const t = world.getTile(x, y); return t !== undefined && isRoad(t); },
  onRoad: (tiles, _shape) => {
    // buildings in the way: ask once, with the cost, and the answer goes for the whole drag (a0902fd7)
    const v = roadTool.plan(tiles);
    const send = (demolish: boolean) => { net.send({ t: 'build', tool: 'road', tiles, cls: roadTool.roadClass, ...(demolish ? { demolish: true } : {}), ...(DEV_TOOLS ? { dev: true } : {}) }); audio.ui('place'); };
    if (!v.demolish.n) { send(false); return; }
    void roadTool.ask(v, mouse.x, mouse.y).then((a) => { if (a !== 'cancel') send(a === 'demolish'); });
  },
  onUndoRoad: () => { net.send({ t: 'undoRoad' }); audio.ui('undo'); },
  // the Street rules tool (R5): a click sets the whole street, a drag part of one
  onStreetRule: (tiles, street, ns) => { const why = streetRules.release(street ? streetRules.tilesFor(tiles[0], null, ns) : tiles); if (why) ui.toast('error', why); },
  onUndoStreetRule: () => { net.send({ t: 'undoStreetRule' }); audio.ui('undo'); },
  onBuild: (tool, tiles) => {
    // a click (not a drag) with a link tool takes down the line through that tile (docs/utilities.md 4.2)
    if ((tool === 'pylons' || tool === 'cable') && tiles.length < 2) { if (tiles[0]) net.send({ t: 'utilLink', op: 'remove', x: tiles[0][0], y: tiles[0][1] }); return; }
    const rot = structureTool(tool) ? input.rotationOf(tool) : undefined; // the orientation chosen with Z/C, else the server faces a road itself
    net.send({ t: 'build', tool: tool as Tool, tiles, ...(rot !== undefined ? { rot } : {}), ...(DEV_TOOLS ? { dev: true } : {}) });
    audio.ui('place');
  },
  onRotate: (tool, dir) => {
    // the first press starts from the orientation the preview currently shows (auto-chosen or not); later presses turn the chosen one
    const auto = placeMemo && placeMemo.kind === structureTool(tool) ? placeMemo.v.placed?.r : undefined;
    input.setRotation(tool, (input.rotationOf(tool) ?? auto ?? 0) + dir + 4);
    placeMemo = null;
    updateStatus();
  },
  onBuy: (r: Rect) => { net.send({ t: 'buy', ...r }); rectMesh.visible = false; },
  onContext: (px, py, cx, cy) => {
    if (lines.undoStop()) return; // editing a bus line: a right-click takes the last stop off
    // right-click (not a drag): the menu of whatever is under the cursor, agents first like a left click
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const id = citizens.pick(px, py, rig.camera, w, h);
    if (id) { ctxMenu.open({ k: 'agent', id }, cx, cy); return; }
    const tr = trains.pick(px, py, rig.camera, w, h);
    if (tr) { ctxMenu.open({ k: 'train', ...tr }, cx, cy); return; }
    const pl = planes.pick(px, py, rig.camera, w, h);
    if (pl) { ctxMenu.open({ k: 'plane', ...pl }, cx, cy); return; }
    const hl = helis.pick(px, py, rig.camera, w, h);
    if (hl !== null) { ctxMenu.open({ k: 'heli', flight: hl }, cx, cy); return; }
    const bt = boats.pick(px, py, rig.camera, w, h);
    if (bt !== null) { ctxMenu.open({ k: 'boat', id: bt }, cx, cy); return; }
    const tile = input.tileAt(px, py);
    if (tile) ctxMenu.open({ k: 'tile', x: tile[0], y: tile[1] }, cx, cy);
  },
  onSelect: (x, y, px, py) => {
    if (lines.mapClick(x, y)) return; // editing a bus line: clicked stops join it
    if (adPanel.mapClick(x, y)) return; // picking frames for a campaign: a click rents the building's free one
    const id = citizens.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight);
    if (id) { selectCitizen(id); return; }
    const badge = issuesView.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight); // a click on an issue badge opens its building
    if (badge) { selectTile(badge[0], badge[1], 'building'); return; }
    const grave = gravesView.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight); // a headstone opens its panel (docs/remembrance.md)
    if (grave !== null) { openDeceased(grave); return; }
    // trains and planes (vehicles.ts): picked from what was drawn last frame
    const tr = trains.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight);
    if (tr) { selectVehicle({ kind: 'train', ...tr }); return; }
    const pl = planes.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight);
    if (pl) { selectVehicle({ kind: 'plane', ...pl }); return; }
    const hl = helis.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight);
    if (hl !== null) { selectVehicle({ kind: 'heli', flight: hl }); return; }
    const bt = boats.pick(px, py, rig.camera, canvas.clientWidth, canvas.clientHeight);
    if (bt !== null) { selectVehicle({ kind: 'boat', id: bt }); return; }
    selectTile(x, y, 'building');
  },
  onHover: (tile) => { updateStatus(); hoverAt(tile); },
  onKey: (code) => {
    if (mapMode.on) { if (code === 'Tab') mapMode.toggle(); else if (code === 'Escape') mapMode.escape(); return; }
    if (code === 'Tab') mapMode.toggle();
    else if (code === 'Escape' && adPanel.isPicking) adPanel.toggle(false);
    else if (code === 'Escape' && selectedBuilding) closeBuilding();
    else if (code === 'Escape' && selectedParcel) closeParcel();
    else if (code === 'KeyH') overlayMenu.cycle();
    else if (code === 'KeyN') setUnder(!underground.on);
    else if (code === 'KeyT') { ui.toggleTech(); ui.showTech(world.myPlayer); policies.toggle(false); }
  },
});

// a click lands on the building under the cursor, roof included, not on the ground behind it (pick.ts); the Buildings
// constructor above has compiled the designs, so their tallest sets how far down the ray is walked
applyToolCursor(canvas.classList, input.tool); // the first cursor: the arrow of the select tool
input.column = { heightAt: columnHeights(world, variant), maxH: Math.max(0, ...allVariants().map((v) => v.height)) * 1.06 };

/** Select the building on a tile (its people panel), or only the parcel under it (the tax and name panel). */
function selectTile(x: number, y: number, panel: 'building' | 'parcel') {
  [x, y] = world.doorOf(x, y); // a structure is known by its door tile
  const t = world.getTile(x, y);
  const p = world.parcelAt(x, y);
  selectedParcel = p ? p.id : 0;
  world.parcelsDirty = true;
  if (panel === 'building' && t !== undefined && zoneOf(t) !== 0 && !isRoad(t)) {
    selectedBuilding = [x, y];
    ui.showBuilding(PENDING_INFO(x, y, t), selectedCitizen);
    refreshBuilding();
    return;
  }
  closeBuilding(false);
  refreshPanel();
}
function setFollow(on: boolean) { following = on; if (on) { rig.dist = Math.min(rig.dist, 18); } refreshCitizen(); refreshVehicle(); }

// ---- traffic heat overlay and parked cars ----------------------------------------------------
function setHeat(on: boolean) {
  ChunkView.setHeat(on);
  sceneUniforms.uHeat.value = on ? 1 : 0;
} // the chip is the overlays menu's (overlays.ts)
// ---- education overlay: parcels tinted by their education index (render/eduHeat.ts, docs/education.md section 14) ----
const eduHeat = new EduHeat(); scene.add(eduHeat.group);
let eduDirty = false;
const eduBtn = document.createElement('button');
eduBtn.id = 'eduHeat'; eduBtn.className = 'chip'; eduBtn.textContent = 'education';
eduBtn.title = 'Tint parcels by how well qualified their residents are (the education index); a white edge marks a school';
document.getElementById('heat')!.after(eduBtn);
function setEduHeat(on: boolean) {
  eduHeat.setOn(on); eduDirty = on;
  eduBtn.classList.toggle('on', on);
  eduBtn.innerHTML = on ? 'education <i class="legend edu"></i>' : 'education';
}
eduBtn.onclick = () => setEduHeat(!eduHeat.on);
// ---- the underground view ------------------------------------------------------------------------
/** the view came on by itself because a metro tool was picked, and goes back off when the tool does */
let underAuto = false;
function setUnder(on: boolean, auto = false) {
  underground.set(on);
  underAuto = on && auto;
  document.getElementById('under')?.classList.toggle('on', on);
}
document.getElementById('under')?.addEventListener('click', () => setUnder(!underground.on));
/** a metro station tool shows the underground while it is picked (docs/underground.md section 5) */
function toolUnder(tool: string) {
  const metro = isMetroStationKind(structureTool(tool));
  if (metro && !underground.on) setUnder(true, true);
  else if (!metro && underAuto) setUnder(false);
}
/** the platform a metro station tool would build under the hovered door, for the ghost and the verdict */
function platformAt(kind: number, h: [number, number], p: Placed | undefined, rot: number | undefined) {
  const r = p?.r ?? rot ?? 0;
  return planPlatform(kind, p ? p.doorX : h[0], p ? p.doorY : h[1], (r & 1) === 0, { tile: (x, y) => world.getTile(x, y), under: (x, y) => world.underAt(x, y) });
}
document.getElementById('techBtn')!.onclick = () => { ui.toggleTech(); ui.showTech(world.myPlayer); policies.toggle(false); };
document.getElementById('policiesBtn')!.onclick = () => { ui.toggleTech(false); policies.toggle(); policies.show(world.myPlayer); };
/** Fold fresh traffic bytes into the chunk views and the parked-car instances. */
function applyTrafficUpdates() {
  if (!world.trafficDirty.size) return;
  for (const key of world.trafficDirty) {
    const v = views.get(key);
    if (v && !power.overlayOn && !roadsOverlay) { v.heat = world.traffic.get(key); v.tintRoads(); } // the power or road classes overlay owns the roads' heat while it is on
  }
  parked.update(world.trafficDirty);
  world.trafficDirty.clear();
}

// ---- selected citizen: live panel and follow camera -------------------------------------------
/** The selected agent's last answer that carried its route (hover answers for the same agent do not). */
let routeInfo: CitizenInfo | null = null;
/** First-person view (I: inset, O: whole window, Esc leaves the window); render/fpv.ts */
const fpv = new Fpv({
  citizens,
  selected: () => selectedCitizen,
  cab: () => cabEye(),
  indicator: (id) => { const s = citizens.indicatorOf(id); return s && citizens.indicatorLit(id) ? (s === 'hazard' ? 2 : s) : 0; },
  notify: (msg) => ui.toast('info', msg),
  clock: () => liveTickF(), // a night out builds and wears off with the game's evening (render/nightout.ts)
  tunnel: { underAt: (x, y) => world.underAt(x, y), keep: () => [trains.under, citizens.under] }, // a tube cab ride draws these over its tunnel (render/tunnelRide.ts)
  // riding as a passenger (render/passenger.ts): the seat in the bus, carriage or tube car the inspect names, posed from this frame
  seat: (ab, rider, info) => seatEyes.seat(ab, rider, info),
  // the ridden bus is drawn as the selection (layer 1, which the eye skips) and the tube train's window figures are left out
  riding: (ab) => { citizens.selected = ab?.mode === 'bus' ? ab.vehicle : selectedCitizen; trains.ridden = ab && ab.mode !== 'bus' ? { line: ab.line, train: ab.train ?? 0 } : null; },
  onChange: (mode) => {
    ui.markFpv(mode);
    if (mode === 'full') { input.hover = null; ui.hideTip(); rig.dist = Math.min(rig.dist, 30); }
  },
});
/** a passenger's eye (passengerSeat.ts): the bus, carriage, tube car or plane seat, from the pose drawn this frame */
const seatEyes = new SeatEyes({ citizens, trains, planes, metroNames: (line) => metroMeta.get(line)?.names });
function selectCitizen(id: number) {
  clearVehicle(); // a name picked from a train's roster replaces the train
  selectedCitizen = id;
  citizens.selected = id;
  following = false;
  routeInfo = null;
  routeView.clear();
  fpv.retarget();
  if (!id) { ui.hideCitizen(); ui.markPerson(0); return; }
  ui.markPerson(id);
  net.send({ t: 'inspectCitizen', id, route: true });
}
function refreshCitizen() { if (selectedCitizen && net.connected) net.send({ t: 'inspectCitizen', id: selectedCitizen, route: true }); }
setInterval(refreshCitizen, 1000);
net.on('citizen', (m) => {
  if (m.id === selectedCitizen) {
    if (!m.info) { selectCitizen(0); return; }
    let info = m.info;
    if (info.trail || info.route) { routeInfo = info; routeView.set(info); }
    else if (routeInfo) info = { ...info, trail: routeInfo.trail, route: routeInfo.route, legKinds: routeInfo.legKinds, legStarts: routeInfo.legStarts };
    ui.showCitizen(info, following, fpv.mode);
    fpv.setInfo(info);
  }
  if (m.id === tipAgent) {
    if (!m.info) { ui.hideTip(); return; }
    ui.showCitizenTip(m.info);
    ui.moveTip(mouse.x, mouse.y);
  }
});

// ---- right-click menu (contextmenu.ts): what exists for the person, vehicle, building, road or land under the cursor
const ctxMenu = new ContextMenu({
  world, net,
  selectedCitizen: () => selectedCitizen,
  selectedVehicle: () => selectedVehicle,
  following: () => following,
  fpvMode: () => fpv.mode,
  selectAgent: (id) => selectCitizen(id),
  selectVehicle: (v) => selectVehicle(v),
  deselect: () => (selectedVehicle ? selectVehicle(null) : selectCitizen(0)),
  follow: (on) => setFollow(on),
  fpv: (mode) => { if (mode === 'inset') fpv.toggleInset(); else fpv.toggleFull(); },
  selectTile,
  focus: (x, y) => { following = false; rig.target.set(x + 0.5, 0, y + 0.5); rig.dist = Math.min(rig.dist, 30); },
  openLines: () => lines.toggle(true),
  buyVerdict,
  onOpen: () => { clearTimeout(tipTimer); clearInterval(tipRefresh); tipTile = null; tipAgent = 0; ui.hideTip(); },
});

// ---- selected train or plane: panel, follow camera and cab view (vehicles.ts) ------------------------
const UP = new Vector3(0, 1, 0), AXIS_Z = new Vector3(0, 0, 1);
const manifests = new Map<string, FlightManifest>();
function manifestOf(airport: number, f: Flight): FlightManifest {
  const k = `${airport}:${f.id}`;
  let m = manifests.get(k);
  if (!m) { const p = flightPassengers(f); m = flightManifest(f, p.arriving, p.departing); if (manifests.size > 64) manifests.clear(); manifests.set(k, m); }
  return m;
}
function clearVehicle() { selectedVehicle = null; trainInfo = null; boatInfo = null; trains.selected = null; planes.selected = null; helis.selected = null; boats.selected = null; }
function selectVehicle(v: VehicleSel | null) {
  selectedCitizen = 0; citizens.selected = 0; routeInfo = null; routeView.clear(); ui.markPerson(0);
  following = false;
  clearVehicle();
  selectedVehicle = v;
  if (v?.kind === 'train') trains.selected = { line: v.line, train: v.train };
  if (v?.kind === 'plane') planes.selected = `${v.airport}:${v.flight}`;
  if (v?.kind === 'heli') helis.selected = v.flight;
  if (v?.kind === 'boat') boats.selected = v.id;
  fpv.retarget();
  if (!v) { ui.hideCitizen(); return; }
  refreshVehicle();
}
/** Trains ask the server for their riders (a `full` inspect, answered in 'train'); planes are worked out here. */
function refreshVehicle() {
  const v = selectedVehicle;
  if (v?.kind === 'train') { if (net.connected) net.send({ t: 'inspectTrain', line: v.line, train: v.train, full: true }); if (!trainInfo) showTrainPanel(); }
  else if (v?.kind === 'plane') showPlanePanel();
  else if (v?.kind === 'heli') showHeliPanel();
  else if (v?.kind === 'boat') { if (net.connected && v.id < FERRY_ID_BASE) net.send({ t: 'inspectBoat', id: v.id }); showBoatPanel(); }
}
setInterval(refreshVehicle, 1000);
function showTrainPanel() {
  const v = selectedVehicle;
  if (v?.kind !== 'train') return;
  const dto = trains.lines.find((l) => l.id === v.line), st = trains.stateOf(v.line, v.train);
  if (!dto || !st) { selectVehicle(null); ui.toast('info', 'That train has gone out of service'); return; }
  const kinds = trains.consistOf(v.line, v.train);
  const crew = trainCrew(v.line, v.train, !!(trainInfo?.freight ?? dto.freight), kinds?.length ?? 0, trains.lastTick);
  ui.showVehicle(vehicleKey(v), trainPanelHtml(dto, st, kinds, trainInfo, crew, selectedCitizen), following, fpv.mode);
}
/** a plane's speed in tiles per tick, from where it is half a tick on */
function planeSpeed(airport: number, flight: number): number {
  const a = planes.stateOf(airport, flight), b = planes.stateOf(airport, flight, planes.lastTick + 0.5);
  return a && b ? Math.hypot(b.s.x - a.s.x, b.s.y - a.s.y, b.s.z - a.s.z) / 0.5 : 0;
}
function showPlanePanel() {
  const v = selectedVehicle;
  if (v?.kind !== 'plane') return;
  const hit = planes.stateOf(v.airport, v.flight);
  if (!hit) { selectVehicle(null); ui.toast('info', 'That plane has left'); return; }
  const m = manifestOf(v.airport, hit.s.flight);
  ui.showVehicle(vehicleKey(v), planePanelHtml(hit.s, m, hit.s.gate, planeKnots(hit.s.type, planeSpeed(v.airport, v.flight)), v.seat), following, fpv.mode);
}
/** a helicopter's ground speed in tiles per tick, from where it is half a tick on */
function heliSpeed(flight: number): number {
  const a = helis.stateOf(flight), b = helis.stateOf(flight, helis.lastTick + 0.5);
  return a && b ? Math.hypot(b.x - a.x, b.z - a.z) / 0.5 : 0;
}
function showHeliPanel() {
  const v = selectedVehicle;
  if (v?.kind !== 'heli') return;
  const s = helis.stateOf(v.flight);
  if (!s) { selectVehicle(null); ui.toast('info', 'That helicopter has left'); return; }
  ui.showVehicle(vehicleKey(v), heliPanelHtml(s, heliKnots(heliSpeed(v.flight))), following, fpv.mode);
}
function showBoatPanel() {
  const v = selectedVehicle;
  if (v?.kind !== 'boat') return;
  const s = boats.stateOf(v.id);
  if (!s) { selectVehicle(null); ui.toast('info', 'That boat has gone out of sight'); return; }
  ui.showVehicle(vehicleKey(v), boatPanelHtml(s, boats.harbourOf(s.harbour), boats.lastTick, boatKnots(s.speed), { ferry: boats.ferryOf(s.id), info: boatInfo }), following, fpv.mode);
}
/** The selected vehicle's cab for the first-person view, from the pose drawn this frame. */
function cabEye(): CabEye | null {
  const v = selectedVehicle;
  if (!v) return null;
  if (v.kind === 'train') {
    const c = trains.cabOf(v.line, v.train), dto = trains.lines.find((l) => l.id === v.line);
    if (!c || !dto) return null;
    const svc = trains.serviceOf(v.line), meta = svc?.metro ? metroMeta.get(v.line) : undefined;
    // a tube train knows the station names itself: the stop it is at, or the one it is running to
    const next = meta?.names[c.st.stop] ?? trainInfo?.next;
    const doing = c.st.phase === 'dwell' ? (c.st.doors ? 'standing · doors open' : 'standing') : next ? `running to ${next}` : 'running';
    const q = new Quaternion().setFromAxisAngle(UP, -c.h);
    if (meta) q.multiply(new Quaternion().setFromAxisAngle(AXIS_Z, c.pitch)); // a crossover's dip pitches the cab
    return {
      key: vehicleKey(v), x: c.x, y: c.y, z: c.z, q,
      label: `${meta?.name ?? `Line ${dto.number}`} · driver's cab`, lines: [doing, `${trainKmh(c.st.v)} km/h`], dip: meta ? 0.02 : 0.035, sway: c.st.v / TRAIN_VMAX * (meta ? 1.4 : 1), seed: hash2(v.line, v.train),
      interior: { kind: 'train', kmh: trainKmh(c.st.v), vmax: trainKmh(TRAIN_VMAX), next, doors: !!c.st.doors, seed: hash2(v.line, v.train) },
      tunnel: svc && meta ? { geom: svc.geom, s: c.s, dir: c.dir, off: c.off, line: v.line, colour: dto.color, names: meta.names, stop: c.st.stop, dwelling: c.st.phase === 'dwell' } : undefined,
    };
  }
  if (v.kind === 'heli') {
    const s = helis.stateOf(v.flight);
    if (!s) return null;
    const e = helis.cockpitOf(s), kt = heliKnots(heliSpeed(v.flight));
    const title = heliTitle(s).replace(/<span[^>]*>/, '· ').replace(/<[^>]+>/g, '').replace(/^\S+ /, '');
    return {
      key: vehicleKey(v), ...e, label: `${title} · cockpit`,
      lines: [heliDoing(s), `${s.phase !== 'onPad' ? `${planeFeet(s.y).toLocaleString()} ft · ` : ''}${kt} kt`],
      fogFar: 130, dip: s.y - (s.pad?.y ?? 0) > 1 ? 0.14 : 0.06, sway: s.phase === 'onPad' ? 0.15 * s.rotor : 0.45, seed: s.seed,
      instruments: { ktPerTile: heliKnots(1000) / 1000, ftPerTile: planeFeet(100) / 100, ticksPerSec: (1000 / TICK_MS) * clock.rate, tick: helis.lastTick, knots: kt, eyeAbove: e.y - s.y },
    };
  }
  if (v.kind === 'boat') {
    const s = boats.stateOf(v.id), pose = boats.helmPose();
    return s && pose ? boatCab(vehicleKey(v), s, boats.harbourOf(s.harbour), boats.lastTick, pose, boats.hullOf(v.id), boats.turnOf(v.id), boats.ferryOf(s.id)) : null;
  }
  const hit = planes.stateOf(v.airport, v.flight);
  if (!hit) return null;
  // a seat picked from the manifest: the cabin from it (passengerSeat.ts), the words a couple of times a second
  if (v.seat) return seatEyes.cabin(hit.s, manifestOf(v.airport, hit.s.flight), v.seat, v.who ?? '', cabinKey, cabinKnots);
  const m = manifestOf(v.airport, hit.s.flight), e = planes.cockpitOf(hit.s), kt = planeKnots(hit.s.type, planeSpeed(v.airport, v.flight));
  const outbound = hit.s.phase !== 'approach' && hit.s.phase !== 'flare' && hit.s.phase !== 'rollout' && hit.s.phase !== 'taxiIn' && !(hit.s.phase === 'dwell' && hit.s.progress < 0.5);
  return {
    key: vehicleKey(v), ...e, label: `${outbound ? m.outbound : m.inbound} · ${m.airline} · cockpit`,
    lines: [planeDoing(hit.s, m), `${hit.s.y > 0.05 ? `${planeFeet(hit.s.y).toLocaleString()} ft · ` : ''}${kt} kt`],
    fogFar: 150, dip: hit.s.y > 0.3 ? 0.1 : 0.04, sway: hit.s.y > 0.05 ? 0.6 : 0.2, seed: hit.s.seed,
    instruments: { ktPerTile: planeKnots(hit.s.type, 1000) / 1000, ftPerTile: planeFeet(100) / 100, ticksPerSec: (1000 / TICK_MS) * clock.rate, tick: planes.lastTick, knots: kt, eyeAbove: e.y - hit.s.y },
  };
}
/** the selected plane seat's ride key (a new seat is a new ride) and its knots, for the cabin view */
let cabinKey = '';
const cabinKnots = () => { const v = selectedVehicle; if (v?.kind !== 'plane') return 0; const h = planes.stateOf(v.airport, v.flight); return h ? planeKnots(h.s.type, planeSpeed(v.airport, v.flight)) : 0; };
/** A manifest row was clicked: sit in that seat (the cabin view from it), or (the same row again) go back to the cockpit. */
function selectSeat(seatLabel: string, who: string) {
  const v = selectedVehicle;
  if (v?.kind !== 'plane') return;
  const same = v.seat === seatLabel;
  selectedVehicle = { kind: 'plane', airport: v.airport, flight: v.flight, ...(same ? {} : { seat: seatLabel, who }) };
  cabinKey = same ? '' : `${vehicleKey(v)}#${seatLabel}`;
  fpv.retarget();
  showPlanePanel();
}
/** where the follow camera looks for the selected vehicle */
function vehiclePos(): [number, number] | null {
  const v = selectedVehicle;
  if (v?.kind === 'train') { const st = trains.stateOf(v.line, v.train); const c = st && trains.cabOf(v.line, v.train); return c ? [c.x, c.z] : null; }
  if (v?.kind === 'plane') { const hit = planes.stateOf(v.airport, v.flight); return hit ? [hit.s.x, hit.s.z] : null; }
  if (v?.kind === 'heli') { const s = helis.stateOf(v.flight); return s ? [s.x, s.z] : null; }
  if (v?.kind === 'boat') { const s = boats.stateOf(v.id); return s ? [s.x, s.z] : null; }
  return null;
}

// ---- dev tools (only with ?dev; the server ignores them unless it is a non-production server) ----------
const devPanel = DEV_TOOLS ? (() => {
  const chip = document.createElement('button');
  chip.className = 'chip'; chip.id = 'devBtn'; chip.textContent = 'dev'; chip.title = 'Testing tools (only on a dev server)';
  document.getElementById('techBtn')!.before(chip);
  const box = document.createElement('div');
  box.id = 'devPanel'; box.className = 'hidden';
  box.innerHTML = `<div class="devhead">Dev tools <span>testing only</span></div>
    <label class="devrow"><input type="checkbox" id="devUnlimited"> Unlimited funds</label>
    <button class="chip" id="devMoney">+ $100,000</button>
    <button class="chip" id="devTech">Unlock all tech</button>
    <div class="devnote">Tech locks are already skipped for building while ?dev is on; unlocking makes the tech tree, growth tiers and patrols match.</div>`;
  document.getElementById('ui')!.appendChild(box);
  chip.onclick = () => { box.classList.toggle('hidden'); chip.classList.toggle('on', !box.classList.contains('hidden')); };
  const unl = box.querySelector<HTMLInputElement>('#devUnlimited')!;
  unl.onchange = () => net.send({ t: 'dev', action: 'unlimited', on: unl.checked });
  box.querySelector<HTMLButtonElement>('#devMoney')!.onclick = () => net.send({ t: 'dev', action: 'money' });
  box.querySelector<HTMLButtonElement>('#devTech')!.onclick = () => net.send({ t: 'dev', action: 'tech' });
  return { sync: (on: boolean) => { unl.checked = on; chip.classList.toggle('warn', on); } };
})() : null;

document.getElementById('light')!.onclick = () => {
  if (lighting.mode === 'live') { lighting.mode = 'fixed'; lighting.fixedHour = 15.5; } else lighting.mode = 'live';
  ui.setLightMode(lighting.mode, lighting.fixedHour);
};
ui.setLightMode(lighting.mode, lighting.fixedHour);

// ---- selected building: people panel ------------------------------------------------------------
/** Placeholder shown for the instant before the server answers the first full inspect. */
const PENDING_INFO = (x: number, y: number, t: number): BuildingInfo => ({ x, y, kind: kindIdOf(zoneOf(t), world.subAt(x, y)), level: levelOf(t), capacity: 0, occupants: 0 });
function refreshBuilding() { if (selectedBuilding && net.connected) net.send({ t: 'inspect', x: selectedBuilding[0], y: selectedBuilding[1], full: true }); }
setInterval(refreshBuilding, 2000);
function closeBuilding(refresh = true) {
  if (!selectedBuilding) return;
  selectedBuilding = null;
  ui.hideBuilding();
  if (refresh) { selectedParcel = 0; world.parcelsDirty = true; refreshPanel(); }
}

/** The parcel panel (the land's tax and name; on a frontier "<name>'s charter") closes: its ✕ or Esc. */
function closeParcel() { selectedParcel = 0; world.parcelsDirty = true; refreshPanel(); }

function refreshPanel() {
  if (selectedBuilding) return;
  const p = world.parcels.get(selectedParcel);
  if (!p) { ui.hideParcel(); selectedParcel = 0; panelShown = 0; return; }
  ui.showParcel(p, world.players.get(p.owner), world.mayEdit(p.owner));
  if (panelShown !== p.id) { panelShown = p.id; net.send({ t: 'sites', id: p.id }); }
}

/** The server's land purchase rules run on whatever chunks are loaded here; unloaded tiles read as unclaimed. */
let buyMemo: { key: string; at: number; v: ReturnType<typeof checkPurchase> } | null = null;
function buyVerdict(r: Rect) {
  const k = `${r.x},${r.y},${r.w},${r.h}`, now = performance.now();
  if (buyMemo && buyMemo.key === k && now - buyMemo.at < 200) return buyMemo.v;
  const owned: LandRect[] = [];
  for (const q of world.parcels.values()) if (q.owner === world.me) owned.push(q);
  const v = world.sandbox ? { ok: true as const } : checkPurchase(r, world.me, { // a sandbox has no border or islanding rules
    owned,
    ownerAt: (x, y) => world.parcelAt(x, y)?.owner ?? null,
    isWater: (x, y) => { const t = world.getTile(x, y); return t !== undefined && terrainOf(t) === Terrain.Water; },
    ownerName: (id) => world.players.get(id)?.name ?? id,
  });
  buyMemo = { key: k, at: now, v };
  return v;
}

/**
 * Where the hover highlight goes: the planned footprint while a multi-tile tool is active (with the server's
 * placement verdict, worked out on the loaded chunks), the whole structure under the cursor, else the tile.
 */
let placeMemo: { key: string; kind: number; at: number; v: PlaceVerdict } | null = null;
/** the tiles as the road rule tools read them (shared/src/junctions.ts junctionArmAt) */
const ruleEnv = { road: (x: number, y: number) => { const t = world.getTile(x, y); return t !== undefined && isRoad(t); }, aux: (x: number, y: number) => world.auxAt(x, y) };
/** A zoning tool over land with no road on any side (797ee40a): such a lot builds only when the building in front grows back into it. */
const NO_ROAD_LOT = 'no road beside this lot: it stays empty until the building in front of it grows back into it (two storeys: Masonry and power) or a road reaches it';
function zoneNoRoad(x: number, y: number): boolean {
  if (!(input.tool in ZONE_TOOLS)) return false;
  const t = world.getTile(x, y);
  if (t === undefined || isRoad(t) || terrainOf(t) === Terrain.Water) return false;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = world.getTile(x + dx, y + dy); if (n === undefined || (isRoad(n) && terrainOf(n) !== Terrain.Water)) return false; }
  return true;
}
function hoverArea(h: [number, number]): { x: number; y: number; w: number; h: number; verdict?: PlaceVerdict; placed?: Placed; existing?: boolean; warn?: boolean } {
  const kind = structureTool(input.tool);
  if (kind) {
    const rot = input.rotationOf(input.tool);
    const key = `${kind}:${h[0]},${h[1]}:${rot}`, now = performance.now();
    if (!placeMemo || placeMemo.key !== key || now - placeMemo.at > 200) {
      const draft = !!kindManifest(kind)?.draft;
      placeMemo = { key, kind, at: now, v: planStructure(kind, h[0], h[1], {
        tile: (x, y) => world.getTile(x, y),
        aux: (x, y) => world.auxAt(x, y),
        sub: (x, y) => world.subAt(x, y),
        land: (x, y) => { const p = world.parcelAt(x, y); if (p ? world.mayEdit(p.owner) : draft && DEV_TOOLS) return null; return p ? 'Not your land' : 'Buy this land first'; },
      }, rot) };
    }
    let v = placeMemo.v;
    const p = v.placed;
    if (v.ok && isMetroStationKind(kind)) { // the surface allows it; the platform under it must too
      const pp = platformAt(kind, h, p, rot);
      if (!pp.ok) v = { ok: false, reason: pp.reason ?? 'No room for a platform', placed: p };
    }
    return p ? { x: p.ax, y: p.ay, w: p.w, h: p.h, verdict: v, placed: p } : { x: h[0], y: h[1], w: 1, h: 1, verdict: v };
  }
  if (isJunctionTool(input.tool)) return junctionTools.hoverArea(input.tool, h);
  if (input.tool === 'streetrule') return { x: h[0], y: h[1], w: 1, h: 1, verdict: { ok: true } as PlaceVerdict }; // the street's ghost is streetrules.ts's
  if (input.tool === 'runway') {
    const v = runwayVerdict(input.runwayLine ?? [h]);
    const r = v.rect;
    return r ? { x: r.x, y: r.y, w: r.w, h: r.h, verdict: v.ok ? { ok: true } as PlaceVerdict : { ok: false, reason: v.reason ?? '' } } : { x: h[0], y: h[1], w: 1, h: 1, verdict: { ok: false, reason: v.reason ?? '' } };
  }
  const s = world.structureAt(h[0], h[1]);
  return s ? { x: s.ax, y: s.ay, w: s.w, h: s.h, placed: s, existing: true } : { x: h[0], y: h[1], w: 1, h: 1, warn: zoneNoRoad(h[0], h[1]) };
}
/** The server's runway rules on the loaded chunks: snap onto a terminal's runway row, check the strip. */
let runwayMemo: { key: string; at: number; v: RunwayPlan } | null = null;
function runwayVerdict(line: [number, number][]): RunwayPlan {
  const key = line.length ? `${line[0]}|${line[line.length - 1]}` : '', now = performance.now();
  if (runwayMemo && runwayMemo.key === key && now - runwayMemo.at < 200) return runwayMemo.v;
  const v = planRunway(line, {
    tile: (x, y) => world.getTile(x, y),
    aux: (x, y) => world.auxAt(x, y),
    sub: (x, y) => world.subAt(x, y),
    land: (x, y) => { const p = world.parcelAt(x, y); return p ? (world.mayEdit(p.owner) ? null : 'Not your land') : 'Buy this land first'; },
  });
  runwayMemo = { key, at: now, v };
  return v;
}

function updateStatus() {
  const h = input.hover;
  // the Turn rules tool's ghost: the sign the next click would put up on the hovered arm (render/junctionSigns.ts)
  const arm = input.tool === 'turnrule' && h ? junctionArmAt(ruleEnv, h[0], h[1]) : null;
  if (arm && typeof arm !== 'string') junctions.signs.preview(arm.g, arm.arm, nextArmState(armState(world.ruleAt(arm.g.x, arm.g.y), arm.arm)));
  else junctions.signs.preview(null, 0, null);
  if (!h) { ui.setStatus(''); return; }
  const [x, y] = h;
  const t = world.getTile(x, y);
  let s = `(${x}, ${y})`;
  if (t !== undefined) {
    const terr = terrainOf(t);
    const k = world.kindIdAt(x, y), l = levelOf(t);
    if (isRoad(t)) { const v = world.trafficAt(x, y); s += ` · road${v > 10 ? ` · traffic ${Math.round((100 * v) / 255)}%` : ''}`; }
    else if (k) s += ` · ${KIND_NAMES[k]}${l ? (isCivicId(k) || stopModeOf(k) ? '' : ` L${l}`) : ' (empty lot)'}${underConstruction(t) ? ' · under construction' : ''}`;
    else s += ' · ' + (terr === Terrain.Water ? 'water' : terr === Terrain.Sand ? 'sand' : 'grass');
    const p = world.parcelAt(x, y);
    s += p ? ` · ${p.name} (${world.players.get(p.owner)?.name ?? p.owner}, tax ${Math.round(p.taxRate * 100)}%)` : ' · unclaimed land';
    const v = structureTool(input.tool) ? hoverArea(h).verdict : undefined;
    if (v) {
      const rot = input.rotationOf(input.tool), r = v.placed?.r;
      const facing = r === undefined ? '' : ` · door faces ${FRONT_NAMES[r]} (${rot === undefined ? 'auto' : 'chosen'}; Z/C turn)`;
      s += v.ok ? ` · click to place${facing}` : ` · ${v.reason}${facing}`;
    }
    if (input.tool === 'rail') s += rail.status(input.railPath);
    if (input.tool === 'pylons' || input.tool === 'cable') s += power.status(input.tool, input.railPath);
    else if (isRoad(t) && (power.overlayOn || structureTool(input.tool))) s += power.roadStatus(x, y);
    if (input.tool === 'road') s += input.roadPath ? roadTool.status(input.roadPath, input.roadShape) : terr === Terrain.Water && !isRoad(t) ? ' · drag a road straight across from a road on the bank to bridge the water' : roadTool.status(null, 'line');
    if (isJunctionTool(input.tool)) s += junctionTools.status(input.tool, x, y);
    if (input.tool === 'streetrule') s += streetRules.status(h, input.streetPath, input.streetNs);
    if (zoneNoRoad(x, y)) s += ` · ${NO_ROAD_LOT}`;
    if (input.tool === 'runway') {
      const rv = runwayVerdict(input.runwayLine ?? [h]);
      s += input.runwayLine
        ? (rv.ok ? ` · runway ${rv.s1! - rv.s0! + 1} tiles, $${rv.cost} · release to lay it` : ` · ${rv.reason}`)
        : ' · drag a straight line of 10+ tiles, 5 tiles behind an airport terminal';
    }
  }
  if (input.buyRect) {
    const r = input.buyRect, verdict = buyVerdict(r);
    s = `${r.w}×${r.h} tiles = $${(r.w * r.h * LAND_PRICE_PER_TILE).toLocaleString()}`;
    if (!verdict.ok) s += ` · ${verdict.reason}`;
    else if (world.myPlayer?.fin?.admin !== undefined) s += ' · in administration';
    else if (world.myPlayer && spendableMoney(world.myPlayer.money, world.myPlayer.devUnlimited) < r.w * r.h * LAND_PRICE_PER_TILE) s += ' · not enough money, even with the overdraft';
  }
  ui.setStatus(s);
}

// ---- tooltips: people and vehicles first, then buildings and roads, all answered live by the server ----
ui.nameOf = (x, y) => { const s = world.structureAt(x, y); return buildings.nameAt(s ? s.ax : x, s ? s.ay : y); }; // the name on its front (signs.ts)
let tipTimer = 0;
let tipRefresh = 0;
let tipTile: [number, number] | null = null;
let tipAgent = 0;
let mouse = { x: 0, y: 0 };
canvas.addEventListener('pointermove', (e) => { mouse = { x: e.clientX, y: e.clientY }; if (tipTile || tipAgent || tipTrain || tipPlane || tipHeli !== null || tipBoat !== null) ui.moveTip(mouse.x, mouse.y); });
/** the pointing-hand cursor over something a click would open (cursors.ts): set where the hover resolves, so it costs nothing per frame */
let pickHint = false;
function hintPickable(on: boolean) { if (on !== pickHint) { pickHint = on; applyPickHint(canvas.classList, input.tool, on); } }
function hoverAt(tile: [number, number] | null) {
  lines.setHover(tile); // while a line is edited the stop under the cursor glows (render/stopmarks.ts)
  if (ctxMenu.isOpen) return; // the right-click menu is up: no tooltips under it
  boats.hover = null;
  const bt = tile && input.tool === 'select' && !input.buyRect ? boats.pick(mouse.x, mouse.y, rig.camera, canvas.clientWidth, canvas.clientHeight) : null; // boats: lowest of the vehicles
  if (bt === null && tipBoat !== null) { tipBoat = null; ui.hideTip(); }
  const id = tile && input.tool === 'select' && !input.buyRect ? citizens.pick(mouse.x, mouse.y, rig.camera, canvas.clientWidth, canvas.clientHeight) : 0;
  if (id) { hintPickable(true); hoverAgent(id); return; }
  if (tipAgent) { tipAgent = 0; ui.hideTip(); }
  // an issue badge floating over a roof answers for its building (render/issues.ts)
  const badge = tile && input.tool === 'select' && !input.buyRect ? issuesView.pick(mouse.x, mouse.y, rig.camera, canvas.clientWidth, canvas.clientHeight) : null;
  if (badge) { hintPickable(true); hoverBadge(badge); return; }
  // trains (render/trains.ts): picked from the vehicles drawn last frame, answered by the server (sim/rail.ts)
  const tr = tile && input.tool === 'select' && !input.buyRect ? trains.pick(mouse.x, mouse.y, rig.camera, canvas.clientWidth, canvas.clientHeight) : null;
  if (tr) { hintPickable(true); hoverTrain(tr); return; }
  if (tipTrain) { tipTrain = null; trains.hover = null; clearInterval(tipRefresh); ui.hideTip(); }
  // planes: the tooltip is worked out here from the flight (vehicles.ts)
  const pl = tile && input.tool === 'select' && !input.buyRect ? planes.pick(mouse.x, mouse.y, rig.camera, canvas.clientWidth, canvas.clientHeight) : null;
  if (pl) { hintPickable(true); hoverPlane(pl); return; }
  if (tipPlane) { tipPlane = null; planes.hover = null; ui.hideTip(); }
  // helicopters (render/helicopters.ts): worked out here from the flight, like planes
  const hl = tile && input.tool === 'select' && !input.buyRect ? helis.pick(mouse.x, mouse.y, rig.camera, canvas.clientWidth, canvas.clientHeight) : null;
  if (hl !== null) { hintPickable(true); hoverHeli(hl); return; }
  if (tipHeli !== null) { tipHeli = null; helis.hover = null; ui.hideTip(); }
  if (bt !== null) { hintPickable(true); hoverBoat(bt); return; }
  const th = tile ? world.getTile(tile[0], tile[1]) : undefined;
  hintPickable(th !== undefined && zoneOf(th) !== 0 && !isRoad(th)); // a building: a click opens it
  hoverTile(tile);
}
let tipBoat: number | null = null;
function hoverBoat(id: number) {
  clearTimeout(tipTimer); clearInterval(tipRefresh);
  tipTile = null; tipAgent = 0; tipTrain = null; trains.hover = null; tipPlane = null; planes.hover = null; tipHeli = null; helis.hover = null; tipBoat = id;
  boats.hover = id;
  const s = boats.stateOf(id);
  if (!s) { ui.hideTip(); return; }
  ui.showHtmlTip(boatTipHtml(s, boats.harbourOf(s.harbour), boats.lastTick, { ferry: boats.ferryOf(s.id) }));
  ui.moveTip(mouse.x, mouse.y);
}
let tipHeli: number | null = null;
function hoverHeli(flight: number) {
  clearTimeout(tipTimer); clearInterval(tipRefresh);
  tipTile = null; tipAgent = 0; tipTrain = null; trains.hover = null; tipPlane = null; planes.hover = null; tipHeli = flight;
  helis.hover = flight;
  const s = helis.stateOf(flight);
  if (!s) { ui.hideTip(); return; }
  ui.showHtmlTip(heliTipHtml(s));
  ui.moveTip(mouse.x, mouse.y);
}
let tipTrain: { line: number; train: number } | null = null;
let tipPlane: { airport: number; flight: number } | null = null;
function hoverPlane(pl: { airport: number; flight: number }) {
  clearTimeout(tipTimer); clearInterval(tipRefresh);
  tipTile = null; tipAgent = 0; tipTrain = null; trains.hover = null; tipPlane = pl; tipHeli = null; helis.hover = null;
  planes.hover = `${pl.airport}:${pl.flight}`;
  const hit = planes.stateOf(pl.airport, pl.flight);
  if (!hit) { ui.hideTip(); return; }
  ui.showHtmlTip(planeTipHtml(hit.s, manifestOf(pl.airport, hit.s.flight)));
  ui.moveTip(mouse.x, mouse.y);
}
function hoverTrain(tr: { line: number; train: number }) {
  if (tipTrain && tipTrain.line === tr.line && tipTrain.train === tr.train) return;
  clearTimeout(tipTimer); clearInterval(tipRefresh);
  tipTile = null; tipAgent = 0; tipTrain = tr; tipPlane = null; planes.hover = null; tipHeli = null; helis.hover = null;
  trains.hover = tr;
  ui.hideTip();
  tipTimer = window.setTimeout(() => net.send({ t: 'inspectTrain', line: tr.line, train: tr.train }), 80);
  tipRefresh = window.setInterval(() => { if (tipTrain) net.send({ t: 'inspectTrain', line: tipTrain.line, train: tipTrain.train }); }, 1000);
}
net.on('train', (m) => {
  const v = selectedVehicle;
  if (v?.kind === 'train' && m.line === v.line && m.train === v.train) {
    if (!m.info) { selectVehicle(null); ui.toast('info', 'That train has gone out of service'); }
    else if (m.info.riders || m.info.consignments) { trainInfo = m.info; showTrainPanel(); } // a full answer (a hover's lacks the roster)
  }
  if (!tipTrain || m.line !== tipTrain.line || m.train !== tipTrain.train) return;
  if (!m.info) { ui.hideTip(); return; }
  ui.showHtmlTip(trainHtml(m.info, trains.consistOf(m.line, m.train), trains.lines.find((l) => l.id === m.line)?.name));
  ui.moveTip(mouse.x, mouse.y);
});
function hoverAgent(id: number) {
  if (tipTrain || tipPlane || tipHeli !== null) { tipTrain = null; tipPlane = null; tipHeli = null; trains.hover = null; planes.hover = null; helis.hover = null; }
  if (id === tipAgent) return;
  clearTimeout(tipTimer); clearInterval(tipRefresh);
  tipTile = null; tipAgent = id;
  ui.hideTip();
  tipTimer = window.setTimeout(() => net.send({ t: 'inspectCitizen', id }), 80);
  tipRefresh = window.setInterval(() => { if (tipAgent) net.send({ t: 'inspectCitizen', id: tipAgent }); }, 1000);
}
/** Hover a building by its badge: as the tile would, dropping any vehicle's tooltip first. */
function hoverBadge(tile: [number, number]) {
  if (tipTrain) { tipTrain = null; trains.hover = null; clearInterval(tipRefresh); ui.hideTip(); }
  if (tipPlane) { tipPlane = null; planes.hover = null; ui.hideTip(); }
  if (tipHeli !== null) { tipHeli = null; helis.hover = null; ui.hideTip(); }
  if (tipBoat !== null) { tipBoat = null; ui.hideTip(); }
  hoverTile(tile);
}
function hoverTile(tile: [number, number] | null) {
  if (tile) tile = world.doorOf(tile[0], tile[1]); // every tile of a structure shows the structure
  if (tile && !input.buyRect && input.tool === 'select' && isAirfieldAux(world.auxAt(tile[0], tile[1]))) {
    // runway and taxiway tiles: answered here from the loaded tiles, the same derivation the server runs
    clearTimeout(tipTimer); clearInterval(tipRefresh);
    tipTile = tile;
    const p = world.parcelAt(tile[0], tile[1]);
    ui.showRunwayTip(airfield.linkAt(tile[0], tile[1], world), p ? `${p.name} · ${world.players.get(p.owner)?.name ?? p.owner}` : 'unclaimed land');
    ui.moveTip(mouse.x, mouse.y);
    return;
  }
  if (tile && !input.buyRect && input.tool === 'select' && isRailAux(world.auxAt(tile[0], tile[1]))) {
    // railway track: answered here from the loaded tiles and the lines the server sent
    clearTimeout(tipTimer); clearInterval(tipRefresh);
    tipTile = tile;
    const p = world.parcelAt(tile[0], tile[1]);
    const html = rail.tileTip(tile[0], tile[1], p ? `${p.name} · ${world.players.get(p.owner)?.name ?? p.owner}` : 'unclaimed land');
    if (html) { ui.showHtmlTip(html); ui.moveTip(mouse.x, mouse.y); }
    return;
  }
  const t = tile ? world.getTile(tile[0], tile[1]) : undefined;
  const interesting = t !== undefined && (zoneOf(t) !== 0 || isRoad(t));
  if (!tile || !interesting || input.buyRect) { clearTimeout(tipTimer); clearInterval(tipRefresh); tipTile = null; ui.hideTip(); return; }
  if (tipTile && tipTile[0] === tile[0] && tipTile[1] === tile[1]) return;
  clearTimeout(tipTimer); clearInterval(tipRefresh);
  tipTile = tile;
  ui.hideTip();
  tipTimer = window.setTimeout(() => net.send({ t: 'inspect', x: tile[0], y: tile[1] }), 120);
  tipRefresh = window.setInterval(() => { if (tipTile) net.send({ t: 'inspect', x: tipTile[0], y: tipTile[1] }); }, 1500);
}
// agents move under a still cursor, so re-check the pick a few times a second
setInterval(() => { if (input.hover && !input.buyRect && !input.painting && !input.roadPath) hoverAt(input.hover); }, 250);
net.on('building', (m) => {
  if (m.info?.people && selectedBuilding && m.x === selectedBuilding[0] && m.y === selectedBuilding[1]) ui.showBuilding(m.info, selectedCitizen);
  else if (!m.info && selectedBuilding && m.x === selectedBuilding[0] && m.y === selectedBuilding[1]) closeBuilding();
  if (tipAgent || !tipTile || m.x !== tipTile[0] || m.y !== tipTile[1]) return;
  if (!m.info) { ui.hideTip(); return; }
  ui.showTip(m.info);
  const code = world.issueAt(m.x, m.y); // its problem line under the stats (problems.ts)
  if (code) document.getElementById('tip')!.insertAdjacentHTML('beforeend', issueTipHtml(code, problems.glyph(code), problems.whyAt(m.x, m.y)));
  ui.moveTip(mouse.x, mouse.y);
});
net.on('road', (m) => {
  if (tipAgent || !tipTile || m.x !== tipTile[0] || m.y !== tipTile[1]) return;
  if (!m.info) { ui.hideTip(); return; }
  ui.showRoadTip(m.info, world.ruleAt(m.x, m.y)?.st ?? 0, whyAt(m.x, m.y));
  ui.moveTip(mouse.x, mouse.y);
});

// ---- frame loop --------------------------------------------------------------------------------
const getTile = (x: number, y: number) => world.getTile(x, y);
const auxAt = (x: number, y: number) => world.auxAt(x, y);
let last = performance.now();
let vehTick = 0, vehAt = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  perf.frame(now);
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); // a first rAF stamp can be older than the module's clock
  last = now;
  if (canvas.clientWidth !== sized.w || canvas.clientHeight !== sized.h) resize(); // the window changed, or was not laid out at the first resize
  input.update(dt);
  tour?.frame(dt); // the tour's camera flight, before the rig places the camera
  moment.frame(); // the first-settlers moment's flight (moment.ts)
  flyFrame(now); // a problem's show-me flight
  mapMode.frameCamera(dt);
  rig.update();
  perf.lap('input');
  // zooming out past the 3D limit opens the map; zooming in below the map's returns to 3D
  if (!mapMode.on && rig.overZoom > 0.3 && !tour?.flying) mapMode.set(true);
  else if (mapMode.on && rig.underZoom > 0.15) mapMode.set(false);
  if (mapMode.on) { mapMode.frame(now); renderer.render(mapMode.view.scene, rig.camera); perf.lap('render'); return; }
  adaptQuality(dt);

  underground.frame(dt, renderer);
  lighting.update(liveHour(), rig.target, rig.dist);
  underground.look(lighting, renderer);
  scene.background = lighting.sky;
  const fog = scene.fog as Fog;
  fog.color.copy(lighting.sky);
  // fog thickens with zoom-out, but never reaches past the loaded chunks when looking toward the horizon
  fog.far = fogFar();
  fog.near = Math.min(rig.dist * 1.6 + 30, fog.far * 0.45);
  perf.lap('light');

  chunkWork.frame(rig.camera, rig.target, dt * 1000);
  perf.lap('chunks');
  if (airfield.update(world)) planes.setAirports(airfield.airports());
  if (eduDirty && eduHeat.on) { eduHeat.rebuild(world.parcels.values()); eduDirty = false; }
  if (world.parcelsDirty) { parcelsView.rebuild(world.parcels.values(), world.players, world.me, selectedParcel); world.parcelsDirty = false; }
  applyTrafficUpdates();
  if (roadsOverlay && ++roadsOverlayFrames % 30 === 0) paintRoadClasses(); // new chunks and changed classes, twice a second
  overlayMap.update(world.overlayDirty, (k) => world.overlay.get(k));
  issuesView.group.visible = fpv.mode !== 'full' && underground.level < 0.5; // not in first person or the underground view (the map has its own scene)
  issuesView.frame(now, rig.camera);
  firesView.group.visible = underground.level < 0.5;
  firesView.frame(liveTickF());
  buildings.rotors.frame(liveTickF(), [rig.camera], underground.level < 0.5);
  buildings.wheels.frame([rig.camera], underground.level < 0.5); // the funfairs' Ferris wheels (render/wheels.ts)
  buildings.anims.frame([rig.camera], underground.level < 0.5); // the leisure places' moving parts (render/leisureAnims.ts)
  buildings.ambient.frame([rig.camera], underground.level < 0.5); // chimney smoke and the cranes' jibs (render/ambient.ts)
  gravesView.group.visible = underground.level < 0.5;
  gravesView.frame(liveTick(), now);
  perf.lap('world');
  citizens.frame(now, dt);
  lines.stopMarks.setShown(fpv.mode !== 'full');
  lines.frame();
  if (routeView.active) routeView.frame(citizens.positionOf(selectedCitizen), now);
  lights.frame(liveTick(), signalled);
  perf.lap('agents');
  // trains and planes run on a tick that follows the server's but never steps back or jumps when a stats message lands,
  // so a cab view along the track stays perfectly smooth
  const live = liveTickF(), rdt = ((now - vehAt) / TICK_MS) * clock.rate;
  vehAt = now;
  vehTick = Math.abs(live - vehTick) > 4 ? live : vehTick + rdt + (live - vehTick) * Math.min(1, dt * 1.5);
  planes.frame(vehTick);
  helis.frame(vehTick);
  if (boatMock && !boats.real) { const hs = boatMock.update(world, now); if (hs) boats.setHarbours(hs); }
  boats.cabView = fpv.mode !== 'off';
  boats.frame(vehTick);
  const riding = fpv.tunnelOn ? 1 : 0; // a tube cab ride shows the trains and the platform crowds without the underground view
  trains.level = Math.max(underground.level, riding); citizens.underLevel = Math.max(underground.level, riding);
  trains.frame(vehTick);
  rail.frame(input.tool === 'rail' ? input.railPath : null);
  roadTool.frame(input.tool === 'road' ? input.roadPath : null, rig.camera, canvas.clientWidth, canvas.clientHeight);
  streetRules.frame(input.tool === 'streetrule', input.hover, input.streetPath, input.streetNs, rig.camera, canvas.clientWidth, canvas.clientHeight);
  power.frame(now, input.tool, input.railPath);
  airfield.frame();
  parks.frame(clock.day);
  landmarks.frame((vehTick * 24) / TICKS_PER_DAY);
  if (fireworks.active) fireworks.frame(dt);
  bridges.frame(landmarks.fixedHours ?? (vehTick * 24) / TICKS_PER_DAY); // Tower Bridge's gates, on the lift schedule the leaves keep
  fpv.update(now, dt, routeInfo?.id === selectedCitizen ? routeInfo.route ?? null : null);
  perf.lap('vehicles');
  audio.frame(now); // the ambient mix every 250 ms and the ridden vehicle's sound every 100 (audio/)
  perf.lap('audio');
  if ((following || fpv.mode === 'full') && selectedCitizen) {
    const pos = citizens.positionOf(selectedCitizen);
    if (pos) { rig.target.x += (pos[0] - rig.target.x) * Math.min(1, dt * 6); rig.target.z += (pos[1] - rig.target.z) * Math.min(1, dt * 6); }
  }
  if ((following || fpv.mode === 'full') && selectedVehicle) {
    const pos = vehiclePos();
    if (pos) { rig.target.x += (pos[0] - rig.target.x) * Math.min(1, dt * 6); rig.target.z += (pos[1] - rig.target.z) * Math.min(1, dt * 6); }
  }

  const h = input.hover;
  hoverMesh.visible = !!h && !input.buyRect && !input.roadPath; // a road drag shows its own ghost
  if (h) {
    const area = hoverArea(h);
    hoverMesh.scale.set(area.w, 1, area.h);
    hoverMesh.position.set(area.x + area.w / 2, 0.04, area.y + area.h / 2);
    const hm = hoverMesh.material as MeshBasicMaterial;
    hm.color.setHex(area.verdict ? (area.verdict.ok ? 0x62d2a2 : 0xff3b30) : area.warn ? 0xffb020 : 0xffffff);
    hm.opacity = area.verdict ? (area.verdict.ok ? 0.45 : 0.6) : area.warn ? 0.5 : 0.22; // a refusal must read as red over grass; a lot with no road beside it amber
    // outline, door arrow and marks: full strength for a footprint being placed, faint over a structure that stands
    if (area.placed && !input.buyRect) {
      const p = area.placed, ahead = world.getTile(p.frontX, p.frontY);
      footprint.show(p, { ok: area.existing ? null : area.verdict?.ok ?? false, road: ahead !== undefined && isRoad(ahead), faint: !!area.existing, hover: h });
    } else footprint.hide();
  } else footprint.hide();
  footprint.frame(rig.camera, canvas.clientWidth, canvas.clientHeight);
  { // a metro station tool: the planned platform under the door, green when it fits
    const mk = structureTool(input.tool);
    if (h && isMetroStationKind(mk)) { const area = hoverArea(h), pp = platformAt(mk, h, area.placed, input.rotationOf(input.tool)); underground.setPreview(pp.stop as StationStop, pp.ok && area.verdict?.ok !== false); }
    else underground.setPreview(null);
  }
  const r = input.buyRect;
  rectMesh.visible = !!r;
  if (r) {
    rectMesh.scale.set(r.w, 1, r.h);
    rectMesh.position.set(r.x + r.w / 2, 0.05, r.y + r.h / 2);
    const me = world.myPlayer;
    const okBuy = !!me && me.fin?.admin === undefined && spendableMoney(me.money, me.devUnlimited) >= r.w * r.h * LAND_PRICE_PER_TILE && buyVerdict(r).ok;
    const rm = rectMesh.material as MeshBasicMaterial;
    rm.color.setHex(okBuy ? 0x62d2a2 : 0xff3b30);
    rm.opacity = okBuy ? 0.35 : 0.6; // a refused rectangle must read as red, not brown, over grass
    updateStatus();
  }
  // the live TV feed's camera (render/tv.ts): asked for by a set on screen in the FPV, or by a big screen near the camera
  perf.lap('hover');
  const feedCam = tv.prepare(fpv.mode !== 'full' && rig.dist < 90 && buildings.adverts.bigScreenNear(rig.target.x, rig.target.z, 40));
  const cams = fpv.mode === 'off' ? [rig.camera] : [rig.camera, fpv.camera];
  if (feedCam) cams.push(feedCam);
  buildings.updateLod(cams, lighting.sun); // detail tiers and culling (render/buildings.ts)
  roads.frame(cams, signalled); // road geometry near the cameras, its furniture, the lamp map (render/roads.ts)
  perf.lap('lod');
  const overheadOnly = [hoverMesh, rectMesh, footprint.group, routeView.group, parcelsView.group, issuesView.group, roadTool.group, streetRules.group];
  // the feed leaves out what is under a pixel at 160×90 from the helicopter: people, parked cars, signal heads
  tv.render(renderer, scene, [...overheadOnly, citizens.group, parked.group, junctions.group]);
  fpv.render(renderer, scene, rig.camera, overheadOnly);
  perf.lap('render');
}
requestAnimationFrame(frame);

// debugging hook: inspect client state from the devtools console
(window as any).msc = { power, tv, tvDebug, adPanel, moment, fireworks, ranks, mapMode, metroMeta, ferryMeta, viewString: () => rig.shotString(lighting.mode === 'fixed' ? lighting.fixedHour : undefined), underground, setUnder, lines, world, rig, input, net, views, lighting, buildings, landmarks, bridges, citizens, lights, roads, liveTick, liveTickF, planes, helis, boats, boatMock, airfield, trains, rail, renderer, scene, streamChunks, streamWindow, subscribed, ui, selectCitizen, selectVehicle, vehicle: () => selectedVehicle, setHeat, routeView, routeInfo: () => routeInfo, setEduHeat, fpv, issuesView, firesView, gravesView, openDeceased, problems, overlayMenu, overlayMap, trafficPanel, streetRules, selectTile, policies, junctions, state: () => ({ selectedParcel, panelShown, selectedCitizen, following, subscribed: subscribed.size }) };
void localIndex;

// ---- boot -------------------------------------------------------------------------------------------
ui.setConn(false);
// a local game that just replaced itself (load, import, new game) reloads straight back in; otherwise ?name= or the join form
const rejoin = local && (() => { try { const r = sessionStorage.getItem(AUTOJOIN); sessionStorage.removeItem(AUTOJOIN); return r ? localStorage.getItem('msimcity.name') : null; } catch { return null; } })();
// a read-only showcase has nothing to own, so a visitor joins at once under a made-up name
const autoName = params.get('name') || rejoin || (showcase.spectate ? `Visitor ${1000 + Math.floor(Math.random() * 9000)}` : null);
// test cities (worlds.ts): `?ws=host:port&city=n` connects to one, `?city=n` alone starts it first; the perf readout (M, or the top-bar chip) is always on there
const cityParam = testCityOf(params);
const viaWs = !!params.get('ws');
const hud = document.getElementById('worldHud')!;
/** the server's /api/perf for this world (docs/perf.md): a demo or test city through its parent (?demo=, ?city=), a direct ?ws= server at its own origin; none in local mode */
const perfUrl = () => {
  if (local) return null;
  if (viaWs) return `http://${params.get('ws')}/api/perf`;
  return `${apiBase()}/api/perf${demoParam ? `?demo=${demoParam}` : cityParam ? `?city=${cityParam}` : ''}`;
};
const perf = new PerfHud({ net, renderer, agentsDrawn: () => citizens.count, chunksLoaded: () => views.size, audio: () => audio.stats, perfUrl, chunks: () => ({ marks: world.dirtyStats.marks, rebuilds: chunkWork.stats.count, rebuildMs: chunkWork.stats.totalMs, pending: chunkWork.pending }) }, hud, document.getElementById('perfBtn'), { forceOn: cityParam > 0 });
/** Sound (audio/, docs/audio.md): what the client already knows, read every 250 ms; nothing starts before the first click or key */
const rideNow = (): RideNow | null => {
  if (fpv.mode === 'off') return null;
  if (selectedVehicle) {
    const c = cabEye();
    if (!c) return null;
    const k = selectedVehicle.kind;
    return { key: c.key, kind: k === 'train' ? (c.tunnel ? 'metro' : 'train') : k, x: c.x, z: c.z, doors: c.interior?.doors };
  }
  // a passenger's seat: the bus's, train's or tube train's ride, keyed as the vehicle so its own pass-by never plays
  const pr = fpv.passengerRide;
  if (pr) return { key: pr.key, kind: pr.kind, x: pr.x, z: pr.z, doors: pr.doors };
  const a = selectedCitizen ? citizens.agents.get(selectedCitizen) : undefined;
  if (!a || !a.car) return null; // on foot: the city's own sound
  return { key: `c${selectedCitizen}`, kind: a.cls === VehicleClass.Bus ? 'bus' : a.cls === VehicleClass.Truck ? 'truck' : 'car', x: a.rx, z: a.rz };
};
/** the light as the player had it before a tour stop pinned an hour (TourPanel setHour); declared here because the ambience reads it */
let tourLight: { mode: typeof lighting.mode; hour: number } | null = null;
const audio = new Audio({
  ambience: {
    // the sound keeps the hour the eye is shown: a tour stop that pins the light (the Lights at night, a dusk cemetery) pins the beds and the birds to it too
    hour: () => (tourLight ? lighting.fixedHour : liveHour()),
    hourSource: () => (tourLight ? 'pinned light (a tour stop sets the hour)' : 'clock'),
    camera: () => { const e = rig.camera.matrixWorld.elements; return { x: rig.target.x, z: rig.target.z, dist: rig.dist, map: mapMode.on, rightX: e[0], rightZ: e[2] }; },
    tileAt: (x, y) => world.getTile(x, y),
    kindIdAt: (x, y) => world.kindIdAt(x, y),
    agents: () => citizens.agents.values(),
    eachAgent: (f) => citizens.agents.forEach(f), // the street-life layer (audio/street.ts) hears each vehicle by its id, in the scan's own walk
    pelican: (x, z, r) => lights.redPelicanNear(x, z, r, liveTick()),
    city: () => (params.get('ws') ?? params.get('demo') ?? params.get('city') ?? location.host), // a district bed's take is a hash of it
  },
  fpv: { riding: rideNow },
  notice: (t) => ui.notice(t),
});
ui.onSound = (id) => audio.ui(id);
/** the audio readout (audio/readout.ts, docs/audio.md "Readout"): the audio chip and Shift+S; reads the engine twice a second while open, nothing while closed */
const audioReadout = new AudioReadout(audio, hud, document.getElementById('audioBtn'));
bindReadoutKey(window, () => audioReadout.toggle());
fireworks.onShell = (x, z, at, size) => audio.firework(x, z, at, size);
// the funfairs' fireworks night (render/wheels.ts): a show over each fair in range on its Saturday evening
buildings.wheels.clock = () => ({ day: Math.floor(liveTick() / TICKS_PER_DAY), hour: liveHour() });
firesView.placement = (x, y) => buildings.placementAt(x, y); // the fires burn at the windows of the building drawn (render/fires.ts)
buildings.wheels.onShow = (x, y, seed) => fireworks.show(x, y, 1.5, seed);
Object.assign((window as any).msc, { perf, lines, audio, audioReadout });
/** the chunk rebuild scheduler (render/chunkWork.ts); setLegacy(true) brings back the old invalidation and loop for paired measurements */
(window as any).msc.chunkWork = Object.assign(chunkWork, {
  setLegacy(on: boolean) { chunkWork.legacy = on; world.legacyDirty = on; if (junctions.legacySigns !== on) { junctions.legacySigns = on; if (!on) junctions.signs.rebuild(); } },
});
/** the chunk rebuild accounting over a window: dirty marks a second by cause (and the tiles the messages carried, and changed), rebuilds a second, their cost by pass */
(window as any).msc.chunkStats = {
  rebuilds: (s = 30) => chunkWork.stats.summary(s),
  watch: async (seconds = 30) => {
    const st = world.dirtyStats, snap = () => JSON.parse(JSON.stringify({ marks: st.marks, sets: st.sets, tiles: st.tiles, changed: st.changed }));
    const a = snap(), roads0 = roads.buildCount(), t0 = performance.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const b = snap(), dt = (performance.now() - t0) / 1000, r2 = (v: number) => Math.round(v * 100) / 100;
    const rate = (k: 'marks' | 'sets' | 'tiles' | 'changed') => Object.fromEntries(DIRTY_CAUSES.map((c) => [c, r2((b[k][c] - a[k][c]) / dt)]));
    return { seconds: r2(dt), marksPerSecond: rate('marks'), setsPerSecond: rate('sets'), tilesPerSecond: rate('tiles'), changedPerSecond: rate('changed'), roadBuildsPerSecond: r2((roads.buildCount() - roads0) / dt), rebuilds: chunkWork.stats.summary(seconds) };
  },
};
const localUi = local ? mountLocalUi(local, (kind, msg) => ui.toast(kind, msg), () => world.myPlayer?.name ?? localStorage.getItem('msimcity.name') ?? 'Mayor') : null;
if (local) {
  (window as any).msc.local = local;
  void local.pause(true); // the city waits behind the join form
  document.querySelector('#help a')?.setAttribute('href', 'viewer.html'); // relative: the static build can live under any path
  if (__LOCAL_ONLY__) registerServiceWorker((kind, msg) => ui.toast(kind, msg));
}
if (cityParam) { showCityBanner(cityParam, params, hud); reviveCity(cityParam, net); }
if (demoParam) {
  setLandmarkSpans(demoLandmarkSpans(demoParam)); // the Brooklyn Bridge and the Golden Gate over their spans (render/bridges.ts)
  showDemoBanner(demoParam, params, hud, !!showcase.spectate, !showcase.defaultDemo);
  reviveDemo(demoParam, net);
  tour = new TourPanel({
    demo: demoParam, net, rig, scene, buildingHtml: (info) => ui.buildingHtml(info, 'h3'),
    chipMount: document.getElementById('techBtn')!, onFly: () => { following = false; }, setUnder: (on) => setUnder(on), setMap: (on) => mapMode.set(on, false),
    celebrate: (x, y) => ranks.preview(x, y),
    sound: (st, settle) => { if (st) audio.tourStop(st.id, st.sound, settle); else audio.tourEnd(); },
    watchTv: (r) => watchTv(r),
    setTrafficView: (on) => { overlayMenu.set(on ? 'traffic' : 'off'); trafficPanel.toggle(on); },
    // a stop shown at an hour of its own (the Piccadilly Lights at night): the light is pinned there, and given back after
    setHour: (h) => {
      if (h === null) {
        if (tourLight) { lighting.mode = tourLight.mode; lighting.fixedHour = tourLight.hour; tourLight = null; ui.setLightMode(lighting.mode, lighting.fixedHour); }
        return;
      }
      tourLight ??= { mode: lighting.mode, hour: lighting.fixedHour };
      lighting.mode = 'fixed'; lighting.fixedHour = h; ui.setLightMode(lighting.mode, lighting.fixedHour);
    },
  });
  (window as any).msc.tour = tour;
}
/**
 * A showcase visitor joins without the form, so the join card says what it is waiting for instead (a demo's first fill
 * takes minutes); returns the demo-start progress callback.
 */
function waitingCard() {
  const form = document.getElementById('loginForm')!;
  form.querySelector('p')!.textContent = 'A read-only showcase: look around, follow anyone, take the guided tour.';
  for (const el of form.querySelectorAll<HTMLElement>('#nameInput, #worlds')) el.style.display = 'none';
  const b = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const what = demoParam ? DEMO_BY_ID.get(demoParam)?.name ?? 'the demo' : 'the city';
  b.disabled = true; b.textContent = `Opening ${what}…`;
  return (d: DemoInfo | null) => { b.textContent = d?.status === 'starting' && d.fill !== undefined ? `Building ${what}… ${Math.round(d.fill * 100)}%` : `Opening ${what}…`; };
}
async function connect(name: string) {
  if (local) { net.connect(name); void local.pause(false); return; }
  const progress = showcase.spectate ? waitingCard() : undefined;
  if (demoParam && !viaWs && !(await startDemo(demoParam, progress))) { ui.toast('error', 'The demo did not start'); return; }
  if (cityParam && !viaWs) { // ?city=n alone: bring the city up, then point the socket at it
    ui.toast('info', `Starting test city ${cityParam}×${cityParam}…`);
    if (!(await startCity(cityParam))) { ui.toast('error', 'The test city did not start'); return; }
    net.url = `ws://${cityWsHost(cityParam)}`;
  }
  net.connect(name);
}
/**
 * Sign-in (docs/accounts.md): a server whose /api/config has `auth` asks for it before its live world; demos, test cities, `?ws=`
 * servers and local mode never do. The card shows Hanko's sign-in; once signed in the page connects with the session token and the
 * name last used, and the server either welcomes the account's mayor or asks (an `auth` message) for a name or a fresh sign-in.
 */
const signIn = showcase.auth && !local && !viaWs && !demoParam && !cityParam ? new SignIn(showcase.auth, document.getElementById('loginForm')!) : null;
async function signedJoin(s: SignIn) {
  (window as any).msc.signOut = () => s.signOut();
  const form = document.getElementById('loginForm') as HTMLFormElement, input = document.getElementById('nameInput') as HTMLInputElement;
  document.getElementById('worlds')?.classList.add('hidden'); // the live world only: demos and test cities have their own links
  let name = params.get('name') || localStorage.getItem('msimcity.name') || '';
  input.value = name;
  net.on('auth', (m) => {
    if (m.need === 'name') return s.askName(m.msg);
    void s.signIn(m.msg ?? 'Please sign in again.').then(() => net.hello(name));
  });
  form.onsubmit = (e) => { // the name step: a new account's mayor, said on the open socket
    e.preventDefault();
    const n = input.value.trim();
    if (!n) return;
    name = n;
    localStorage.setItem('msimcity.name', n);
    net.hello(n);
  };
  await s.signIn();
  net.connect(name, s.token);
}
if (params.has('map')) mapMode.set(true); // ?map opens on the world map
if (signIn) void signedJoin(signIn);
else if (autoName) void connect(autoName);
else {
  const picker = viaWs || demoParam || local ? null : new WorldPicker(document.getElementById('worlds')!, cityParam || remembered());
  const form = document.getElementById('loginForm')!;
  if (local && localUi) void localLogin(local, form, localUi.dialog, !__LOCAL_ONLY__);
  else if (!viaWs && !demoParam && !cityParam) addPlayOffline(form);
  ui.login().then((name) => {
    if (picker?.selected) void picker.join(name, document.querySelector<HTMLButtonElement>('#loginForm button[type=submit]')!);
    else if (picker) net.connect(name); // the live world, whatever ?city= said
    else void connect(name);
  });
}
