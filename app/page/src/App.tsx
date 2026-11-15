/** Application shell: bootstrap, simulation clock and cross-panel state. */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CatalogEntry,
  Constellation,
  DomainEventView,
  Layer,
  LayerLinks,
  Manifest,
  SatelliteDetail,
} from '@sategraph/contracts';
import type { ViewCommand } from '@sategraph/contracts';
import { meanMotionToSemiMajorAxis, parseOmmCsv, type OmmRecord } from '@sategraph/orbit';
import { api } from './api/client';
import { Header } from './components/Header';
import { LayerPanel } from './components/LayerPanel';
import { Globe } from './components/Globe';
import { DetailPanel } from './components/DetailPanel';
import { AgentBar } from './components/AgentBar';
import { ConstellationDialog } from './components/ConstellationDialog';
import type { ConfidenceLevel, OrbitRing, PositionSample, SatelliteMeta, SceneLink } from './three/scene';

/** Cytoscape is only needed once a graph dialog opens, so load it on demand. */
const GraphDialog = lazy(() =>
  import('./components/GraphDialog').then((module) => ({
    default: module.GraphDialog,
  })),
);

interface Bootstrap {
  manifest: Manifest;
  layers: Layer[];
  catalog: CatalogEntry[];
  constellations: Constellation[];
  layerLinks: LayerLinks[];
  events: DomainEventView[];
  orbitsCsv: string;
  records: OmmRecord[];
}

const WATCH_KEY = 'sategraph.watchlist';
const DEFAULT_WATCH = ['25544', '48274', '20580'];

function readWatchlist(): string[] {
  try {
    const stored = localStorage.getItem(WATCH_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed;
      }
    }
  } catch {
    // Fall through to the default list.
  }
  return DEFAULT_WATCH;
}

