/** Constellation matrix: planes as rows, slots as columns. */
import { useEffect, useState } from 'react';
import type { Constellation } from '@satgraph/contracts';
import { api } from '../api/client';

interface ConstellationDialogProps {
  constellationId: string;
  layerColor: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '',
  CATALOGED: '#ffc857',
  INACTIVE: '#5a6f88',
  DECAYED: '#ff7a7a',
};

export function ConstellationDialog({
  constellationId,
  layerColor,
  onClose,
  onSelect,
}: ConstellationDialogProps) {
  const [data, setData] = useState<Constellation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    api
      .constellation(constellationId, controller.signal)
      .then((response) => setData(response.data))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Failed to load constellation');
        }
      });
    return () => controller.abort();
  }, [constellationId]);

  const maxSlots = data
    ? Math.max(...data.planes.map((plane) => plane.slots.length), 1)
    : 0;

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Constellation matrix">
      <div className="dialog">
        <header>
          <div>
            <h2>{data?.name ?? 'Constellation'}</h2>
            <div className="sub">
              {data?.designPattern ?? 'Walker-style shell'} · {data?.planes.length ?? 0} planes
            </div>
          </div>
          <div className="grow" />
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="dialog-body">
          {error ? <div className="error-banner">{error}</div> : null}
          {!data && !error ? (
            <div className="loading">
              <span className="spinner" />
              <span>Loading constellation</span>
            </div>
          ) : null}
          {data ? (
            <>
              <div className="stats">
                <div>
                  <span className="v">{data.planes.length}</span>
                  <span className="k">Planes</span>
                </div>
                <div>
                  <span className="v">{data.slotCount}</span>
                  <span className="k">Slots</span>
                </div>
                <div>
                  <span className="v">{data.activeCount}</span>
                  <span className="k">Active</span>
                </div>
                <div>
                  <span className="v">{data.inactiveCount}</span>
                  <span className="k">Inactive</span>
                </div>
              </div>
              {data.healthNote ? <p className="footnote">{data.healthNote}</p> : null}
              <div className="matrix-wrap">
                <table className="matrix">
                  <thead>
                    <tr>
                      <th>Plane</th>
                      <th>Inc</th>
                      <th>RAAN</th>
                      {Array.from({ length: maxSlots }, (_, index) => (
                        <th key={index}>{index + 1}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.planes.map((plane) => (
                      <tr key={plane.index}>
                        <th scope="row">P{plane.index + 1}</th>
                        <td>{plane.inclinationDeg.toFixed(1)}°</td>
                        <td>{plane.raanDeg.toFixed(1)}°</td>
                        {Array.from({ length: maxSlots }, (_, slotIndex) => {
                          const slot = plane.slots.find((item) => item.index === slotIndex);
                          if (!slot) {
                            return (
                              <td key={slotIndex}>
                                <span className="slot missing" title="Empty slot" />
                              </td>
                            );
                          }
                          const color = STATUS_COLORS[slot.status] || layerColor;
                          return (
                            <td key={slotIndex}>
                              <button
                                type="button"
                                className="slot"
                                style={{ background: color, border: 0 }}
                                title={`${slot.name} · ${slot.status}`}
                                aria-label={`${slot.name}, ${slot.status}`}
                                onClick={() => {
                                  onSelect(slot.satelliteId);
                                  onClose();
                                }}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="footnote" style={{ marginTop: 14 }}>
                Slots are derived by ordering member satellites by mean anomaly within
                each clustered plane. Hover a cell for the object name; select a cell to
                open its dossier.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
