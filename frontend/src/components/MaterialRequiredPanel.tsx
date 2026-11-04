import { useMemo } from 'react';
import { MATERIALS, normsOf, roundMaterial } from '../domain/materials';
import { materialRequired } from '../domain/materialRequired';
import { computeActivityProgress, formatQty } from '../domain/progress';
import type { ElementRecord, ProgressEntry } from '../domain/types';
import { useApp } from '../state/AppContext';
import { MaterialRequestCard } from './MaterialRequestCard';
import { EmptyState } from './ui';

/** Right panel in "Material required" mode: what the ticked elements need, steel by bar size, concrete by grade. */
export function MaterialRequiredPanel({
  selected,
  entries,
  shown,
  onTickShown,
  withRequest = true,
}: {
  selected: ElementRecord[];
  entries: ProgressEntry[];
  /** Elements shown in the list (for "tick all shown"). */
  shown: number;
  onTickShown: () => void;
  /** Offer an ERPNext Material Request for the material (not in the one-element details card). */
  withRequest?: boolean;
}) {
  const { data } = useApp();
  const norms = normsOf(data?.model?.document);
  const req = useMemo(() => materialRequired(selected, entries, norms, 'balance'), [selected, entries, norms]);
  // elements whose planned work is all approved: nothing more to bring for them
  const done = useMemo(() => {
    const acts = data?.model?.document?.activities ?? [];
    return selected.filter((el) => {
      const used = acts.map((a) => computeActivityProgress(el, a, entries)).filter((p) => p.planned !== null);
      return used.length > 0 && used.every((p) => p.status === 'complete');
    });
  }, [data?.model, selected, entries]);

  if (!selected.length) {
    return (
      <EmptyState
        title="No element selected"
        action={
          <button className="btn btn-primary" onClick={onTickShown} disabled={!shown}>
            Select all {shown} shown elements
          </button>
        }
      >
        Select the elements to be cast or built next (e.g. all slabs of the first floor) above, or click them in the 3D view — the steel by bar size and the
        concrete by grade they need is shown here.
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
        <h2 className="panel-title">{selected.length === 1 ? selected[0].code : `${selected.length} elements selected`}</h2>
        {selected.length > 1 && (
          <p className="muted small">
            {selected
              .slice(0, 12)
              .map((e) => e.code)
              .join(', ')}
            {selected.length > 12 ? ` +${selected.length - 12} more` : ''}
          </p>
        )}
        {norms.wastagePct ? <p className="hint">Includes {norms.wastagePct}% wastage.</p> : null}
      </div>

      {nothing && done.length === selected.length ? (
        <div className="panel-section">
          <div className="alert alert-success">
            <b>Work already done.</b> All the work of {selected.length === 1 ? 'this element' : `these ${selected.length} elements`} is approved (100%), so no
            more material is needed.
          </div>
        </div>
      ) : nothing ? (
        <div className="panel-section">
          <p className="muted">
            No material is needed for these elements
            {done.length
              ? ` — ${done.map((e) => e.code).join(', ')} already done; the others have no concrete, steel or masonry in their BOQ`
              : ' — their BOQ has no concrete, steel or masonry'}
            .
          </p>
        </div>
      ) : done.length > 0 ? (
        <div className="panel-section">
          <p className="hint">
            Already done, not counted below: {done.slice(0, 12).map((e) => e.code).join(', ')}
            {done.length > 12 ? ` +${done.length - 12} more` : ''}.
          </p>
        </div>
      ) : null}

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
          {mats.some((m) => m.key === 'cement') && (
            <p className="hint">Cement, sand and gitti with the concrete mix {norms.concreteGrade} of the model planning.</p>
          )}
        </div>
      )}
      {withRequest && <MaterialRequestCard req={req} elementIds={selected.map((e) => e.id).join(',')} bagKg={norms.bagKg} />}
    </div>
  );
}
