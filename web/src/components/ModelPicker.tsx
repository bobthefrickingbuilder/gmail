/**
 * MODEL PICKER — choose which Claude writes the draft: Haiku, Sonnet or Opus.
 * The one marked "default" is your Settings choice (Sonnet unless you change
 * it). A short line under the buttons says what each model is good for.
 */
export interface ModelOption { key: string; label: string; blurb?: string; default?: boolean }

export function ModelPicker({ options, value, onChange, id = "model" }: { options: ModelOption[]; value: string; onChange: (k: string) => void; id?: string }) {
  const sel = options.find((o) => o.key === value);
  return (
    <div className="model-picker">
      <div className="row" role="radiogroup" aria-labelledby={`${id}-lbl`}>
        <span id={`${id}-lbl`} className="muted small">Model</span>
        {options.map((o) => (
          <button key={o.key} type="button" className="chip" role="radio" aria-checked={o.key === value} aria-pressed={o.key === value} onClick={() => onChange(o.key)}>
            {o.label}{o.default ? <span className="muted small"> · default</span> : null}
          </button>))}
      </div>
      {sel?.blurb && <p className="small muted" style={{ margin: ".25rem 0 0" }}>{sel.blurb}</p>}
    </div>
  );
}
