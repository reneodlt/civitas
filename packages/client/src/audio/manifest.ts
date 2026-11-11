import { CLIPS } from './credits';

/**
 * The voice manifest (docs/audio.md): every sound the game makes, by id, with the numbers it is synthesised from.
 * voices.ts reads its ranges from here, so a voice is tuned by editing a row. A row with recordings (`takes`, wired at the foot of this
 * file from credits.ts, the table scripts/audio-build.ts writes) plays one of them instead of the synthesis: the engine fetches the
 * Opus files the first time the voice is wanted (looped for a bed, once for an event, with the same per-instance variation: pitch,
 * gain, start point, a choice among the takes), and the synthesis plays until they have decoded. A missing or undecodable file leaves
 * the synthesis. A voice with `synth: false` (the second pass) has only its recording and is silent without it.
 */
export type BusId = 'ambience' | 'vehicles' | 'ui';

export interface VoiceDef {
  id: string;
  bus: BusId;
  /** bed: runs all the time at a level the state sets; event: fired, once, at a moment */
  kind: 'bed' | 'event';
  /** what it is made of */
  made: string;
  /** what drives it */
  driven: string;
  /** synthesis numbers: frequencies in Hz, times in seconds, depths 0..1 */
  params: Record<string, number>;
  /** false: there is no synthesis, only a recording (the second-pass voices) */
  synth?: false;
  /** the first recording, a file name under audio/files/ (see voiceFile): set from credits.ts */
  file?: string;
  /** every take of the recording (events vary between them), set from credits.ts */
  takes?: string[];
  /** the playback level of the recordings (they are normalised per class; this is the per-voice trim), set from credits.ts */
  level?: number;
  /** who recorded each take: { freesound id, title, author } per file, set from credits.ts */
  source?: Record<string, { freesound: number; title: string; author: string }>;
}

/** The conventional file name of a voice's first recording: put the Opus file in packages/client/src/audio/files/ (urls.ts serves it in every build). */
export const voiceFile = (id: string, take = 1) => `${id}${take > 1 ? `-${take}` : ''}.opus`;

const def = (d: VoiceDef): [string, VoiceDef] => [d.id, d];
/** a second-pass voice: a recording and nothing else, so its row only says what it is and when it plays */
const clip = (id: string, bus: BusId, kind: 'bed' | 'event', made: string, driven: string, gain = 1): [string, VoiceDef] =>
  def({ id, bus, kind, made: `a Freesound CC0 recording: ${made}`, driven, params: { gain }, synth: false });

