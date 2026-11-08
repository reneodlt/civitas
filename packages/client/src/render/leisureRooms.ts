import { EXTRA_ROOMS } from './interiors';
import { PARK_ROOMS } from './rooms/parkRooms';
import { OUTDOOR_ROOMS } from './rooms/outdoorRooms';
import { INDOOR_ROOMS } from './rooms/indoorRooms';
import { DAYOUT_ROOMS } from './rooms/dayoutRooms';

/**
 * Registers the first-person scenes of the free-time places and the park's activities (docs/leisure.md) with
 * render/interiors.ts, which offers a room only when a builder is registered for it. Imported once, for its effect, by
 * render/fpv.ts. Each file under rooms/ holds a group of scenes built with render/leisureKit.ts:
 * parkRooms (a park's bench, picnic, kite, ducks, band, and the Ferris wheel), outdoorRooms (playground to go-karts),
 * indoorRooms (bowling to the escape room) and dayoutRooms (the farm to the dance hall).
 */
Object.assign(EXTRA_ROOMS, PARK_ROOMS, OUTDOOR_ROOMS, INDOOR_ROOMS, DAYOUT_ROOMS);
