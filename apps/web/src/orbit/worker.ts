/**
 * Orbit worker. Owns SGP4 propagation so the main thread only renders. It
 * receives OMM CSV once, converts each record to a TLE projection required by
 * the SGP4 implementation, and answers time ticks with geodetic samples.
 */
import { parseOmmCsv, toTleLines } from '@sategraph/orbit';
import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import type { SatRec } from 'satellite.js';

interface InitMessage {
  type: 'init';
  csv: string;
}

interface TickMessage {
  type: 'tick';
  isoTime: string;
}

type InMessage = InitMessage | TickMessage;

interface PositionSample {
  id: string;
  lat: number;
  lon: number;
  altKm: number;
  speedKmS: number;
}

interface ReadyMessage {
  type: 'ready';
  count: number;
  skipped: number;
  epoch: string | null;
}

interface PositionsMessage {
  type: 'positions';
  isoTime: string;
  samples: PositionSample[];
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type OutMessage = ReadyMessage | PositionsMessage | ErrorMessage;

interface Entry {
  id: string;
  satrec: SatRec;
}

const scope = self as unknown as {
  postMessage: (message: OutMessage) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<InMessage>) => void,
  ) => void;
};

let entries: Entry[] = [];

const RAD_TO_DEG = 180 / Math.PI;

function init(csv: string): void {
  const records = parseOmmCsv(csv);
  const next: Entry[] = [];
  let skipped = 0;
  let epoch: string | null = null;
  for (const record of records) {
    try {
      const [line1, line2] = toTleLines(record);
      const satrec = twoline2satrec(line1, line2);
      if (!satrec || satrec.error !== 0) {
        skipped += 1;
        continue;
      }
      next.push({ id: record.noradId, satrec });
      if (!epoch || record.epoch > epoch) {
        epoch = record.epoch;
      }
    } catch {
      skipped += 1;
    }
  }
  entries = next;
  scope.postMessage({ type: 'ready', count: entries.length, skipped, epoch });
}

function tick(isoTime: string): void {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) {
    scope.postMessage({ type: 'error', message: 'Invalid simulation time' });
    return;
  }
  const gmst = gstime(date);
  const samples: PositionSample[] = [];
  for (const entry of entries) {
    try {
      const state = propagate(entry.satrec, date);
      const position = state.position;
      const velocity = state.velocity;
      if (
        !position ||
        typeof position === 'boolean' ||
        !velocity ||
        typeof velocity === 'boolean'
      ) {
        continue;
      }
      const geodetic = eciToGeodetic(position, gmst);
      if (!Number.isFinite(geodetic.latitude) || !Number.isFinite(geodetic.longitude)) {
        continue;
      }
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      samples.push({
        id: entry.id,
        lat: geodetic.latitude * RAD_TO_DEG,
        lon: geodetic.longitude * RAD_TO_DEG,
        altKm: geodetic.height,
        speedKmS: Number.isFinite(speed) ? speed : 0,
      });
    } catch {
      // A single propagation failure must not stop the frame.
    }
  }
  scope.postMessage({ type: 'positions', isoTime, samples });
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'init') {
    init(message.csv);
    return;
  }
  if (message.type === 'tick') {
    tick(message.isoTime);
  }
});