export const VOICES: Record<string, VoiceDef> = Object.fromEntries([
  // ---- ambience beds
  def({ id: 'traffic', bus: 'ambience', kind: 'bed', made: 'brown noise through a low-pass, with a slow swell', driven: 'cars drawn round the camera (level, cutoff), zoom',
    params: { lpMin: 140, lpMax: 720, q: 0.7, swellHz: 0.17, swell: 0.25 } }),
  def({ id: 'wind', bus: 'ambience', kind: 'bed', made: 'pink noise through a band-pass whose centre drifts', driven: 'camera height (zoom distance)',
    params: { bpMin: 280, bpMax: 1100, q: 0.5, driftHz: 0.07, drift: 0.22 } }),
  def({ id: 'crowd', bus: 'ambience', kind: 'bed', made: 'pink noise through a band-pass, amplitude-modulated by two slow oscillators', driven: 'walkers drawn near the camera, shops and offices round it, the hour',
    params: { bpMin: 520, bpMax: 1150, q: 1.1, amHz: 0.4, amDepth: 0.35, amHz2: 1.7, amDepth2: 0.12 } }),
  def({ id: 'industry', bus: 'ambience', kind: 'bed', made: 'two detuned low saws and a harmonic through a resonant low-pass', driven: 'industrial and power tiles round the camera, the hour',
    params: { f0: 52, detune: 7, lpMin: 170, lpMax: 430, q: 7 } }),
  def({ id: 'water', bus: 'ambience', kind: 'bed', made: 'pink noise through a low-pass with a slow swell', driven: 'water tiles round the camera',
    params: { lpMin: 450, lpMax: 1800, swellHz: 0.12, swell: 0.4 } }),
  // ---- ambience events
  def({ id: 'bird', bus: 'ambience', kind: 'event', made: 'a frequency-modulated sine chirping two to five syllables, each syllable its own pitch and sweep', driven: 'a Poisson clock: the hour (dawn chorus 04:30 to 07:00), parks and homes round the camera',
    params: { fMin: 2200, fMax: 4800, sylMin: 2, sylMax: 5, fm: 0.12, gain: 0.05 } }),
  def({ id: 'owl', bus: 'ambience', kind: 'event', made: 'two low sine hoots with a little vibrato through a low-pass', driven: 'a Poisson clock: night, parks and homes round the camera',
    params: { f: 330, vib: 5, gain: 0.1 } }),
  def({ id: 'bell', bus: 'ambience', kind: 'event', made: 'a bell: five inharmonic sine partials with their own decays, struck once per hour (up to six times)', driven: 'the hour, when a churchyard is within the view',
    params: { f0: 330, decay: 3.4, gain: 0.07 } }),
  def({ id: 'bell-deep', bus: 'ambience', kind: 'event', made: 'the same bell an octave and a half lower with a long decay', driven: 'the hour, when the Houses of Parliament are within the view',
    params: { f0: 164, decay: 6.5, gain: 0.1 } }),
  def({ id: 'horn', bus: 'ambience', kind: 'event', made: 'two detuned square waves a major third apart through a low-pass', driven: 'a car passing close to the camera (street.ts): one in 25, one in 10 at a junction',
    params: { f: 410, ratio: 1.26, detune: 0.012, gain: 0.035 } }),
  def({ id: 'beep', bus: 'ambience', kind: 'event', made: 'short 2 kHz sine pulses', driven: 'a signal crossing near the camera while it shows the walkers green and holds the cars at red',
    params: { f: 2000, pulse: 0.09, gap: 0.09, gain: 0.05 } }),
  // ---- user interface
  def({ id: 'ui-click', bus: 'ui', kind: 'event', made: 'a 6 ms noise tick and a short sine', driven: 'picking a tool', params: { f: 1500, len: 0.04, gain: 0.1 } }),
  def({ id: 'ui-place', bus: 'ui', kind: 'event', made: 'a sine thud falling from 150 to 60 Hz with a noise tick', driven: 'placing a building, a road or a zone', params: { f: 150, len: 0.14, gain: 0.2 } }),
  def({ id: 'ui-refuse', bus: 'ui', kind: 'event', made: 'two falling triangle notes', driven: 'a refusal (an error toast)', params: { f: 230, len: 0.2, gain: 0.12 } }),
  def({ id: 'ui-undo', bus: 'ui', kind: 'event', made: 'a rising sine sweep', driven: 'undoing a road drag', params: { f: 520, len: 0.1, gain: 0.1 } }),
  // ---- first person: the ridden vehicle (bus 'vehicles')
  def({ id: 'veh-car', bus: 'vehicles', kind: 'bed', made: 'a saw and a sub triangle through a low-pass, pulsed by a firing tremor, over road rumble', driven: 'the car\'s speed (pitch, cutoff, tremor rate)',
    params: { f0: 56, f1: 150, lpMin: 330, lpMax: 1500, tremor: 24, depth: 0.25, rumble: 0.5 } }),
  def({ id: 'veh-truck', bus: 'vehicles', kind: 'bed', made: 'as the car, lower, with a slower tremor and more rumble', driven: 'speed',
    params: { f0: 42, f1: 112, lpMin: 260, lpMax: 1100, tremor: 14, depth: 0.4, rumble: 0.7 } }),
  def({ id: 'veh-bus', bus: 'vehicles', kind: 'bed', made: 'a diesel: a low saw and sub with a deep slow rattle tremor over a heavy rumble', driven: 'speed',
    params: { f0: 36, f1: 92, lpMin: 220, lpMax: 900, tremor: 10, depth: 0.6, rumble: 0.9 } }),
  def({ id: 'veh-train', bus: 'vehicles', kind: 'bed', made: 'a rising traction whine (two triangles a fifth apart) over a smooth rail rumble and wheel hiss', driven: 'speed',
    params: { whine0: 180, whine1: 900, rumble: 0.8, hiss: 0.08 } }),
  def({ id: 'veh-metro', bus: 'vehicles', kind: 'bed', made: 'a higher, louder whine over a tunnel boom (a resonant band-pass on brown noise)', driven: 'speed',
    params: { whine0: 320, whine1: 1250, rumble: 0.7, boom: 160 } }),
  def({ id: 'veh-boat', bus: 'vehicles', kind: 'bed', made: 'a low saw chugging at 4 to 10 Hz through a low-pass, over water lap', driven: 'speed',
    params: { f: 46, chug0: 4, chug1: 10, lap: 0.3 } }),
  def({ id: 'veh-plane', bus: 'vehicles', kind: 'bed', made: 'white noise through a band-pass that opens with speed, over a low saw', driven: 'speed',
    params: { bp0: 400, bp1: 2000, f0: 70, f1: 150 } }),
  def({ id: 'veh-heli', bus: 'vehicles', kind: 'bed', made: 'pink noise chopped at 14 to 20 Hz over a low saw', driven: 'speed',
    params: { chop0: 14, chop1: 20, f: 85 } }),
  def({ id: 'fx-hiss', bus: 'vehicles', kind: 'event', made: 'high-passed noise with a rise and a fall', driven: 'a bus or train opening its doors', params: { len: 0.7, gain: 0.12 } }),
  def({ id: 'fx-stopbell', bus: 'vehicles', kind: 'event', made: 'one short bell-like ding (two partials)', driven: 'a bus pulling away from a stop', params: { f: 1180, len: 0.5, gain: 0.08 } }),
  def({ id: 'fx-chime', bus: 'vehicles', kind: 'event', made: 'two sine notes, a fourth apart', driven: 'a train closing its doors', params: { f: 740, len: 0.45, gain: 0.07 } }),
  def({ id: 'fx-joint', bus: 'vehicles', kind: 'event', made: 'two band-passed noise clacks a bogie apart', driven: 'a train\'s speed (joints per second)', params: { f: 900, gap: 0.09, gain: 0.1 } }),
  // ---- the second pass: recordings only (no synthesis). Weather: Ambience.setWeather(rain, wind, storm) is its hook (render/weather.ts)
  clip('rain-light', 'ambience', 'bed', 'light rain on pavement', 'the weather hook (Ambience.setWeather), rain under 0.6'),
  clip('rain-heavy', 'ambience', 'bed', 'a downpour', 'the weather hook, rain over 0.4 (the two cross-fade)'),
  clip('market', 'ambience', 'bed', 'a street market', 'shops and offices round the camera, by day, close in'),
  clip('pub', 'ambience', 'bed', 'pub murmur', 'shops round the camera, from late afternoon to closing, close in'),
  clip('playground', 'ambience', 'bed', 'children playing', 'a nursery or school in the view, in school hours, close in'),
  clip('stadium', 'ambience', 'bed', 'a stadium crowd', 'a stadium (or Camp Nou, the Maracana) in the view, afternoon and evening, close in'),
  clip('fountain', 'ambience', 'bed', 'splashing water', 'the Trevi Fountain in the view, close in'),
  clip('gust', 'ambience', 'event', 'a gust of wind', 'a Poisson clock that grows as the camera rises'),
  clip('thunder', 'ambience', 'event', 'distant thunder', 'the weather hook, while a storm is on'),
  clip('footsteps', 'ambience', 'event', 'shoes on pavement', 'walkers drawn within 8 tiles of the camera (street.ts), one voice a side: the odd step for one walker, steady for six'),
  clip('siren', 'ambience', 'event', 'a UK two-tone police siren', 'a police station in the view: a rare call, scaled by distance (a patrol never reports a call, so this stays), not while a vehicle\'s siren is followed'),
  clip('siren-fire', 'ambience', 'event', 'a fire engine siren', 'a fire station in the view: a call at a tenth of its old rate (the fire engines carry their own sirens now, siren-fire-loop), not while a vehicle\'s siren is followed'),
  clip('seagulls', 'ambience', 'event', 'gulls calling', 'a Poisson clock: water round the camera, by day'),
  clip('pigeons', 'ambience', 'event', 'pigeons cooing', 'a Poisson clock: parks and shops round the camera, by day'),
  clip('dog', 'ambience', 'event', 'a dog barking', 'a Poisson clock: homes round the camera, morning to evening'),
  clip('bell-peal', 'ambience', 'event', 'a peal of church bells', 'the 10:00 and 18:00 hours, when a churchyard is in the view (instead of the strikes)'),
  clip('bike-bell', 'ambience', 'event', 'a bicycle bell', 'a Poisson clock: walkers on the streets near the camera, by day'),
  clip('bin-lorry', 'ambience', 'event', 'a bin lorry', 'a Poisson clock: homes round the camera, 06:00 to 10:00'),
  clip('station-chime', 'ambience', 'event', 'an announcement chime', 'a Poisson clock: shops close in, or a train station in the view (hook)'),
  clip('heli-over', 'ambience', 'event', 'a helicopter passing overhead', 'a rare Poisson clock when the camera is high and it is day'),
  clip('plane-over', 'ambience', 'event', 'a jet passing overhead', 'a rare Poisson clock when the camera is high'),
  clip('boat-horn', 'ambience', 'event', 'a ship horn', 'a Poisson clock: water round the camera'),
  clip('fireworks', 'ambience', 'event', 'a firework bang and crackle', 'Audio.firework(): the fireworks system (render/fireworks.ts) calls it for every shell, with its distance'),
  clip('hammer', 'ambience', 'event', 'hammering', 'builders\' depots and construction companies in the view, by day'),
  clip('drill', 'ambience', 'event', 'a power drill', 'builders\' depots and construction companies in the view, by day'),
  clip('lawnmower', 'ambience', 'event', 'a lawnmower', 'a rare Poisson clock: homes round the camera, mid-morning to late afternoon'),
  // ---- the districts (docs/audio.md "Districts"): a recorded bed for each kind of street, chosen by a soft-max over the zone shares, and the events that go with it
  clip('zone-ind', 'ambience', 'bed', 'a factory floor and an industrial estate: machinery hum, a yard', 'industrial tiles winning the soft-max over the zone shares, by day more than at night, close in'),
  clip('zone-com', 'ambience', 'bed', 'a shopping street and cafe chatter', 'shops winning the soft-max over the zone shares, from morning to late evening, close in'),
  clip('zone-off', 'ambience', 'bed', 'an empty office: air handling and a quiet lobby', 'offices winning the soft-max over the zone shares, working hours, down to a fifth after 19:00, close in'),
  clip('zone-res', 'ambience', 'bed', 'a quiet residential street in daylight, no people', 'homes winning the soft-max over the zone shares, quieter at night, close in'),
  clip('zone-civic', 'ambience', 'bed', 'a museum hall and a plaza: a crowd murmuring', 'civic, cultural and landmark tiles winning the soft-max over the zone shares, by day, close in'),
  clip('metal-clank', 'ambience', 'event', 'a hammer on an anvil and a steel sheet', 'a Poisson clock while industry wins, working hours, close in'),
  clip('reverse-beep', 'ambience', 'event', 'a lorry reversing, beeping', 'a Poisson clock while industry wins, working hours, close in'),
  clip('steam-vent', 'ambience', 'event', 'steam venting', 'a Poisson clock while industry wins, close in'),
  clip('till', 'ambience', 'event', 'a cash register opening', 'a Poisson clock while shops win, shop hours, close in'),
  clip('busker', 'ambience', 'event', 'a street musician: a saxophone, an accordion', 'a rare Poisson clock while shops win and the street is busy, 10:00 to 20:30'),
  clip('music-door', 'ambience', 'event', 'music leaking through a shop door (low-passed at build)', 'a Poisson clock while shops win, 10:00 to midnight, close in'),
  clip('revolving-door', 'ambience', 'event', 'a revolving door and an automatic door', 'a Poisson clock while offices win, working hours, close in'),
  clip('lift-ding', 'ambience', 'event', 'a lift arriving: its bell', 'a Poisson clock while offices win, working hours, close in'),
  clip('radio-window', 'ambience', 'event', 'a radio through a window (low-passed at build)', 'a rare Poisson clock while homes win, 08:00 to 22:00, close in'),
  clip('front-door', 'ambience', 'event', 'a front door closing', 'a Poisson clock while homes win, 07:00 to 22:30, close in'),
  clip('kids-yard', 'ambience', 'event', 'children playing outside', 'a Poisson clock while homes win, 08:00 to 19:00, close in'),
  clip('camera-shutter', 'ambience', 'event', 'a camera shutter, tourists', 'a Poisson clock while civic or landmark tiles win, 09:00 to 19:30, one to three shots, close in'),
  // ---- street life (docs/audio.md "Street life", street.ts): what the vehicles and walkers drawn round the camera sound like, one by one
  clip('pass-car', 'ambience', 'event', 'a car passing close (the window round its pass)', 'a car, taxi or van drawn crossing within the pass-by radius of the camera at street zoom (a van and a taxi play it lower); panned along its path, its pitch bent down as it passes'),
  clip('pass-lorry', 'ambience', 'event', 'a lorry passing, diesel', 'a lorry, bin lorry, sweeper or fire engine drawn crossing within the pass-by radius'),
  clip('pass-moped', 'ambience', 'event', 'a small motorbike or scooter passing', 'a delivery moped drawn crossing within the pass-by radius'),
  clip('pass-bike', 'ambience', 'event', 'a bicycle freewheeling past', 'a delivery bicycle drawn crossing within the pass-by radius (and its bell one time in four)'),
  clip('talk', 'ambience', 'event', 'passers-by talking', 'fifteen or more walkers per 15-tile circle round the camera, by day, close in'),
  clip('siren-loop', 'ambience', 'bed', 'a police siren, cut to whole cycles so it loops', 'an emergency vehicle on a call (a patrol, should one ever carry the flag) within 70 tiles: follows it, louder as it nears, panned from it, its pitch up coming and down going'),
  clip('siren-fire-loop', 'ambience', 'bed', 'a fire engine siren, cut to whole cycles so it loops', 'a fire engine on a call within 70 tiles: follows it'),
  clip('siren-ambulance-loop', 'ambience', 'bed', 'an ambulance siren, cut to whole cycles so it loops', 'an ambulance on a call within 70 tiles: follows it'),
  // ---- the tour cues: recordings only the tour asks for, by name (shared/src/demo/tourSound.ts); the ambient mix never plays them
  clip('big-ben', 'ambience', 'event', 'the Westminster chimes and the hour strike of a great clock tower', 'a tour cue: Big Ben and Parliament, and the far chime from the London Eye'),
  clip('bus-pass', 'ambience', 'event', 'a bus passing in the street', 'a tour cue: the bus lanes, bus lines, depots and the big junctions'),
  clip('tube-arrive', 'ambience', 'event', 'an Underground train arriving at a platform', 'a tour cue: the Tube stops (underground, and faint from the street above)'),
  clip('tube-gap', 'ambience', 'event', 'a platform announcement', 'a tour cue: the Tube stops, after the doors'),
  clip('train-pass', 'ambience', 'event', 'a train passing a station or a line-side', 'a tour cue: rail stations, tracks, lines and the freight yards'),
  clip('boat-pass', 'ambience', 'event', 'a motor boat passing on a river', 'a tour cue: the Thames stops, piers and the docks'),
  clip('port', 'ambience', 'event', 'dock machinery: a crane, chains and a clang', 'a tour cue: the docks, the freight yards, the power works'),
  clip('crowd-roar', 'ambience', 'event', 'a stadium crowd roaring', 'a tour cue: the stadiums and the O2'),
  clip('whistle', 'ambience', 'event', 'a referee\'s whistle', 'a tour cue: the stadiums and the sports halls'),
  clip('jet-takeoff', 'ambience', 'event', 'a jet taking off', 'a tour cue: Heathrow'),
  clip('shop-bell', 'ambience', 'event', 'a shop door bell', 'a tour cue: the West End, Camden and Brixton'),
  clip('ducks', 'ambience', 'event', 'ducks quacking', 'a tour cue: the park lakes and the marinas'),
  clip('applause', 'ambience', 'event', 'an audience applauding', 'a tour cue: the theatres, concert halls and cricket'),
  clip('orchestra', 'ambience', 'event', 'an orchestra tuning up', 'a tour cue: the Royal Opera House and the Royal Albert Hall'),
  clip('siren-ambulance', 'ambience', 'event', 'an ambulance siren', 'a tour cue: the hospitals'),
  clip('school-bell', 'ambience', 'event', 'a school bell', 'a tour cue: the schools and the Natural History Museum'),
  clip('crows', 'ambience', 'event', 'crows and rooks calling', 'a tour cue: the Tower of London and the cemeteries'),
  clip('fox', 'ambience', 'event', 'a fox screaming at night', 'a tour cue: night stops in parks and gardens'),
  clip('rigging', 'ambience', 'event', 'rigging and halyards clinking at a mooring', 'a tour cue: the marinas and the fish quay'),
  clip('bridge-bell', 'ambience', 'event', 'a warning bell', 'a tour cue: Tower Bridge and the showcase\'s bascule bridge and level crossing'),
  clip('parakeets', 'ambience', 'event', 'parakeets squawking', 'a tour cue: Kew Gardens'),
  clip('station-hall', 'ambience', 'bed', 'a busy railway station hall', 'a tour cue, looped for the stop: the rail termini'),
  clip('tube-hall', 'ambience', 'bed', 'an Underground station and tunnel', 'a tour cue, looped for the stop: the Tube stops'),
  clip('flare-roar', 'ambience', 'bed', 'a gas burner roaring', 'a tour cue, looped for the stop: Beckton Gas Works'),
]);

// ---- the recordings, from credits.ts (written by scripts/audio-build.ts): wired onto the rows here, once
for (const c of CLIPS) {
  const v = VOICES[c.voice];
  if (!v) continue;
  (v.takes ??= []).push(c.file);
  v.file ??= c.file;
  v.level = c.level;
  (v.source ??= {})[c.file] = { freesound: c.freesound, title: c.title, author: c.author };
}
