import { useEffect, useRef, useState } from 'react';
import { readingToSpec, type DrawingReading } from '../ai/drawingSchema';
import { AI_MODEL, aiErrorMessage, forgetApiKey, getApiKey, readDrawingsWithAI, saveApiKey } from '../ai/drawingReader';
import { forgetGeminiKey, GEMINI_MODEL, getGeminiKey, readDrawingsWithGemini, saveGeminiKey } from '../ai/geminiReader';
import { readDrawingsOnServer } from '../ai/serverReader';
import { IS_FRAPPE } from '../config';
import { loadDrawing, type DrawingMeta } from '../data/drawingStore';
import { errorMessages, RepositoryError } from '../data/repository';
import { useApp } from '../state/AppContext';
import type { BuilderSpec } from '../domain/modelBuilder';
import { ErrorList } from './ui';

// Local build only: which AI reads the drawing, each with its own key in this browser.
type Provider = 'gemini' | 'claude';
const PROVIDER_STORAGE = 'pmc3d.aiProvider';
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (free tier)',
    model: GEMINI_MODEL,
    placeholder: 'AIza…',
    getKey: getGeminiKey,
    saveKey: saveGeminiKey,
    forgetKey: forgetGeminiKey,
    read: readDrawingsWithGemini,
    hint: 'Get a free key at aistudio.google.com (Google login, no card). The key is saved only in this browser and sent only to Google. On the free tier Google may use the drawings to improve its products, so do not send confidential client drawings, and the daily limit is small.',
  },
  claude: {
    label: 'Anthropic Claude (paid)',
    model: AI_MODEL,
    placeholder: 'sk-ant-…',
    getKey: getApiKey,
    saveKey: saveApiKey,
    forgetKey: forgetApiKey,
    read: readDrawingsWithAI,
    hint: 'The key is saved only in this browser on this computer and is sent only to api.anthropic.com. Each reading is billed to that key. Anyone using this browser can use it, so do not save it on a shared computer. Get a key at console.anthropic.com.',
  },
} as const;

function storedProvider(): Provider {
  try {
    return localStorage.getItem(PROVIDER_STORAGE) === 'claude' ? 'claude' : 'gemini';
  } catch {
    return 'gemini';
  }
}

interface Outcome {
  reading: DrawingReading;
  notes: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
}

/**
 * "Read drawing with AI": sends the uploaded drawings to Claude, fills the Model Builder form from
 * the answer, and shows what the AI assumed so the engineer can check it. The previous form can be
 * restored with Undo.
 */
