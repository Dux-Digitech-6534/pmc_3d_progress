import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Phones: every dropdown (<select>) of the app opens as a bottom sheet with large rows, a tick on the
 * chosen one and a search box for long lists, instead of the plain system list. The page's own
 * <select> stays the source of truth: the choice is written into it and a normal "change" event is
 * fired, so every page keeps working unchanged. Desktop keeps the normal dropdown.
 */
const PHONE = '(max-width: 760px)';

interface Opt {
  value: string;
  label: string;
  disabled: boolean;
  group: string;
}

interface Open {
  el: HTMLSelectElement;
  title: string;
  options: Opt[];
  value: string;
}

function titleOf(el: HTMLSelectElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const label = el.closest('label');
  if (label) {
    // the label's own text, without the option texts of the select inside it
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('select').forEach((s) => s.remove());
    const t = copy.textContent?.trim();
    if (t) return t;
  }
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l?.textContent?.trim()) return l.textContent.trim();
  }
  return 'Choose';
}

function choose(el: HTMLSelectElement, value: string) {
  if (el.value === value) return;
  // React listens for the change event; the native setter keeps its value tracking right
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function PhoneSelectSheet() {
  const [open, setOpen] = useState<Open | null>(null);
  const [q, setQ] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const isPhone = () => window.matchMedia?.(PHONE).matches;
    const target = (e: Event) => {
      const el = e.target as HTMLElement | null;
      const s = el?.closest?.('select') as HTMLSelectElement | null;
      return s && !s.disabled && !s.multiple && isPhone() ? s : null;
    };
    // stop the system list from opening …
    const block = (e: Event) => {
      if (target(e)) e.preventDefault();
    };
    // … and open the sheet instead
    const onClick = (e: Event) => {
      const s = target(e);
      if (!s) return;
      e.preventDefault();
      s.blur();
      const options = [...s.options].map((o) => ({
        value: o.value,
        label: o.text,
        disabled: o.disabled,
        group: o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : '',
      }));
      setQ('');
      setOpen({ el: s, title: titleOf(s), options, value: s.value });
    };
    document.addEventListener('mousedown', block, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('mousedown', block, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  // the chosen row in view; Esc / back closes
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => listRef.current?.querySelector('.pss-row.on')?.scrollIntoView({ block: 'center' }));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const shown = useMemo(() => {
    if (!open) return [];
    const t = q.trim().toLowerCase();
    return t ? open.options.filter((o) => o.label.toLowerCase().includes(t)) : open.options;
  }, [open, q]);

  if (!open) return null;
  let lastGroup = '';
  return (
    <div className="pss" role="dialog" aria-modal="true" aria-label={open.title}>
      <div className="pss-backdrop" onClick={() => setOpen(null)} />
      <div className="pss-panel">
        <div className="pss-grip" aria-hidden />
        <div className="pss-head">
          <b>{open.title}</b>
          <button className="pss-close" onClick={() => setOpen(null)} aria-label="Close">
            ×
          </button>
        </div>
        {open.options.length > 8 && (
          <input className="pss-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        )}
        <div className="pss-list" ref={listRef}>
          {shown.length === 0 && <div className="pss-empty">Nothing matches.</div>}
          {shown.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : '';
            lastGroup = o.group;
            const on = o.value === open.value;
            return (
              <div key={`${o.value}-${i}`}>
                {head && <div className="pss-group">{head}</div>}
                <button
                  className={`pss-row ${on ? 'on' : ''}`}
                  disabled={o.disabled}
                  style={{ animationDelay: `${Math.min(i, 10) * 0.025}s` }}
                  onClick={() => {
                    choose(open.el, o.value);
                    setOpen(null);
                  }}
                >
                  <span className="pss-label">{o.label || '—'}</span>
                  {on && (
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
