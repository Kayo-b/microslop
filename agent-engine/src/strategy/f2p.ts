/**
 * The free-to-play map. Free worlds block members-only areas, so a character walking towards one
 * (a quest step, a hunting ground) never arrives and the run stalls. The rectangles are generous
 * on purpose: they cover the F2P mainland, its dungeons and the F2P corners of Karamja and the
 * Corsair Cove island; everything else counts as a members area.
 */
import type { WorldPoint } from '../types.ts';

interface Box {
  name: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const F2P_AREAS: Box[] = [
  { name: 'mainland (Falador to Al Kharid, Lumbridge to Edgeville)', x1: 2944, x2: 3340, y1: 3130, y2: 3530 },
  { name: 'dungeons and sewers (Edgeville, Varrock, Dwarven Mine, Lumbridge)', x1: 2950, x2: 3420, y1: 9500, y2: 9960 },
  { name: 'Karamja south (Musa Point, Crandor ferry)', x1: 2900, x2: 2965, y1: 3130, y2: 3190 },
  { name: "Melzar's Maze and Rimmington edge", x1: 2920, x2: 2965, y1: 3230, y2: 3290 },
  { name: 'Camdozaal (Below Ice Mountain)', x1: 2940, x2: 3010, y1: 5760, y2: 5840 },
  { name: 'Crandor', x1: 2820, x2: 2860, y1: 3230, y2: 3270 },
  { name: 'Corsair Cove', x1: 2540, x2: 2620, y1: 2830, y2: 2900 },
];

export function inF2pArea(p: WorldPoint): boolean {
  return F2P_AREAS.some((a) => p.x >= a.x1 && p.x <= a.x2 && p.y >= a.y1 && p.y <= a.y2);
}
