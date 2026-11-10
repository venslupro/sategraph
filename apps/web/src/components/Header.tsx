/** Top bar: identity, search, simulation clock and speed. */
import type { CatalogEntry, Manifest } from '@satgraph/contracts';
import { Search } from './Search';

interface HeaderProps {
  manifest: Manifest | null;
  catalog: CatalogEntry[];
  layerColors: Map<string, string>;
  simTime: Date;
  speed: number;
  onSpeed: (speed: number) => void;
  onSelect: (id: string) => void;
}

const SPEEDS = [0, 1, 60, 600];

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

export function Header({
  manifest,
  catalog,
  layerColors,
  simTime,
  speed,
  onSpeed,
  onSelect,
}: HeaderProps) {
  return (
    <header className="header">
      <div className="brand">
        <svg width="34" height="34" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <circle cx="20" cy="20" r="8.4" stroke="#3fd0ff" strokeWidth="1.4" />
          <ellipse cx="20" cy="20" rx="17" ry="6.4" stroke="#3fd0ff" strokeOpacity="0.55" />
          <ellipse
            cx="20"
            cy="20"
            rx="17"
            ry="6.4"
            stroke="#3fd0ff"
            strokeOpacity="0.3"
            transform="rotate(60 20 20)"
          />
          <circle cx="34" cy="13.4" r="2.2" fill="#3fd0ff" />
          <circle cx="7" cy="24.6" r="1.8" fill="#8fa6c1" />
        </svg>
        <div>
          <h1>SatGraph</h1>
          <p>Satellite knowledge graph</p>
        </div>
      </div>

      <Search catalog={catalog} layerColors={layerColors} onSelect={onSelect} />

      <div className="spacer" />

      <div className="stat">
        <span>UTC</span>
        <span>{formatUtc(simTime)}</span>
      </div>
      <div className="stat">
        <span>Satellites</span>
        <span>{manifest?.satelliteCount ?? catalog.length}</span>
      </div>
      <div className="speed" role="group" aria-label="Simulation speed">
        {SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={speed === option}
            onClick={() => onSpeed(option)}
            title={option === 0 ? 'Pause' : `Advance ${option}x real time`}
          >
            {option === 0 ? 'II' : `${option}x`}
          </button>
        ))}
      </div>
      <span className="badge">Seed demo data</span>
    </header>
  );
}
