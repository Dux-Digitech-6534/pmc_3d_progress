import { useEffect, useMemo, useState } from 'react';
import { normsOf } from '../domain/materials';
import { materialRequired } from '../domain/materialRequired';
import { computeActivityProgress, formatQty } from '../domain/progress';
import type { ElementRecord, ElementType, ProgressEntry } from '../domain/types';
import { ELEMENT_TYPE_LABELS } from '../domain/reports';
import { downloadXlsx, type SheetSpec } from '../lib/xlsxWriter';
import { drawRequirementImage } from '../lib/requirementImage';
import { copyImage, openWhatsAppWeb, saveImage, shareInApp, shareMode, shareOnPhone } from '../lib/share';
import { requestNeeds } from '../domain/materialRequest';
import { todayISO } from '../domain/workflow';
import { useApp } from '../state/AppContext';
import { MaterialRequestCard } from './MaterialRequestCard';
import { ConcreteSettingsBar } from './ConcreteSettingsBar';
import { useConcrete } from '../state/concrete';
import { EmptyState, Modal } from './ui';

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
  const { data, role, session, notify, hasErp } = useApp();
  // the ERPNext Material Request form only where ERPNext is installed
  const withErpRequest = withRequest && hasErp;
  const [sharing, setSharing] = useState(false);
  // computer: the picture is shown with the steps to send it in WhatsApp Web
  const [preview, setPreview] = useState<{ url: string; blob: Blob; name: string; copied: boolean } | null>(null);
  const previewUrl = preview?.url;
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  const norms = normsOf(data?.model?.document);
  // the project's concrete: ready-mix or site mix, grade per type chosen in the app
  const { settings: concrete } = useConcrete();
  const req = useMemo(() => materialRequired(selected, entries, norms, 'balance', concrete), [selected, entries, norms, concrete]);
  const rmc = concrete.mode === 'rmc';
  // elements whose planned work is all approved: nothing more to bring for them
  const done = useMemo(() => {
    const acts = data?.model?.document?.activities ?? [];
    return selected.filter((el) => {
      const used = acts.map((a) => computeActivityProgress(el, a, entries)).filter((p) => p.planned !== null);
      return used.length > 0 && used.every((p) => p.status === 'complete');
    });
  }, [data?.model, selected, entries]);

  // work entered and sent to the PMC but not approved yet: still counted as needed, so warn before asking again
  const pending = useMemo(() => {
    const ids = new Set(selected.map((e) => e.id));
    const byEl = new Map<string, Set<string>>();
    for (const e of entries) {
      if (e.status !== 'Submitted' || !ids.has(e.elementId)) continue;
      let s = byEl.get(e.elementCode);
      if (!s) byEl.set(e.elementCode, (s = new Set()));
      s.add(e.activityName);
    }
    return [...byEl.entries()].map(([code, acts]) => ({ code, acts: [...acts] })).sort((a, b) => a.code.localeCompare(b.code));
  }, [selected, entries]);

  if (!selected.length) {
    return (
      <>
      {withRequest && <div className="panel-section"><ConcreteSettingsBar /></div>}
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
      </>
    );
  }

  // the summary the PMC asked for: steel by bar size and concrete by grade (no "Other" list)
  const nothing = !req.steel.length && !req.concrete.length;
  // walls, plaster …: no steel or concrete, but bricks, cement, sand (the same lines the Material Request asks for)
  const other = requestNeeds(req, concrete.mode).filter((n) => n.kind !== 'steel' && n.kind !== 'concrete');
  const hasAny = !nothing || other.length > 0;

  // the lines of the requirement, the same in the Excel sheet and the WhatsApp picture
  const day = () => new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const typesText = () =>
    Object.entries(selected.reduce<Record<string, number>>((m, el) => ((m[el.type] = (m[el.type] ?? 0) + 1), m), {}))
      .map(([t, n]) => `${n} ${(ELEMENT_TYPE_LABELS[t as ElementType] ?? t).toLowerCase()}${n === 1 ? '' : 's'}`)
      .join(', ');
  const floorsText = () => [...new Set(selected.map((el) => `${el.buildingName} – ${el.levelName}`))].join(', ');
  const up = (n: number, d = 0) => Math.ceil(n * 10 ** d - 1e-9) / 10 ** d;
  // Remarks stay blank in the Excel: the engineer writes them on the sheet
  function requirementLines(): { material: string; spec: string; qty: number; unit: string; int?: boolean }[] {
    return [
      ...req.steel.map((st) => ({ material: 'Steel (TMT bar)', spec: st.dia ? `${st.dia} mm` : 'Size not set', qty: up(st.kg), unit: 'kg', int: true })),
      ...req.concrete.map((g) => ({ material: 'Concrete', spec: `${g.grade} (${rmc ? 'ready-mix' : 'mixed on site'}) · ${g.elements} element${g.elements === 1 ? '' : 's'}`, qty: up(g.m3, 2), unit: 'm³' })),
      ...other.map((n) => ({
        material: n.label,
        spec: n.kind === 'cement' ? `OPC, ${norms.bagKg || 50} kg bag` : n.kind === 'aggregate' ? '20 mm' : '',
        qty: n.unit === 'bags' || n.unit === 'nos' ? up(n.qty) : up(n.qty, 2),
        unit: n.unit,
        int: n.unit === 'bags' || n.unit === 'nos',
      })),
    ];
  }

  // "Share on WhatsApp" (meeting 21-11): the requirement as a formatted picture, not text
  async function share(mrName?: string) {
    setSharing(true);
    try {
      const lines = requirementLines().map((l) =>
        l.material === 'Steel (TMT bar)'
          ? { material: `Steel ${l.spec}`, spec: 'TMT bar', qty: formatQty(l.qty), unit: l.unit }
          : l.material === 'Concrete'
            ? { material: `Concrete ${l.spec.split(' ')[0]}`, spec: rmc ? 'Ready-mix (RMC)' : 'Mixed on site — cement, sand, gitti below', qty: formatQty(l.qty), unit: l.unit }
            : { material: l.material, spec: l.spec, qty: formatQty(l.qty), unit: l.unit },
      );
      if (req.steel.length > 1) lines.push({ material: 'Total steel', spec: `= ${(up(req.steelTotal) / 1000).toFixed(3)} MT`, qty: formatQty(up(req.steelTotal)), unit: 'kg' });
      const blob = await drawRequirementImage({
        project: data?.project.name ?? '',
        date: day(),
        location: floorsText(),
        elements: `${selected.length} (${typesText()})`,
        requestNo: mrName,
        lines,
        note: `Quantities from the 3D model and BOQ of the selected elements${norms.wastagePct ? `, ${norms.wastagePct}% wastage included` : ''}; rounded up for ordering.`,
        by: session?.fullName || undefined,
      });
      const name = `material-requirement-${data?.project.id ?? 'project'}-${todayISO()}.png`;
      const text = `Material requirement — ${data?.project.name ?? ''}${mrName ? ` (${mrName})` : ''}`;
      const mode = shareMode();
      if (mode === 'android-app') {
        // the app opens WhatsApp with the picture attached
        await shareInApp(blob, name, text);
      } else if (mode === 'old-app') {
        saveImage(blob, name);
        notify('This app version cannot open WhatsApp with the picture. The picture is saved in Downloads/PMC 3D — attach it in WhatsApp. Install the new app (v1.3) to send it directly.', 'info');
      } else if (mode === 'phone') {
        const r = await shareOnPhone(blob, name, text);
        if (r === 'unsupported') {
          saveImage(blob, name);
          notify('The picture is downloaded — attach it in WhatsApp.', 'info');
        }
      } else {
        setPreview({ url: URL.createObjectURL(blob), blob, name, copied: await copyImage(blob) });
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not share the requirement.', 'error');
    } finally {
      setSharing(false);
    }
  }

  // "Download requirement" (meeting 16-11): a formatted Excel sheet that reads like a material requisition
  // mrName: the Material Request this sheet goes with (printed in the header)
  function download(mrName?: string) {
    const lines = requirementLines();
    const floors = floorsText();
    const types = typesText();
    const rows: SheetSpec['rows'] = [
      [{ v: 'MATERIAL REQUIREMENT', s: 'title' }],
      [{ v: 'Project', s: 'label' }, data?.project.name ?? '', null, null, { v: 'Date', s: 'label' }, day()],
      [{ v: 'Location', s: 'label' }, floors],
      mrName
        ? [{ v: 'Elements', s: 'label' }, `${selected.length} (${types})`, null, null, { v: 'Request No.', s: 'label' }, mrName]
        : [{ v: 'Elements', s: 'label' }, `${selected.length} (${types})`],
      [{ v: `Quantities from the 3D model and BOQ of the selected elements${norms.wastagePct ? `, ${norms.wastagePct}% wastage included` : ''}; rounded up for ordering.`, s: 'note' }],
      [],
      ['Sr', 'Material', 'Specification', 'Quantity', 'Unit', 'Remarks'].map((v) => ({ v, s: 'head' as const })),
      ...lines.map((l, i) => [
        { v: i + 1, s: 'int' as const },
        { v: l.material, s: 'cell' as const },
        { v: l.spec, s: 'cell' as const },
        { v: l.qty, s: (l.int ? 'int' : 'num') as 'int' | 'num' },
        { v: l.unit, s: 'cell' as const },
        { v: '', s: 'cell' as const },
      ]),
      ...(req.steel.length
        ? [[{ v: '', s: 'totalLabel' as const }, { v: 'Total steel', s: 'totalLabel' as const }, { v: '', s: 'totalLabel' as const }, { v: up(req.steelTotal), s: 'total' as const }, { v: 'kg', s: 'totalLabel' as const }, { v: `= ${(up(req.steelTotal) / 1000).toFixed(3)} MT`, s: 'totalLabel' as const }]]
        : []),
      [],
      [{ v: 'Elements covered', s: 'label' }],
      ['Sr', 'Element', 'Type', 'Building – Floor', null, null].map((v) => (v === null ? { v: '', s: 'head' as const } : { v, s: 'head' as const })),
      ...selected.map((el, i) => [{ v: i + 1, s: 'int' as const }, { v: el.code, s: 'cell' as const }, { v: ELEMENT_TYPE_LABELS[el.type] ?? el.type, s: 'cell' as const }, { v: `${el.buildingName} – ${el.levelName}`, s: 'cell' as const }, { v: '', s: 'cell' as const }, { v: '', s: 'cell' as const }]),
      [],
      [],
      [],
      [null, { v: 'Prepared by (Site Engineer)', s: 'sign' }, null, { v: 'Checked by (PMC)', s: 'sign' }, null, { v: 'Approved by', s: 'sign' }],
    ];
    const elHead = rows.findIndex((r) => r.length === 6 && !!r[3] && typeof r[3] === 'object' && r[3].v === 'Building – Floor');
    downloadXlsx(`material-requirement-${data?.project.id ?? 'project'}-${todayISO()}.xlsx`, {
      name: 'Material Requirement',
      cols: [11, 30, 26, 14, 9, 30],
      rows,
      // "Building – Floor" of the elements table spans D:F so it reads on one line
      merges: ['A1:F1', 'B2:D2', 'B3:F3', mrName ? 'B4:D4' : 'B4:F4', 'A5:F5', ...Array.from({ length: selected.length + 1 }, (_, k) => `D${elHead + 1 + k}:F${elHead + 1 + k}`)],
    });
  }

  return (
    <div className="panel-scroll">
      {preview && (
        <Modal
          title="Share on WhatsApp"
          wide
          onClose={() => setPreview(null)}
          footer={
            <>
              <button className="btn" onClick={() => saveImage(preview.blob, preview.name)}>
                Download picture
              </button>
              <button
                className="btn"
                onClick={() =>
                  void copyImage(preview.blob).then((ok) => {
                    setPreview({ ...preview, copied: ok });
                    notify(ok ? 'Picture copied.' : 'This browser did not allow copying — use Download picture.', ok ? 'success' : 'error');
                  })
                }
              >
                Copy again
              </button>
              <button className="btn btn-wa" onClick={() => openWhatsAppWeb()}>
                <WhatsAppIcon /> Open WhatsApp Web
              </button>
            </>
          }
        >
          <div className="wa-preview">
            <img src={preview.url} alt="Material requirement picture" />
            <div className="wa-steps">
              {preview.copied ? (
                <div className="alert alert-success small">
                  <b>✓ Picture copied.</b> It is ready to paste in WhatsApp.
                </div>
              ) : (
                <div className="alert alert-warn small">This browser did not allow copying. Press Download picture and attach it in WhatsApp.</div>
              )}
              <ol>
                <li>
                  Press <b>Open WhatsApp Web</b>.
                </li>
                <li>Open the chat (person or group).</li>
                <li>
                  {preview.copied ? (
                    <>
                      Click in the message box and press <kbd>Ctrl</kbd> + <kbd>V</kbd> — the picture comes in.
                    </>
                  ) : (
                    <>Attach the downloaded picture (📎 → Photos).</>
                  )}
                </li>
                <li>Press Send.</li>
              </ol>
            </div>
          </div>
        </Modal>
      )}
      <div className="panel-section">
        {withRequest && <ConcreteSettingsBar />}
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
        {/* with the request form the button sits next to the request (and its number) */}
        {hasAny && !(withErpRequest && role !== 'owner') && (
          <div className="mr-share-actions">
            <button className="btn btn-small" onClick={() => download()}>
              Download requirement (Excel)
            </button>
            <button className="btn btn-small btn-wa" onClick={() => void share()} disabled={sharing}>
              <WhatsAppIcon /> {sharing ? 'Preparing…' : 'Share on WhatsApp'}
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="alert alert-warn mr-pending-warn" role="status">
            <b>
              Work already done on {pending.length === 1 ? '1 element' : `${pending.length} elements`}, waiting for PMC approval.
            </b>{' '}
            Its material is still counted below until the PMC approves it — check before asking for it again.
            <ul>
              {pending.slice(0, 8).map((p) => (
                <li key={p.code}>
                  <b>{p.code}</b> — {p.acts.join(', ')}
                </li>
              ))}
              {pending.length > 8 && <li>+{pending.length - 8} more</li>}
            </ul>
          </div>
        )}
      </div>

      {nothing && done.length === selected.length ? (
        <div className="panel-section">
          <div className="alert alert-success">
            <b>Work already done.</b> All the work of {selected.length === 1 ? 'this element' : `these ${selected.length} elements`} is approved (100%), so no
            more material is needed.
          </div>
        </div>
      ) : nothing && other.length ? (
        <div className="panel-section">
          <h3 className="section-title">Material</h3>
          <p className="muted small">These elements need no steel or concrete — this is what they need:</p>
          <table className="table compact mr-table" data-testid="other-material">
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {other.map((n) => (
                <tr key={n.key}>
                  <td>{n.label}</td>
                  <td className="num">{formatQty(n.qty, n.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : nothing ? (
        <div className="panel-section">
          <p className="muted">
            No steel or concrete for these elements
            {done.length
              ? ` — ${done.map((e) => e.code).join(', ')} already done; the others have no steel or concrete in their BOQ`
              : ' — their BOQ has no steel or concrete'}
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

      {withErpRequest && <MaterialRequestCard
          req={req}
          elementIds={selected.map((e) => e.id).join(',')}
          bagKg={norms.bagKg}
          mode={concrete.mode}
          onDownload={hasAny ? download : undefined}
          onShare={hasAny ? (mr) => void share(mr) : undefined}
          sharing={sharing}
        />}
    </div>
  );
}

/** WhatsApp mark for the share button. */
export function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden style={{ verticalAlign: '-2px' }}>
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z" />
    </svg>
  );
}