export function AiReaderCard({
  drawings,
  spec,
  onApply,
}: {
  drawings: DrawingMeta[];
  spec: BuilderSpec;
  onApply: (next: BuilderSpec) => void;
}) {
  const { session } = useApp();
  // Local: the user's own key in this browser. Frappe: the key is in PMC Settings on the server.
  const [provider, setProvider] = useState<Provider>(storedProvider);
  const p = PROVIDERS[provider];
  const [key, setKey] = useState(() => (IS_FRAPPE ? '' : PROVIDERS[storedProvider()].getKey()));
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [previous, setPrevious] = useState<BuilderSpec | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => () => abort.current?.abort(), []);

  async function read() {
    if (busy) return;
    setErrors([]);
    setOutcome(null);
    setBusy(true);
    setElapsed(0);
    abort.current = new AbortController();
    const started = Date.now();
    try {
      let res;
      if (IS_FRAPPE) {
        res = await readDrawingsOnServer(
          drawings.map((d) => d.id),
          abort.current.signal,
        );
      } else {
        const files = [];
        for (const d of drawings) {
          const blob = await loadDrawing(d);
          if (!blob) throw new Error(`${d.name} is no longer in browser storage. Upload it again.`);
          files.push({ name: d.name, kind: d.kind, blob });
        }
        res = await p.read(files, key, abort.current.signal);
      }
      const { spec: next, notes } = readingToSpec(res.reading, spec);
      setPrevious(spec);
      onApply(next);
      setOutcome({ ...res, notes, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      setErrors(e instanceof RepositoryError ? errorMessages(e) : [aiErrorMessage(e)]);
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  if (IS_FRAPPE && session && !session.aiConfigured) {
    return (
      <section className="card ai-card">
        <h2 className="card-title">Read the drawing with AI</h2>
        <p className="small">
          AI reading is not set up on this server yet. An administrator chooses the AI (Google Gemini or Anthropic Claude) and enters its API key in <b>PMC Settings</b> (Frappe Desk). Until then,
          fill the form below by hand from the drawing.
        </p>
      </section>
    );
  }

  if (!IS_FRAPPE && !key) {
    return (
      <section className="card ai-card">
        <h2 className="card-title">Read the drawing with AI</h2>
        <p className="small">
          The AI reads the uploaded drawing and fills this form — grid, columns, footings, beams, slab, walls, doors and windows. It needs internet and
          an API key.
        </p>
        <div className="ai-key-row">
          <select
            value={provider}
            aria-label="AI"
            onChange={(e) => {
              const next = e.target.value as Provider;
              setProvider(next);
              setErrors([]);
              try {
                localStorage.setItem(PROVIDER_STORAGE, next);
              } catch {
                /* remembered for this visit only */
              }
              setKey(PROVIDERS[next].getKey());
            }}
          >
            {(Object.keys(PROVIDERS) as Provider[]).map((id) => (
              <option key={id} value={id}>
                {PROVIDERS[id].label}
              </option>
            ))}
          </select>
          <input
            type="password"
            placeholder={p.placeholder}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            aria-label={`${p.label} API key`}
            autoComplete="off"
          />
          <button
            className="btn btn-primary"
            disabled={!keyInput.trim()}
            onClick={() => {
              try {
                p.saveKey(keyInput);
                setKey(keyInput.trim());
                setKeyInput('');
              } catch {
                setErrors(['This browser does not allow saving the key (storage blocked).']);
              }
            }}
          >
            Save key
          </button>
        </div>
        <p className="hint">{p.hint}</p>
        <ErrorList errors={errors} title="Problem" />
      </section>
    );
  }

  return (
    <section className="card ai-card">
      <div className="ai-head">
        <h2 className="card-title">Read the drawing with AI</h2>
        {IS_FRAPPE ? (
          <span className="muted small">read on the server</span>
        ) : (
          <span className="muted small">
            {p.label} · {p.model} · key …{key.slice(-4)} ·{' '}
            <button
              className="link"
              onClick={() => {
                p.forgetKey();
                setKey('');
              }}
              disabled={busy}
            >
              Forget key
            </button>
          </span>
        )}
      </div>
      {drawings.length === 0 ? (
        <p className="muted small">Upload the drawing (left) first — then the AI can read it.</p>
      ) : (
        <p className="small">
          Sends {drawings.length === 1 ? <b>{drawings[0].name}</b> : <b>{drawings.length} drawings</b>} to the AI. It usually takes 1–3 minutes. The form below
          is replaced; you can undo.
        </p>
      )}
      <div className="card-actions">
        <button className="btn btn-primary" disabled={busy || drawings.length === 0} onClick={() => void read()}>
          {busy ? `Reading… ${elapsed}s` : 'Read drawing with AI'}
        </button>
        {busy && (
          <button className="btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
        {previous && !busy && (
          <button
            className="btn"
            onClick={() => {
              onApply(previous);
              setPrevious(null);
              setOutcome(null);
            }}
          >
            Undo AI fill
          </button>
        )}
      </div>
      <ErrorList errors={errors} title="The drawing was not read" />
      {outcome && (
        <div className={`alert ${outcome.reading.confidence === 'low' ? 'alert-warn' : 'alert-success'}`}>
          <strong>
            Form filled from the drawing — confidence: {outcome.reading.confidence}. Check every value against the drawing before creating the model.
          </strong>
          {outcome.reading.assumptions.length > 0 && (
            <>
              <div style={{ marginTop: 6 }}>Not on the drawing, assumed by the AI:</div>
              <ul>
                {outcome.reading.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {outcome.notes.length > 0 && (
            <>
              <div style={{ marginTop: 6 }}>Could not be placed automatically:</div>
              <ul>
                {outcome.notes.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          <div className="muted small" style={{ marginTop: 6 }}>
            {outcome.model} · {outcome.seconds}s · {outcome.inputTokens.toLocaleString()} input / {outcome.outputTokens.toLocaleString()} output tokens
          </div>
        </div>
      )}
    </section>
  );
}
