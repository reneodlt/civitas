// The free-time places' first-person scenes (docs/leisure.md, render/leisureRooms.ts, render/rooms/*): every outing and park
// activity has a scene, the activity lines map to them, and each scene builds by day and by night, with and without family,
// with an eye where it should be, a line to show, no more people than the crowd holds and a bounded number of meshes; a
// moving eye moves; the Ferris wheel's lowest gondola clears the ground; a park offers the ducks only where it has water.
// Run: npx tsx packages/client/scripts/leisure-check.ts
import {
  VENUE_TYPES, VENUE_TEXT, PARK_ACTIVITY_TEXT, FERRIS, MANIFEST, leisureAt, leisureSpecs, parkActivity, parkHasWater, LifeStage,
  type CitizenInfo, type LeisureSpec,
} from '@msimcity/shared';
import { Mesh, Color, Vector3, type Object3D } from 'three';

// a canvas that draws nothing (the people's and TV's textures ask for one)
const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 6 }) : () => {}), set: () => true });
Object.assign(globalThis, { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } });
const { Interior, placeOf, leisureRoomOf, EXTRA_ROOMS } = await import('../src/render/interiors');
await import('../src/render/leisureRooms');

let fails = 0;
const ok = (cond: boolean, what: string) => { if (!cond) { fails++; console.log('FAIL', what); } else console.log('ok  ', what); };
const ORIGINAL = new Set(['park', 'cinema', 'theatre', 'sports', 'library']);
const NEW_TYPES = VENUE_TYPES.filter((t) => !ORIGINAL.has(t));
const PARK = Object.keys(PARK_ACTIVITY_TEXT);
/** a free-time place's kind id by its outing, for the made-up venue */
const kindOf = (t: string) => MANIFEST.find((k) => k.family === 'leisure' && k.attrs.venueType === t)?.kindId ?? 10;

// ---- every outing and park activity has a scene, and its words lead there ---------------------------------------------------
{
  const missing = [...NEW_TYPES, ...PARK, 'band'].filter((r) => !EXTRA_ROOMS[r as keyof typeof EXTRA_ROOMS]);
  ok(!missing.length, `a scene for every new outing and park activity (${NEW_TYPES.length + PARK.length + 1}${missing.length ? `; missing ${missing.join(', ')}` : ''})`);
  const wrong: string[] = [];
  for (const t of NEW_TYPES) for (const line of [VENUE_TEXT[t].at, VENUE_TEXT[t].event]) if (leisureRoomOf(line) !== t) wrong.push(`"${line}"`);
  for (const [a, line] of Object.entries(PARK_ACTIVITY_TEXT)) if (leisureRoomOf(line) !== a) wrong.push(`"${line}"`);
  if (leisureRoomOf(VENUE_TEXT.park.event) !== 'band') wrong.push('the band');
  ok(!wrong.length, `every activity line names its scene${wrong.length ? `; not: ${wrong.join(', ')}` : ''}`);
  const lines = new Map<string, string>();
  for (const t of VENUE_TYPES) for (const line of [VENUE_TEXT[t].at, VENUE_TEXT[t].going]) { if (lines.has(line) && lines.get(line) !== t) wrong.push(line); lines.set(line, t); }
  ok(!wrong.length, 'no two outings share an activity line');
}

