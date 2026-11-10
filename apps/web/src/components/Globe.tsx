/** React host for the imperative Three.js scene and the orbit worker. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import { toTleLines, type OmmRecord } from '@satgraph/orbit';
import {
  GlobeScene,
  type ConfidenceLevel,
  type OrbitRing,
  type PositionSample,
  type SatelliteMeta,
  type SceneLink,
} from '../three/scene';

interface GlobeProps {
  csv: string | null;
  records: OmmRecord[];
  satellites: SatelliteMeta[];
  links: SceneLink[];
  rings: OrbitRing[];
  visibleLayers: Set<string>;
  confidence: Set<ConfidenceLevel>;
  selectedId: string | null;
  simTime: Date;
  autoRotate: boolean;
  highlightLinks: Set<string> | null;
  nameById: Map<string, string>;
  onSelect: (id: string | null) => void;
  onSamples: (samples: PositionSample[]) => void;
  footer?: ReactNode;
}

const RAD_TO_DEG = 180 / Math.PI;

function buildGroundTrack(record: OmmRecord, around: Date): { lat: number; lon: number }[] {
  try {
    const [line1, line2] = toTleLines(record);
    const satrec = twoline2satrec(line1, line2);
    const points: { lat: number; lon: number }[] = [];
    for (let offset = -60; offset <= 60; offset += 2) {
      const date = new Date(around.getTime() + offset * 60_000);
      const state = propagate(satrec, date);
      if (!state.position || typeof state.position === 'boolean') {
        continue;
      }
      const geodetic = eciToGeodetic(state.position, gstime(date));
      points.push({
        lat: geodetic.latitude * RAD_TO_DEG,
        lon: geodetic.longitude * RAD_TO_DEG,
      });
    }
    return points;
  } catch {
    return [];
  }
}

export function Globe({
  csv,
  records,
  satellites,
  links,
  rings,
  visibleLayers,
  confidence,
  selectedId,
  simTime,
  autoRotate,
  highlightLinks,
  nameById,
  onSelect,
  onSamples,
  footer,
}: GlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const selectRef = useRef(onSelect);
  const samplesRef = useRef(onSamples);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [workerStatus, setWorkerStatus] = useState<'idle' | 'ready' | 'error'>('idle');

  selectRef.current = onSelect;
  samplesRef.current = onSamples;

  const recordById = useMemo(
    () => new Map(records.map((record) => [record.noradId, record])),
    [records],
  );

  useEffect(() => {
    if (!canvasRef.current || satellites.length === 0) {
      return;
    }
    const scene = new GlobeScene(canvasRef.current, satellites, {
      onSelect: (id) => selectRef.current(id),
      onHover: (id, x, y) => setHover(id ? { id, x, y } : null),
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, [satellites]);

  useEffect(() => {
    if (!csv) {
      return;
    }
    const worker = new Worker(new URL('../orbit/worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ type: string; message?: string; samples?: PositionSample[] }>) => {
      if (event.data.type === 'ready') {
        setWorkerStatus('ready');
      } else if (event.data.type === 'positions' && event.data.samples) {
        sceneRef.current?.setPositions(event.data.samples);
        samplesRef.current(event.data.samples);
      } else if (event.data.type === 'error') {
        setWorkerStatus('error');
      }
    };
    worker.postMessage({ type: 'init', csv });
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [csv]);

  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'tick', isoTime: simTime.toISOString() });
    }
    sceneRef.current?.setSun(simTime.toISOString());
  }, [simTime, csv]);

  useEffect(() => {
    sceneRef.current?.setLayers(visibleLayers);
  }, [visibleLayers]);

  useEffect(() => {
    sceneRef.current?.setConfidence(confidence);
  }, [confidence]);

  useEffect(() => {
    sceneRef.current?.setLinks(links);
  }, [links]);

  useEffect(() => {
    sceneRef.current?.setHighlightLinks(highlightLinks);
  }, [highlightLinks]);

  useEffect(() => {
    sceneRef.current?.setOrbitRings(rings);
  }, [rings]);

  useEffect(() => {
    sceneRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  useEffect(() => {
    sceneRef.current?.setSelected(selectedId);
    const record = selectedId ? recordById.get(selectedId) : undefined;
    sceneRef.current?.setGroundTrack(record ? buildGroundTrack(record, simTime) : []);
    if (selectedId) {
      sceneRef.current?.focus(selectedId);
    }
    // Ground tracks are recomputed only when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, recordById]);

  const hoverName = hover ? nameById.get(hover.id) : null;
  const hoverMeta = hover ? satellites.find((satellite) => satellite.id === hover.id) : null;

  return (
    <div className="globe">
      <canvas ref={canvasRef} aria-label="3D globe of satellites" />
      <div className="globe-hud">
        <strong>ORBITAL VIEW</strong>
        <span>Drag to rotate · scroll to zoom · click a point</span>
        <span>
          {satellites.length} tracked objects ·{' '}
          {workerStatus === 'ready' ? 'SGP4 ready' : workerStatus === 'error' ? 'propagation error' : 'loading elements'}
        </span>
      </div>
      {hover && hoverName ? (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          {hoverName}
          <span>{hoverMeta?.layerId}</span>
        </div>
      ) : null}
      {footer ? <div className="globe-footer">{footer}</div> : null}
    </div>
  );
}
