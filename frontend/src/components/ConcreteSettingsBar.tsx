import { useMemo, useState } from 'react';
import { errorMessages } from '../data/repository';
import { CONCRETE_MODE_LABELS, gradeOf, type ConcreteMode, type ConcreteSettings } from '../domain/concrete';
import { CONCRETE_GRADES, normsOf, RCC_ELEMENT_TYPES, type RccType } from '../domain/materials';
import { ELEMENT_TYPE_LABELS } from '../domain/reports';
import { useApp } from '../state/AppContext';
import { setConcrete, useConcrete } from '../state/concrete';
import { ErrorList, Modal } from './ui';

/**
 * Material Required: how the project's concrete is ordered (ready-mix or mixed on site) and the grade of
 * each RCC element type. Everyone sees it; the PMC Reviewer changes it.
 */
export function ConcreteSettingsBar() {
  const { data, role, repo, notify } = useApp();
  const { settings } = useConcrete();
  const [editing, setEditing] = useState(false);
  const norms = normsOf(data?.model?.document);
  // the RCC types of this model, with the grade each one gets now
  const types = useMemo(() => {
    const present = new Set((data?.elements ?? []).map((e) => e.type));
    return RCC_ELEMENT_TYPES.filter((t) => present.has(t));
  }, [data?.elements]);
  const gradeNow = (t: RccType) => {
    const els = (data?.elements ?? []).filter((e) => e.type === t);
    const grades = [...new Set(els.map((e) => gradeOf(e, norms, settings)))];
    return grades.length === 1 ? grades[0] : grades.length ? grades.join(' / ') : '—';
  };
  if (!data?.model || !types.length) return null;
  const canEdit = role === 'pmc-reviewer';

  return (
    <div className="concrete-bar">
      <div className="concrete-bar-main">
        <span className="concrete-bar-label">Concrete</span>
        <b className={`concrete-mode concrete-mode-${settings.mode}`}>{CONCRETE_MODE_LABELS[settings.mode]}</b>
        <span className="concrete-grades">
          {types.map((t) => (
            <span key={t}>
              {ELEMENT_TYPE_LABELS[t]} <b>{gradeNow(t)}</b>
            </span>
          ))}
        </span>
      </div>
      {canEdit ? (
        <button className="btn btn-small" onClick={() => setEditing(true)}>
          Change
        </button>
      ) : (
        <span className="muted small">Set by the PMC Reviewer</span>
      )}
      {editing && (
        <ConcreteDialog
          settings={settings}
          types={types}
          defaultGrade={(t) => {
            const els = (data?.elements ?? []).filter((e) => e.type === t);
            const g = [...new Set(els.map((e) => gradeOf(e, norms, { mode: settings.mode, gradeByType: {} })))];
            return g.join(' / ') || norms.gradeByType[t];
          }}
          onClose={() => setEditing(false)}
          onSave={async (s) => {
            const saved = await repo.saveConcreteSettings(data.project.id, s, role);
            setConcrete(data.project.id, saved);
            notify('Concrete settings saved — the material required uses them now.', 'success');
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function ConcreteDialog({
  settings,
  types,
  defaultGrade,
  onClose,
  onSave,
}: {
  settings: ConcreteSettings;
  types: RccType[];
  defaultGrade: (t: RccType) => string;
  onClose: () => void;
  onSave: (s: ConcreteSettings) => Promise<void>;
}) {
  const [mode, setMode] = useState<ConcreteMode>(settings.mode);
  const [grades, setGrades] = useState<Partial<Record<RccType, string>>>(settings.gradeByType);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  return (
    <Modal
      title="Concrete of this project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setErrors([]);
              onSave({ mode, gradeByType: grades })
                .catch((e) => setErrors(errorMessages(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <fieldset className="concrete-modes">
        <legend>How is the concrete ordered?</legend>
        {(['rmc', 'site'] as ConcreteMode[]).map((m) => (
          <label key={m} className={`concrete-mode-opt ${mode === m ? 'on' : ''}`}>
            <input type="radio" name="concrete-mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <b>{CONCRETE_MODE_LABELS[m]}</b>
              <small>{m === 'rmc' ? 'Asked as grade and m³ (e.g. Concrete M25 — 2.4 m³).' : 'Asked as cement (bags), sand and gitti, by the mix of each grade.'}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <h4 className="concrete-grade-head">Grade of each element type</h4>
      <div className="concrete-grade-list">
        {types.map((t) => (
          <label key={t}>
            <span>{ELEMENT_TYPE_LABELS[t]}</span>
            <select
              value={grades[t] ?? ''}
              onChange={(e) =>
                setGrades((g) => {
                  const n = { ...g };
                  if (e.target.value) n[t] = e.target.value;
                  else delete n[t];
                  return n;
                })
              }
              aria-label={`Concrete grade of ${ELEMENT_TYPE_LABELS[t]}`}
            >
              <option value="">From the BOQ ({defaultGrade(t)})</option>
              {CONCRETE_GRADES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="hint">A grade chosen here is used for every element of that type, instead of the grade in the BOQ Excel.</p>
      <ErrorList errors={errors} />
    </Modal>
  );
}
