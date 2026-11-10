/** Right rail: satellite dossier, provenance and the empty-state watchlist. */
import type { CatalogEntry, DomainEventView, Layer, SatelliteDetail } from '@satgraph/contracts';

interface LiveSample {
  lat: number;
  lon: number;
  altKm: number;
  speedKmS: number;
}

interface DetailPanelProps {
  detail: SatelliteDetail | null;
  loading: boolean;
  error: string | null;
  live: LiveSample | null;
  layer: Layer | null;
  events: DomainEventView[];
  watchlist: CatalogEntry[];
  isWatched: boolean;
  onClose: () => void;
  onFocus: (id: string) => void;
  onGraph: (id: string) => void;
  onConstellation: (id: string) => void;
  onAsk: (question: string) => void;
  onToggleWatch: (id: string) => void;
  onSelect: (id: string) => void;
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatCoordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`;
}

function relative(timestamp: string): string {
  const delta = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function Watchlist({
  watchlist,
  events,
  onSelect,
}: {
  watchlist: CatalogEntry[];
  events: DomainEventView[];
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <h2 className="section-title">Watchlist</h2>
      {watchlist.length === 0 ? (
        <div className="empty-state">
          <strong>Select a satellite to begin</strong>
          <p>
            Drag the globe, scroll to zoom, and click any point. Relationships and
            provenance appear here; star a satellite to keep it on this list.
          </p>
        </div>
      ) : (
        <div className="watchlist">
          {watchlist.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="layer-button"
              aria-pressed
              onClick={() => onSelect(entry.id)}
            >
              <span>{entry.name}</span>
              <span className="count">{entry.noradId}</span>
            </button>
          ))}
        </div>
      )}

      <div className="detail-section">
        <h2 className="section-title">Recent events</h2>
        <div className="event-list">
          {events.slice(0, 8).map((event) => (
            <div className="event" key={event.id}>
              <div className="event-title">{event.title}</div>
              <div className="event-meta">
                {event.type.replaceAll('_', ' ')} · {relative(event.occurredAt)}
              </div>
            </div>
          ))}
          {events.length === 0 ? <p className="footnote">No events in this window.</p> : null}
        </div>
      </div>
    </>
  );
}

export function DetailPanel({
  detail,
  loading,
  error,
  live,
  layer,
  events,
  watchlist,
  isWatched,
  onClose,
  onFocus,
  onGraph,
  onConstellation,
  onAsk,
  onToggleWatch,
  onSelect,
}: DetailPanelProps) {
  if (!detail && !loading) {
    return (
      <aside className="detail" aria-label="Satellite details">
        <Watchlist watchlist={watchlist} events={events} onSelect={onSelect} />
      </aside>
    );
  }

  if (loading && !detail) {
    return (
      <aside className="detail" aria-label="Satellite details">
        <div className="loading">
          <span className="spinner" />
          <span>Loading dossier</span>
        </div>
      </aside>
    );
  }

  if (!detail) {
    return <aside className="detail" aria-label="Satellite details" />;
  }

  const satellite = detail.satellite;
  const summary = detail.orbit?.summary ?? null;
  const altitude =
    live?.altKm ?? (summary ? (summary.perigeeKm + summary.apogeeKm) / 2 : null);

  return (
    <aside className="detail" aria-label="Satellite details">
      <div className="detail-head">
        <div className="name">
          <span className="tag" style={{ background: layer?.color ?? '#3fd0ff' }}>
            {layer?.name ?? satellite.layerId}
          </span>
          <h2>{satellite.name}</h2>
          <div className="sub">
            NORAD {satellite.noradId}
            {satellite.cosparId ? ` · ${satellite.cosparId}` : ''}
          </div>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          x
        </button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="actions">
        <button type="button" className="primary" onClick={() => onFocus(satellite.id)}>
          Focus
        </button>
        <button type="button" onClick={() => onGraph(satellite.id)}>
          Relations
        </button>
        <button type="button" onClick={() => onToggleWatch(satellite.id)}>
          {isWatched ? 'Unstar' : 'Star'}
        </button>
      </div>

      <div className="card">
        <div className="live-head">
          <span className="dot-live" />
          LIVE · BROWSER SGP4
        </div>
        <div className="live-grid">
          <div>
            <div className="label">Latitude</div>
            <div className="value">
              {live ? formatCoordinate(live.lat, 'N', 'S') : '—'}
            </div>
          </div>
          <div>
            <div className="label">Longitude</div>
            <div className="value">
              {live ? formatCoordinate(live.lon, 'E', 'W') : '—'}
            </div>
          </div>
          <div>
            <div className="label">Altitude</div>
            <div className="value">
              {altitude === null ? '—' : `${altitude.toFixed(0)} km`}
            </div>
          </div>
          <div>
            <div className="label">Speed</div>
            <div className="value">
              {live ? `${live.speedKmS.toFixed(2)} km/s` : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h2 className="section-title">Identity</h2>
        <div className="kv">
          <span className="k">Status</span>
          <span className="v">{humanize(satellite.status)}</span>
        </div>
        <div className="kv">
          <span className="k">Purpose</span>
          <span className="v">{satellite.purpose || '—'}</span>
        </div>
        <div className="kv">
          <span className="k">Operator</span>
          <span className="v">{satellite.operator ?? '—'}</span>
        </div>
        <div className="kv">
          <span className="k">Manufacturer</span>
          <span className="v">{satellite.manufacturer ?? '—'}</span>
        </div>
        <div className="kv">
          <span className="k">Constellation</span>
          <span className="v">
            {satellite.constellationName ?? '—'}
            {satellite.constellationId ? (
              <button
                type="button"
                className="ghost-button"
                style={{ marginLeft: 8, height: 24, padding: '0 8px' }}
                onClick={() => onConstellation(satellite.constellationId as string)}
              >
                View
              </button>
            ) : null}
          </span>
        </div>
        <div className="kv">
          <span className="k">Launch</span>
          <span className="v">{satellite.launchDate ?? '—'}</span>
        </div>
        <div className="kv">
          <span className="k">Country</span>
          <span className="v">{satellite.country ?? '—'}</span>
        </div>
      </div>

      {summary ? (
        <div className="detail-section">
          <h2 className="section-title">Orbit</h2>
          <div className="kv">
            <span className="k">Class</span>
            <span className="v">{summary.orbitClass}</span>
          </div>
          <div className="kv">
            <span className="k">Inclination</span>
            <span className="v">{summary.inclinationDeg.toFixed(2)}°</span>
          </div>
          <div className="kv">
            <span className="k">Period</span>
            <span className="v">{summary.periodMin.toFixed(1)} min</span>
          </div>
          <div className="kv">
            <span className="k">Perigee / apogee</span>
            <span className="v">
              {summary.perigeeKm.toFixed(0)} / {summary.apogeeKm.toFixed(0)} km
            </span>
          </div>
          {summary.geoLongitudeDeg !== null ? (
            <div className="kv">
              <span className="k">GEO longitude</span>
              <span className="v">{summary.geoLongitudeDeg.toFixed(2)}°</span>
            </div>
          ) : null}
          <div className="kv">
            <span className="k">Epoch</span>
            <span className="v">{detail.orbit?.epoch.replace('T', ' ').slice(0, 19)}Z</span>
          </div>
        </div>
      ) : null}

      <div className="detail-section">
        <h2 className="section-title">Relations ({detail.relations.length})</h2>
        {detail.relations.length === 0 ? (
          <p className="footnote">No relations are published for this satellite.</p>
        ) : null}
        {detail.relations.map((relation) => {
          const outgoing = relation.from.id === satellite.id;
          const other = outgoing ? relation.to : relation.from;
          return (
            <div className="relation" key={relation.id}>
              <div className="relation-head">
                <span>{relation.type.replaceAll('_', ' ')}</span>
                <span className={`pill ${relation.confidence === 'DECLARED' ? 'ok' : 'warn'}`}>
                  {relation.confidence}
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>
                  {outgoing ? 'out' : 'in'}
                </span>
              </div>
              <div className="relation-body">{other.name}</div>
              <div className="relation-evidence">
                {relation.method}
                {relation.evidence[0] ? ` · ${relation.evidence[0].label}` : ''}
              </div>
            </div>
          );
        })}
      </div>

      <div className="detail-section">
        <h2 className="section-title">Provenance</h2>
        {detail.provenance.map((entry) => (
          <div className="kv" key={`${entry.field}-${entry.source}`}>
            <span className="k">{humanize(entry.field)}</span>
            <span className="v" title={entry.value}>
              {entry.value}
              <br />
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                {entry.source} · {entry.license}
              </span>
            </span>
          </div>
        ))}
        {detail.provenance.length === 0 ? (
          <p className="footnote">Seed fixture; no external provenance recorded.</p>
        ) : null}
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => onAsk(`Tell me about ${satellite.name} and its relationships.`)}
        >
          Ask SatGraph
        </button>
      </div>
    </aside>
  );
}
