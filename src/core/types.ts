export type AreaKind =
  | 'water' | 'park' | 'forest' | 'grass' | 'pitch' | 'plaza' | 'parking'
  | 'residential' | 'commercial' | 'civic' | 'construction';

/** Building kinds: 0 office/commercial, 1 residential, 2 civic/low-rise, 3 landmark tower. */
export interface MapBuilding { p: number[]; h: number; k: number; m?: number; g?: 1; n?: string }
/** Road classes: 0 major, 1 medium, 2 minor, 3 service, 4 footway. */
export interface MapRoad { p: number[]; w: number; c: number; n?: string; o?: 1; b?: 1 }
export interface MapArea { p: number[]; k: AreaKind; h?: number[][]; n?: string }
export interface MapLabel { n: string; x: number; z: number; y: number; k: 'landmark' | 'water' | 'metro' }

export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

export interface MapData {
  meta: { name: string; source: string; origin: { lat: number; lon: number } };
  bounds: Bounds;
  buildings: MapBuilding[];
  roads: MapRoad[];
  areas: MapArea[];
  /** Flat [x, z, scale, type] tuples. Types: 0 broadleaf, 1 palm, 2 conifer. */
  trees: number[];
  /** Flat [x, z, yaw] tuples. */
  lights: number[];
  labels: MapLabel[];
}

export type Vec2 = [number, number];
