/** Global search over the catalog, backed by MiniSearch in the browser. */
import MiniSearch from 'minisearch';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogEntry } from '@satgraph/contracts';

interface SearchProps {
  catalog: CatalogEntry[];
  layerColors: Map<string, string>;
  onSelect: (id: string) => void;
}

export function Search({ catalog, layerColors, onSelect }: SearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const index = useMemo(() => {
    const mini = new MiniSearch<CatalogEntry>({
      fields: ['name', 'aliases', 'noradId', 'cosparId', 'operator', 'constellationName'],
      storeFields: ['id'],
      searchOptions: { boost: { name: 3, noradId: 4 }, prefix: true, fuzzy: 0.2 },
    });
    mini.addAll(catalog.filter((entry) => !mini.has(entry.id)));
    return mini;
  }, [catalog]);

  const byId = useMemo(() => new Map(catalog.map((entry) => [entry.id, entry])), [catalog]);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const matches =
      /^\d{3,}$/.test(trimmed) && byId.has(trimmed)
        ? [byId.get(trimmed) as CatalogEntry]
        : index
            .search(trimmed)
            .slice(0, 9)
            .map((result) => byId.get(String(result.id)))
            .filter((entry): entry is CatalogEntry => entry !== undefined);
    return matches;
  }, [query, index, byId]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const choose = (entry: CatalogEntry): void => {
    onSelect(entry.id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="search" ref={boxRef}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.6" stroke="#8fa6c1" strokeWidth="1.4" />
        <path d="M10.6 10.6L14 14" stroke="#8fa6c1" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="search-results"
        aria-label="Search satellites"
        placeholder="Search any satellite, NORAD ID or constellation"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((value) => Math.min(value + 1, results.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((value) => Math.max(value - 1, 0));
          } else if (event.key === 'Enter' && results[active]) {
            event.preventDefault();
            choose(results[active]);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && results.length > 0 ? (
        <ul className="suggestions" id="search-results" role="listbox">
          {results.map((entry, position) => (
            <li key={entry.id} role="option" aria-selected={position === active}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(entry)}
                onMouseEnter={() => setActive(position)}
              >
                <span
                  className="dot"
                  style={{ background: layerColors.get(entry.layerId) ?? '#3fd0ff' }}
                />
                <span>{entry.name}</span>
                <span className="meta">
                  {entry.constellationName ?? entry.noradId}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
