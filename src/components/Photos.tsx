import { useEffect, useMemo, useState } from 'react';
import { loadPhoto, MAX_PHOTOS, validatePhoto } from '../data/photoStore';
import type { PhotoMeta } from '../domain/types';

/** Photos chosen in a form but NOT yet stored. They are stored only when the entry is saved. */
export function PhotoPicker({
  pending,
  onChange,
  existing = [],
  onRemoveExisting,
  disabled,
}: {
  pending: File[];
  onChange: (files: File[]) => void;
  existing?: PhotoMeta[];
  onRemoveExisting?: (id: string) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const urls = useMemo(() => pending.map((f) => URL.createObjectURL(f)), [pending]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const room = MAX_PHOTOS - existing.length - pending.length;

  return (
    <div className="photo-picker">
      {existing.length > 0 && (
        <div className="thumbs">
          {existing.map((p) => (
            <div className="thumb" key={p.id}>
              <StoredPhoto meta={p} />
              {onRemoveExisting && !disabled && (
                <button type="button" className="thumb-x" onClick={() => onRemoveExisting(p.id)} aria-label={`Remove ${p.name}`}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="thumbs">
          {pending.map((f, i) => (
            <div className="thumb pending" key={`${f.name}-${i}`}>
              <img src={urls[i]} alt={f.name} />
              <span className="thumb-tag">Not saved yet</span>
              {!disabled && (
                <button type="button" className="thumb-x" onClick={() => onChange(pending.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <label className={`btn btn-small ${room <= 0 || disabled ? 'disabled' : ''}`}>
        Attach photo
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          hidden
          disabled={room <= 0 || disabled}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            const problems = files.map(validatePhoto).filter(Boolean) as string[];
            const ok = files.filter((f) => !validatePhoto(f)).slice(0, Math.max(room, 0));
            if (files.filter((f) => !validatePhoto(f)).length > ok.length) problems.push(`Only ${MAX_PHOTOS} photos per entry.`);
            setError(problems.length ? problems.join(' ') : null);
            if (ok.length) onChange([...pending, ...ok]);
          }}
        />
      </label>
      <p className="hint">
        Optional, up to {MAX_PHOTOS} images, 2 MB each. Stored only in this browser (IndexedDB) when you save — not uploaded to any server.
      </p>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

export function StoredPhoto({ meta }: { meta: PhotoMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    void loadPhoto(meta.id).then((blob) => {
      if (!alive) return;
      if (!blob) return setMissing(true);
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [meta.id]);
  if (missing) return <div className="thumb-missing" title={meta.name}>Photo not found in this browser</div>;
  if (!url) return <div className="thumb-missing">Loading…</div>;
  return (
    <a href={url} target="_blank" rel="noreferrer" title={`${meta.name} (${Math.round(meta.size / 1024)} KB)`}>
      <img src={url} alt={meta.name} />
    </a>
  );
}
