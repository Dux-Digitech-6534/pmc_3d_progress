import { MATERIALS, roundMaterial, type MaterialQty } from '../domain/materials';

const fmt = (k: (typeof MATERIALS)[number]['key'], n: number) => roundMaterial(k, n).toLocaleString('en-IN');

/**
 * Cement, sand, aggregate, steel and bricks: planned (from the model) and, when given, used so far
 * (from approved work) and the balance still to be used. Materials the work does not need are left out.
 */
export function MaterialTable({ planned, used, compact }: { planned: MaterialQty; used?: MaterialQty; compact?: boolean }) {
  const rows = MATERIALS.filter((m) => planned[m.key] > 0 || (used?.[m.key] ?? 0) > 0);
  if (!rows.length) return <p className="muted small">No materials for this work (no concrete, brickwork, plaster or steel).</p>;
  return (
    <table className={`table ${compact ? 'compact' : ''} mat-table`}>
      <thead>
        <tr>
          <th>Material</th>
          <th className="num">Planned</th>
          {used && <th className="num">Used (approved work)</th>}
          {used && <th className="num">Balance</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.key}>
            <td>{m.label}</td>
            <td className="num">
              {fmt(m.key, planned[m.key])} <span className="muted small">{m.unit}</span>
            </td>
            {used && (
              <td className="num">
                {fmt(m.key, used[m.key])} <span className="muted small">{m.unit}</span>
              </td>
            )}
            {used && (
              <td className="num">
                {fmt(m.key, Math.max(planned[m.key] - used[m.key], 0))} <span className="muted small">{m.unit}</span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
