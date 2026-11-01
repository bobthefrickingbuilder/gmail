/** Side-by-side compare of two draft versions, with word-level changes highlighted. */
import { diffWords } from "diff";
import { useEffect, useRef } from "react";
import { modelLabel } from "../format";
import type { Version } from "../types";

export function CompareView({ a, b, onClose }: { a: Version; b: Version; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const parts = diffWords(a.body, b.body);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="cmp" style={{ maxWidth: "min(1000px, 96vw)" }}>
      <div className="dlg">
        <div className="row"><h2 id="cmp" style={{ margin: 0, flex: 1 }}>v{a.version} → v{b.version}</h2><button className="btn small" onClick={() => ref.current?.close()}>Close</button></div>
        <div className="compare" style={{ marginTop: ".6rem" }}>
          <div><div className="small muted">v{a.version} · {a.model_key ? modelLabel(a.model_key) : "you"}</div><pre className="mail card diff">{parts.filter((p) => !p.added).map((p, i) => p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>)}</pre></div>
          <div><div className="small muted">v{b.version} · {b.model_key ? modelLabel(b.model_key) : "you"}</div><pre className="mail card diff">{parts.filter((p) => !p.removed).map((p, i) => p.added ? <ins key={i}>{p.value}</ins> : <span key={i}>{p.value}</span>)}</pre></div>
        </div>
      </div>
    </dialog>
  );
}