// ---- each scene builds, by day and by night, alone and with family ------------------------------------------------------------
const info = (act: string, kind: number, family: boolean): CitizenInfo => ({
  id: 4242, name: 'Check', role: 'citizen', mode: 'none', activity: act, status: 'idle', waitTicks: 0,
  home: { x: 3, y: 5, label: 'home', parcel: '' }, venue: { x: 11, y: 7, kind },
  life: { age: 34, stage: 'adult', household: { id: 9, members: family ? [
    { id: 4243, name: 'Kid', age: 9, relation: 'child', activity: act },
    { id: 4244, name: 'Partner', age: 36, relation: 'partner', activity: act },
    { id: 4245, name: 'Gran', age: 70, relation: 'parent', activity: 'at home' },
  ] : [] } },
} as unknown as CitizenInfo);
const rooms = [...NEW_TYPES.map((t) => [t, VENUE_TEXT[t].at, kindOf(t)] as const), ...Object.entries(PARK_ACTIVITY_TEXT).map(([a, l]) => [a, l, 10] as const), ['band', VENUE_TEXT.park.event, 10] as const];
const stats: string[] = [];
for (const [room, line, kind] of rooms) {
  if (!EXTRA_ROOMS[room as keyof typeof EXTRA_ROOMS]) continue;
  for (const hour of [13, 23]) for (const family of [false, true]) {
    const tag = `${room} at ${hour}:00${family ? ' with family' : ''}`;
    try {
      const ci = info(line, kind, family), place = placeOf(ci, hour);
      if (!place || place.room !== room) { ok(false, `${tag}: the line leads to it (${place?.room})`); continue; }
      const it = new Interior(place, ci, hour);
      const sky = new Color(hour === 13 ? 0x9ac4ee : 0x0a1020);
      it.update(1000, 0.5, hour, sky);
      const eye0 = it.camera.position.clone();
      for (let f = 1; f < 6; f++) it.update(1000 + f * 600, 0.6, hour, sky);
      const p = it.camera.position, k = (it as unknown as { k: { bodies: unknown[] } }).k;
      let meshes = 0;
      it.scene.traverse((o: Object3D) => { if ((o as Mesh).isMesh) meshes++; });
      const fine = [p.x, p.y, p.z].every(Number.isFinite) && p.length() < (room === 'funfair' ? 80 : 60);
      const bad: string[] = [];
      if (!fine) bad.push(`eye at ${p.toArray().map((v) => v.toFixed(1)).join(', ')}`);
      if (!it.label) bad.push('no line');
      if (k.bodies.length > 64) bad.push(`${k.bodies.length} people (the crowd holds 64)`);
      if (meshes > 650) bad.push(`${meshes} meshes`);
      if (bad.length) ok(false, `${tag}: ${bad.join('; ')}`);
      if (hour === 13 && !family) stats.push(`${room.padEnd(12)} "${it.label}", ${k.bodies.length} people, ${meshes} meshes${eye0.distanceTo(p) > 0.03 ? ', the eye moves' : ''}`);
      it.dispose();
    } catch (e) {
      ok(false, `${tag}: threw ${(e as Error).message}`);
    }
  }
}
ok(stats.length > 0, `scenes built by day and night, alone and with family (${stats.length} scenes)`);
for (const s of stats) console.log('     ', s);

// ---- the wheel and the park --------------------------------------------------------------------------------------------------
ok(FERRIS.hubY - FERRIS.r - FERRIS.hang >= 0.02, `the lowest gondola clears the ground (${(FERRIS.hubY - FERRIS.r - FERRIS.hang).toFixed(2)} tiles)`);
{
  const parks = leisureSpecs(10, 1).concat(leisureSpecs(10, 2), leisureSpecs(10, 3), leisureSpecs(59, 1)).filter(Boolean) as LeisureSpec[];
  let wrongDucks = 0, ducks = 0, picnicsAtNight = 0;
  for (const s of parks) for (let id = 1; id < 400; id++) for (const hour of [10, 13, 21]) {
    const a = parkActivity(s, id, id * 37, hour, id % 3 === 0 ? LifeStage.Child : LifeStage.Adult);
    if (a.id === 'ducks') { ducks++; if (!parkHasWater(s)) wrongDucks++; }
    if (a.id === 'picnic' && hour === 21) picnicsAtNight++;
  }
  ok(ducks > 0 && wrongDucks === 0, `the ducks only where a park has water (${ducks} visits feed them, ${wrongDucks} at a dry park)`);
  ok(picnicsAtNight === 0, 'no picnics after dark');
  ok(!!leisureAt(10, 1, 0, 0), 'a pocket park is still a park');
}

void Vector3;
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
