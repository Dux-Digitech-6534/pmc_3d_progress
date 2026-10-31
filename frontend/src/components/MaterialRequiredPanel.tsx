import { useMemo, useState } from 'react';
import { MATERIALS, normsOf, roundMaterial } from '../domain/materials';
import { materialRequired, type RequiredBasis } from '../domain/materialRequired';
import { formatQty } from '../domain/progress';
import type { ElementRecord, ProgressEntry } from '../domain/types';
import { useApp } from '../state/AppContext';
import { EmptyState } from './ui';

/** Right panel in "Material required" mode: what the ticked elements need, steel by bar size, concrete by grade. */
export function MaterialRequiredPanel({
  selected,
  entries,
  shown,
  onTickShown,
}: {
  selected: ElementRecord[];
  entries: ProgressEntry[];
  /** Elements shown in the list (for "tick all shown"). */
  shown: number;
  onTickShown: () => void;
}) {
  const { data } = useApp();
  const norms = normsOf(data?.model?.document);
  const [basis, setBasis] = useState<RequiredBasis>('balance');
  const req = useMemo(() => materialRequired(selected, entries, norms, basis), [selected, entries, norms, basis]);

  if (!selected.length) {
    return (
      <EmptyState
        title="Material required"
        action={
          <button className="btn btn-primary" onClick={onTickShown} disabled={!shown}>
            Tick all {shown} shown elements
          </button>
        }
      >
        Tick the elements to be cast or built next (e.g. all slabs of the first floor) above (or Ctrl-click them in the 3D view) — the steel by bar size and the concrete by
        grade they need is shown here.
      </EmptyState>
    );
  }

  const other = [
    { label: 'Shuttering', value: req.shutteringM2, unit: 'm²' },
    { label: 'Brickwork', value: req.brickworkM3, unit: 'm³' },
    { label: 'Plaster', value: req.plasterM2, unit: 'm²' },
  ].filter((r) => r.value > 0);
  const mats = MATERIALS.filter((m) => m.key !== 'steel' && req.materials[m.key] > 0);
  const nothing = !req.steel.length && !req.concrete.length && !other.length;

  return (
    <div className="panel-scroll">
      <div className="panel-section">
        <h2 className="panel-title">Material required</h2>
        <p className="muted small">
          {selected.length} element{selected.length === 1 ? '' : 's'}: {selected.slice(0, 12).map((e) => e.code).join(', ')}
          {selected.length > 12 ? ` +${selected.length - 12} more` : ''}
        </p>
        <div className="seg" role="group" aria-label="Quantity basis">
          <button className={`btn btn-small ${basis === 'balance' ? 'btn-on' : ''}`} onClick={() => setBasis('balance')}>
            Work still to do
          </button>
          <button className={`btn btn-small ${basis === 'planned' ? 'btn-on' : ''}`} onClick={() => setBasis('planned')}>
            Full planned work
          </button>
        </div>
        <p className="hint">
          {basis === 'balance' ? 'Planned quantity less the approved work done.' : 'The whole planned quantity of these elements.'}
          {norms.wastagePct ? ` Includes ${norms.wastagePct}% wastage.` : ''}
        </p>
      </div>

      {nothing && (
        <div className="panel-section">
          <p className="muted">{basis === 'balance' ? 'All the work of these elements is done — nothing more is required.' : 'No planned quantities for these elements.'}</p>
        </div>
      )}

      {req.steel.length > 0 && (
        <div className="panel-section">
          <h3 className="section-title">Steel (reinforcement)</h3>
          <table className="table compact mr-table" data-testid="steel-by-dia">
            <thead>
              <tr>
                <th>Bar size</th>
                <th className="num">kg</th>
                <th className="num">Tonne</th>
              </tr>
            </thead>
            <tbody>
              {req.steel.map((s) => (
                <tr key={s.dia}>
                  <td>{s.dia ? `${s.dia} mm` : <span className="warn-text">Size not set</span>}</td>
                  <td className="num">{formatQty(s.kg)}</td>
                  <td className="num">{formatQty(Math.round(s.kg) / 1000)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{formatQty(req.steelTotal)}</td>
                <td className="num">{formatQty(Math.round(req.steelTotal) / 1000)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="hint">
            {req.steelSource === 'bbs'
              ? 'Bar sizes from the bar bending schedule (BBS) uploaded with the model.'
              : req.steelSource === 'mixed'
                ? 'Bar sizes from the uploaded BBS where an element has one; the others use the typical bar mix of the planning (estimate).'
                : 'Bar sizes use the typical bar mix of the planning — an estimate until the model is uploaded with its BBS (steelByDia).'}
          </p>
        </div>
      )}

      {req.concrete.length > 0 && (
        <div className="panel-section">
          <h3 className="section-title">Concrete</h3>
          <table className="table compact mr-table" data-testid="concrete-by-grade">
            <thead>
              <tr>
                <th>Grade</th>
                <th className="num">Elements</th>
                <th className="num">m³</th>
              </tr>
            </thead>
            <tbody>
              {req.concrete.map((c) => (
                <tr key={c.grade}>
                  <td>{c.grade}</td>
                  <td className="num">{c.elements}</td>
                  <td className="num">{formatQty(c.m3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(other.length > 0 || mats.length > 0) && (
        <div className="panel-section">
          <h3 className="section-title">Other</h3>
          <table className="table compact mr-table">
            <tbody>
              {other.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{formatQty(r.value, r.unit)}</td>
                </tr>
              ))}
              {mats.map((m) => (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="num">{formatQty(roundMaterial(m.key, req.materials[m.key]), m.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {mats.some((m) => m.key === 'cement') && <p className="hint">Cement, sand and gitti with the concrete mix {norms.concreteGrade} of the model planning.</p>}
        </div>
      )}
    </div>
  );
}
