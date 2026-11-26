import type {OMMJsonObject} from 'satellite.js';

export interface Satellite {
  id: string;
  name: string;
  group: string;
  alt: number;
  inc: number;
  period: number;
  eccentricity: number;
  demo: boolean;
  kind?: 'geo';
  longitude?: number;
  plane?: number;
  slot?: number;
  slots?: number;
  planes?: number;
  u0?: number;
  raan?: number;
  epoch?: number;
  norad?: string;
  cospar?: string;
}
export interface PublicSatellite extends Satellite {
  demo: false;
  epoch: number;
  omm: OMMJsonObject;
}
export interface Position {
  unit: number[];
  physical: number[];
  alt: number;
  lat: number;
  lon: number;
  speed: number;
}
export interface DisplayEdge {
  a: string;
  b: string;
  type: 'model'|'los'
}
export type OrbitRequest = {
  generation: number
}&({
  type: 'catalog';
  rows: OMMJsonObject[]
}|{
  type: 'positions';
  ms: number
}|{
  type: 'path';
  id: string;
  ms: number;
  period: number
});
export type OrbitReply = {
  generation: number
}&({
  type: 'ready';
  count: number
}|{
  type: 'positions';
  ms: number;
  positions: (Position&{id: string})[];
  failed: number
}|{
  type: 'path';
  id: string;
  points: number[][]
});
