/** Neighborhood explorer rendered with Cytoscape. */
import cytoscape, {
  type Core,
  type CytoscapeOptions,
  type ElementDefinition,
} from 'cytoscape';
import { useEffect, useRef, useState } from 'react';
import type { Neighborhood } from '@sategraph/contracts';
import { api } from '../api/client';

interface GraphDialogProps {
  satelliteId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}

const NODE_COLORS: Record<string, string> = {
  Satellite: '#3fd0ff',
  Constellation: '#8e7bff',
  OrbitalPlane: '#4f7fae',
  Organization: '#ffc857',
  Launch: '#6fe3a0',
  Bus: '#d68cff',
};

const EDGE_STYLE: Record<string, string> = {
  DECLARED: 'solid',
  DERIVED: 'dashed',
  MODELED: 'dotted',
};

const EDGE_COLOR: Record<string, string> = {
  DECLARED: '#ffc857',
  DERIVED: '#dce9f7',
  MODELED: '#3fd0ff',
};

const STYLES = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(color)',
      label: 'data(label)',
      color: '#dbe9f7',
      'font-size': 9,
      'text-valign': 'bottom',
      'text-margin-y': 3,
      width: 14,
      height: 14,
      'border-width': 1,
      'border-color': 'rgba(255,255,255,0.25)',
    },
  },
  {
    selector: 'node[kind = "Constellation"]',
    style: { width: 22, height: 22 },
  },
  {
    selector: 'node[kind = "Organization"]',
    style: { shape: 'diamond', width: 12, height: 12 },
  },
  {
    selector: 'node:selected',
    style: { 'border-width': 3, 'border-color': '#ffffff' },
  },
  {
    selector: 'edge',
    style: {
      'curve-style': 'bezier',
      width: 1.1,
      'line-color': 'data(color)',
      'line-style': 'data(lineStyle)',
      'target-arrow-color': 'data(color)',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.6,
      opacity: 0.72,
      label: 'data(label)',
      'font-size': 7,
      color: '#8fa6c1',
      'text-rotation': 'autorotate',
    },
  },
] as unknown as NonNullable<CytoscapeOptions['style']>;

export function GraphDialog({ satelliteId, onClose, onSelect }: GraphDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<Core | null>(null);
  const [depth, setDepth] = useState(2);
  const [data, setData] = useState<Neighborhood | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    api
      .neighborhood(satelliteId, depth, controller.signal)
      .then((response) => setData(response.data))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Failed to load neighborhood');
        }
      });
    return () => controller.abort();
  }, [satelliteId, depth]);

  useEffect(() => {
    if (!containerRef.current || !data) {
      return;
    }
    const elements: ElementDefinition[] = [
      ...data.nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.name,
          kind: node.kind,
          color: NODE_COLORS[node.kind] ?? '#8fa6c1',
        },
      })),
      ...data.edges.map((edge) => ({
        data: {
          id: edge.id,
          source: edge.from.id,
          target: edge.to.id,
          label: edge.type.replaceAll('_', ' '),
          color: EDGE_COLOR[edge.confidence] ?? '#8fa6c1',
          lineStyle: EDGE_STYLE[edge.confidence] ?? 'solid',
        },
      })),
    ];
    const core = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLES,
      wheelSensitivity: 0.2,
      layout: { name: 'cose', animate: false, padding: 36, nodeRepulsion: () => 5000 },
    });
    core.on('tap', 'node', (event) => {
      const id = String(event.target.id());
      if (data.nodes.find((node) => node.id === id)?.kind === 'Satellite') {
        onSelect(id);
        onClose();
      }
    });
    coreRef.current = core;
    return () => {
      core.destroy();
      coreRef.current = null;
    };
  }, [data, onSelect, onClose]);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Relationship graph">
      <div className="dialog">
        <header>
          <div>
            <h2>Relationship graph</h2>
            <div className="sub">
              {data ? `${data.nodes.length} nodes · ${data.edges.length} edges` : 'Loading'}
            </div>
          </div>
          <div className="grow" />
          {[1, 2, 3].map((option) => (
            <button
              key={option}
              type="button"
              className="ghost-button"
              aria-pressed={depth === option}
              onClick={() => setDepth(option)}
            >
              {option} hop{option > 1 ? 's' : ''}
            </button>
          ))}
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="dialog-body graph-body">
          {error ? <div className="error-banner">{error}</div> : null}
          {!data && !error ? (
            <div className="loading">
              <span className="spinner" />
              <span>Traversing relations</span>
            </div>
          ) : null}
          <div ref={containerRef} className="graph-canvas" />
        </div>
      </div>
    </div>
  );
}
