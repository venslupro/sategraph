/** Left rail: layers, relation filters, confidence legend and source health. */
import type { Layer, SourceHealth } from '@sategraph/contracts';

interface LayerPanelProps {
  layers: Layer[];
  counts: Map<string, number>;
  visibleLayers: Set<string>;
  onToggleLayer: (id: string) => void;
  confidence: Set<'DECLARED' | 'DERIVED' | 'MODELED'>;
  onToggleConfidence: (level: 'DECLARED' | 'DERIVED' | 'MODELED') => void;
  showIsl: boolean;
  showRelay: boolean;
  onToggleIsl: () => void;
  onToggleRelay: () => void;
  sources: SourceHealth[];
}

const CONFIDENCE: {
  level: 'DECLARED' | 'DERIVED' | 'MODELED';
  label: string;
  hint: string;
}[] = [
  { level: 'DECLARED', label: 'Declared', hint: 'Curated or source-published' },
  { level: 'DERIVED', label: 'Derived', hint: 'Computed from elements' },
  { level: 'MODELED', label: 'Modeled', hint: 'Hypothesis, not approved' },
];

function freshness(timestamp: string | null): string {
  if (!timestamp) {
    return 'n/a';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'n/a';
  }
  return date.toISOString().slice(5, 16).replace('T', ' ');
}

export function LayerPanel({
  layers,
  counts,
  visibleLayers,
  onToggleLayer,
  confidence,
  onToggleConfidence,
  showIsl,
  showRelay,
  onToggleIsl,
  onToggleRelay,
  sources,
}: LayerPanelProps) {
  return (
    <aside className="sidebar" aria-label="Layers and filters">
      <section>
        <h2 className="section-title">Layers</h2>
        <div className="layer-list">
          {layers.map((layer) => (
            <button
              key={layer.id}
              type="button"
              className="layer-button"
              aria-pressed={visibleLayers.has(layer.id)}
              onClick={() => onToggleLayer(layer.id)}
              title={layer.description}
            >
              <span className="dot" style={{ background: layer.color }} />
              <span>{layer.name}</span>
              <span className="count">{counts.get(layer.id) ?? layer.count}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Relations</h2>
        <button
          type="button"
          className="check-row"
          aria-pressed={showIsl}
          onClick={onToggleIsl}
        >
          <span className="box">{showIsl ? 'x' : ''}</span>
          <span>Inter-satellite links</span>
          <span className="conf">MODELED</span>
        </button>
        <button
          type="button"
          className="check-row"
          aria-pressed={showRelay}
          onClick={onToggleRelay}
        >
          <span className="box">{showRelay ? 'x' : ''}</span>
          <span>Relay and docking</span>
          <span className="conf">DECLARED</span>
        </button>
      </section>

      <section>
        <h2 className="section-title">Confidence</h2>
        <div className="legend">
          {CONFIDENCE.map((item) => (
            <button
              key={item.level}
              type="button"
              className="legend-row"
              aria-pressed={confidence.has(item.level)}
              onClick={() => onToggleConfidence(item.level)}
              title={item.hint}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                opacity: confidence.has(item.level) ? 1 : 0.42,
                textAlign: 'left',
              }}
            >
              <span className={`swatch ${item.level.toLowerCase()}`} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Sources</h2>
        <ul className="sources">
          {sources.map((source) => (
            <li key={source.source} title={source.message ?? source.license}>
              <span className={`status ${source.status}`} />
              <span>{source.source}</span>
              <span className="when">{freshness(source.dataTime)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="section-title">About</h2>
        <p className="footnote">
          A public, traceable graph of satellites and orbital relationships. Every
          edge declares whether it is published, derived from public elements, or
          modeled. Elements are propagated in your browser; the server never
          streams positions.
        </p>
      </section>
    </aside>
  );
}
