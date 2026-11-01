/** SHARE TARGET — text shared from another app (Android share sheet) gets a suggested reply. Nothing is saved to Gmail. */
import { useState } from "react";
import { api } from "../api";

export function Share({ text: initial, title }: { text: string; title: string }) {
  const [text, setText] = useState([title, initial].filter(Boolean).join("\n\n"));
  const [instruction, setInstruction] = useState("");
  const [out, setOut] = useState<{ draft_body: string; open_questions: string[]; flags: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <div className="toolbar"><a className="btn small" href="#/inbox" aria-label="Back">‹</a><h1>Draft from shared text</h1></div>
      <div className="content">
        <label htmlFor="st">Text</label><textarea id="st" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        <label htmlFor="si">Instruction (optional)</label><input id="si" type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        <p><button className="btn primary" disabled={!text || busy} onClick={async () => { setBusy(true); try { setOut(await api("/api/scratch", { method: "POST", body: { text, instruction: instruction || undefined } })); } finally { setBusy(false); } }}>{busy ? "Drafting…" : "Draft a reply"}</button></p>
        {out && <section className="card"><pre className="mail">{out.draft_body}</pre>
          {out.open_questions.length > 0 && <ul className="small">{out.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
          <button className="btn" onClick={() => navigator.clipboard.writeText(out.draft_body)}>Copy</button></section>}
      </div>
    </div>
  );
}