function applyUrlSelection(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set('sat', id);
  } else {
    url.searchParams.delete('sat');
  }
  window.history.replaceState(null, '', url.toString());
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SatelliteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [live, setLive] = useState<{
    lat: number;
    lon: number;
    altKm: number;
    speedKmS: number;
  } | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Set<ConfidenceLevel>>(
    new Set(['DECLARED', 'DERIVED', 'MODELED']),
  );
  const [showIsl, setShowIsl] = useState(true);
  const [showRelay, setShowRelay] = useState(true);
  const [autoRotate, setAutoRotate] = useState(true);
  const [speed, setSpeed] = useState(60);
  const [simTime, setSimTime] = useState(() => new Date());
  const [watchlistIds, setWatchlistIds] = useState<string[]>(readWatchlist);
  const [graphId, setGraphId] = useState<string | null>(null);
  const [constellationId, setConstellationId] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [autoAsk, setAutoAsk] = useState<{ id: number; text: string } | null>(null);
  const [highlightLinks, setHighlightLinks] = useState<Set<string> | null>(null);

  const simRef = useRef(Date.now());
  const speedRef = useRef(speed);
  const selectedRef = useRef(selectedId);
  const detailCache = useRef(new Map<string, SatelliteDetail>());
  speedRef.current = speed;
  selectedRef.current = selectedId;

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.manifest(controller.signal),
      api.layers(controller.signal),
      api.catalog(controller.signal),
      api.constellations(controller.signal),
      api.links(controller.signal),
      api.events(controller.signal),
      api.orbits(controller.signal),
    ])
      .then(([manifest, layers, catalog, constellations, layerLinks, events, orbitsCsv]) => {
        const records = parseOmmCsv(orbitsCsv);
        const start = Date.parse(manifest.data.generatedAt);
        const startTime = Number.isNaN(start) ? new Date() : new Date(start);
        simRef.current = startTime.getTime();
        setSimTime(startTime);
        setVisibleLayers(new Set(layers.data.map((layer) => layer.id)));
        const params = new URLSearchParams(window.location.search);
        const initial = params.get('sat');
        if (initial && catalog.data.some((entry) => entry.id === initial)) {
          setSelectedId(initial);
        }
        setShareId(params.get('share'));
        setBoot({
          manifest: manifest.data,
          layers: layers.data,
          catalog: catalog.data,
          constellations: constellations.data,
          layerLinks: layerLinks.data,
          events: events.data,
          orbitsCsv,
          records,
        });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setBootError(reason instanceof Error ? reason.message : 'Failed to load SateGraph');
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = simRef.current + 250 * speedRef.current;
      simRef.current = next;
      if (speedRef.current > 0) {
        setSimTime(new Date(next));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(watchlistIds));
    } catch {
      // Private mode without storage is still usable.
    }
  }, [watchlistIds]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      setLive(null);
      return;
    }
    const cached = detailCache.current.get(selectedId);
    if (cached) {
      setDetail(cached);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    api
      .detail(selectedId, controller.signal)
      .then((response) => {
        detailCache.current.set(selectedId, response.data);
        setDetail(response.data);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setDetailError(reason instanceof Error ? reason.message : 'Failed to load dossier');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoading(false);
        }
      });
    return () => controller.abort();
  }, [selectedId]);

  useEffect(() => {
    applyUrlSelection(selectedId);
  }, [selectedId]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) {
      setHighlightLinks(null);
    }
  }, []);

  const handleSamples = useCallback((samples: PositionSample[]) => {
    const id = selectedRef.current;
    if (!id) {
      return;
    }
    const sample = samples.find((item) => item.id === id);
    setLive(
      sample
        ? {
            lat: sample.lat,
            lon: sample.lon,
            altKm: sample.altKm,
            speedKmS: sample.speedKmS,
          }
        : null,
    );
  }, []);

  const layerColors = useMemo(
    () => new Map((boot?.layers ?? []).map((layer) => [layer.id, layer.color])),
    [boot],
  );
  const layerById = useMemo(
    () => new Map((boot?.layers ?? []).map((layer) => [layer.id, layer])),
    [boot],
  );
  const catalogById = useMemo(
    () => new Map((boot?.catalog ?? []).map((entry) => [entry.id, entry])),
    [boot],
  );
  const nameById = useMemo(
    () => new Map((boot?.catalog ?? []).map((entry) => [entry.id, entry.name])),
    [boot],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of boot?.catalog ?? []) {
      map.set(entry.layerId, (map.get(entry.layerId) ?? 0) + 1);
    }
    return map;
  }, [boot]);

  const satellites = useMemo<SatelliteMeta[]>(
    () =>
      (boot?.catalog ?? []).map((entry) => ({
        id: entry.id,
        layerId: entry.layerId,
        color: layerColors.get(entry.layerId) ?? '#3fd0ff',
      })),
    [boot, layerColors],
  );

  const rings = useMemo<OrbitRing[]>(() => {
    if (!boot) {
      return [];
    }
    const byLayer = new Map<string, OmmRecord[]>();
    for (const record of boot.records) {
      const entry = catalogById.get(record.noradId);
      if (!entry) {
        continue;
      }
      const list = byLayer.get(entry.layerId) ?? [];
      list.push(record);
      byLayer.set(entry.layerId, list);
    }
    const result: OrbitRing[] = [];
    for (const [layerId, list] of byLayer) {
      const stride = Math.max(1, Math.floor(list.length / 10));
      for (let index = 0; index < list.length; index += stride) {
        const record = list[index];
        const semiMajorAxis = meanMotionToSemiMajorAxis(record.meanMotion);
        result.push({
          id: record.noradId,
          layerId,
          inclinationDeg: record.inclinationDeg,
          raanDeg: record.raanDeg,
          altitudeKm: semiMajorAxis - 6371.0088,
        });
      }
    }
    return result;
  }, [boot, catalogById]);

  const sceneLinks = useMemo<SceneLink[]>(() => {
    if (!boot) {
      return [];
    }
    const links: SceneLink[] = [];
    for (const group of boot.layerLinks) {
      for (const link of group.links) {
        if (link.type === 'ISL_MODELED' && showIsl) {
          links.push({
            id: link.id,
            fromId: link.fromId,
            toId: link.toId,
            confidence: link.confidence,
            layerId: link.layerId,
          });
        } else if (link.type === 'RELAY_SERVES' && showRelay) {
          links.push({
            id: link.id,
            fromId: link.fromId,
            toId: link.toId,
            confidence: link.confidence,
            layerId: link.layerId,
          });
        }
      }
    }
    return links;
  }, [boot, showIsl, showRelay]);

  const watchlist = useMemo(
    () =>
      watchlistIds
        .map((id) => catalogById.get(id))
        .filter((entry): entry is CatalogEntry => entry !== undefined),
    [watchlistIds, catalogById],
  );

  const toggleLayer = (id: string): void => {
    setVisibleLayers((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleConfidence = (level: ConfidenceLevel): void => {
    setConfidence((current) => {
      const next = new Set(current);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const toggleWatch = (id: string): void => {
    setWatchlistIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const handleCommand = useCallback((command: ViewCommand) => {
    switch (command.type) {
      case 'fly_to':
      case 'open_detail':
        setSelectedId(command.satelliteId);
        break;
      case 'focus_satellites': {
        const first = command.satelliteIds[0];
        if (first) {
          setSelectedId(first);
        }
        break;
      }
      case 'open_graph':
        setGraphId(command.satelliteId);
        break;
      case 'set_layer':
        setVisibleLayers((current) => {
          const next = new Set(current);
          if (command.visible) {
            next.add(command.layerId);
          } else {
            next.delete(command.layerId);
          }
          return next;
        });
        break;
      case 'set_filter':
        if (command.layerIds) {
          setVisibleLayers(new Set(command.layerIds));
        }
        if (command.confidence) {
          const allowed = command.confidence.filter(
            (level): level is ConfidenceLevel =>
              level === 'DECLARED' || level === 'DERIVED' || level === 'MODELED',
          );
          setConfidence(new Set(allowed));
        }
        break;
      case 'set_time': {
        const parsed = Date.parse(command.isoTime);
        if (!Number.isNaN(parsed)) {
          simRef.current = parsed;
          setSimTime(new Date(parsed));
        }
        if (command.speed) {
          setSpeed(command.speed);
        }
        break;
      }
      case 'highlight_links':
        setHighlightLinks(command.linkIds.length > 0 ? new Set(command.linkIds) : null);
        break;
      default:
        break;
    }
  }, []);

  if (bootError) {
    return (
      <div className="app">
        <div style={{ margin: 'auto', maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontFamily: 'var(--display)' }}>SateGraph is unavailable</h1>
          <div className="error-banner">{bootError}</div>
          <p className="footnote" style={{ marginTop: 16 }}>
            The local API runs on port 8787. Start it with <code>npm run dev</code> and
            reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="app">
        <div className="loading" style={{ margin: 'auto' }}>
          <span className="spinner" />
          <span>Loading graph and orbit elements</span>
        </div>
      </div>
    );
  }

  const selectedLayer = detail ? layerById.get(detail.satellite.layerId) ?? null : null;

  return (
    <div className="app">
      <Header
        manifest={boot.manifest}
        catalog={boot.catalog}
        layerColors={layerColors}
        simTime={simTime}
        speed={speed}
        onSpeed={setSpeed}
        onSelect={select}
      />
      <div className="layout">
        <LayerPanel
          layers={boot.layers}
          counts={counts}
          visibleLayers={visibleLayers}
          onToggleLayer={toggleLayer}
          confidence={confidence}
          onToggleConfidence={toggleConfidence}
          showIsl={showIsl}
          showRelay={showRelay}
          onToggleIsl={() => setShowIsl((value) => !value)}
          onToggleRelay={() => setShowRelay((value) => !value)}
          sources={boot.manifest.sources}
        />
        <Globe
          csv={boot.orbitsCsv}
          records={boot.records}
          satellites={satellites}
          links={sceneLinks}
          rings={rings}
          visibleLayers={visibleLayers}
          confidence={confidence}
          selectedId={selectedId}
          simTime={simTime}
          autoRotate={autoRotate}
          highlightLinks={highlightLinks}
          nameById={nameById}
          onSelect={select}
          onSamples={handleSamples}
          footer={
            <AgentBar
              context={{
                selectedId,
                layerIds: [...visibleLayers],
                linkIds: highlightLinks ? [...highlightLinks] : [],
                time: simTime.toISOString(),
              }}
              onCommand={handleCommand}
              autoAsk={autoAsk}
              onAutoAskHandled={() => setAutoAsk(null)}
              initialShareId={shareId}
            />
          }
        />
        <DetailPanel
          detail={detail}
          loading={detailLoading}
          error={detailError}
          live={live}
          layer={selectedLayer}
          events={boot.events}
          watchlist={watchlist}
          isWatched={selectedId !== null && watchlistIds.includes(selectedId)}
          onClose={() => select(null)}
          onFocus={(id) => setSelectedId(id)}
          onGraph={(id) => setGraphId(id)}
          onConstellation={(id) => setConstellationId(id)}
          onAsk={(question) => setAutoAsk({ id: Date.now(), text: question })}
          onToggleWatch={toggleWatch}
          onSelect={select}
        />
      </div>

      <div style={{ position: 'absolute', top: 72, right: 366, display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="ghost-button"
          aria-pressed={autoRotate}
          onClick={() => setAutoRotate((value) => !value)}
        >
          Auto rotate
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            simRef.current = Date.now();
            setSimTime(new Date(simRef.current));
          }}
        >
          Now
        </button>
      </div>

      {graphId ? (
        <Suspense fallback={null}>
          <GraphDialog
            satelliteId={graphId}
            onClose={() => setGraphId(null)}
            onSelect={select}
          />
        </Suspense>
      ) : null}
      {constellationId ? (
        <ConstellationDialog
          constellationId={constellationId}
          layerColor={detail?.satellite.layerId ? layerColors.get(detail.satellite.layerId) ?? '#3fd0ff' : '#3fd0ff'}
          onClose={() => setConstellationId(null)}
          onSelect={select}
        />
      ) : null}
    </div>
  );
}
