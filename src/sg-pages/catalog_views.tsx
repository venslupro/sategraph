import type {CSSProperties} from 'react';
import {createRoot} from 'react-dom/client';
import {GROUP_BY_ID, GROUPS} from './model.ts';
import type {Satellite} from './orbit_types.ts';

function Dot({color}: {color: string}) {
  return <i className="color-dot" style={{'--dot': color} as CSSProperties} />;
}

export function mountLayers(
  node: HTMLElement,
  toggle: (group: string) => void,
) {
  const root = createRoot(node);
  return (
    catalog: Satellite[],
    active: ReadonlySet<string>,
    showOther: boolean,
  ) => {
    const counts = new Map<string, number>();
    for (const sat of catalog) {
      counts.set(sat.group, (counts.get(sat.group) ?? 0) + 1);
    }
    root.render(
      GROUPS.filter(
        (g) => counts.has(g.id) || (showOther && g.id === 'other'),
      ).map((g) => (
        <button
          type="button"
          key={g.id}
          className={'layer' + (active.has(g.id) ? ' active' : '')}
          data-group={g.id}
          aria-pressed={active.has(g.id)}
          onClick={() => toggle(g.id)}
        >
          <Dot color={g.color} />
          <span>{g.name}</span>
          <span className="layer-count">
            {(counts.get(g.id) ?? 0).toLocaleString('zh-CN')}
          </span>
          <i className="layer-check" />
        </button>
      )),
    );
  };
}

export function mountCatalog(node: HTMLElement) {
  const root = createRoot(node);
  return (rows: Satellite[]) =>
    root.render(
      rows.length ? (
        rows.map((s) => (
          <tr key={s.id} tabIndex={0} data-select={s.id}>
            <td>
              <span>
                <Dot color={GROUP_BY_ID[s.group].color} />
                {s.name}
              </span>
            </td>
            <td>{GROUP_BY_ID[s.group].short}</td>
            <td className="mono">{s.norad || '—'}</td>
            <td className="mono">
              {Math.round(s.alt).toLocaleString('zh-CN')} km
            </td>
          </tr>
        ))
      ) : (
        <tr>
          <td colSpan={4}>没有匹配的卫星</td>
        </tr>
      ),
    );
}
