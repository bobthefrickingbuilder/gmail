/**
 * RECIPIENT FIELD — works like Gmail's "To": type a name or address and pick
 * from your contacts (Google contacts + people you've emailed). Enter, Tab or
 * a comma picks the highlighted match, or adds what you typed when it is an
 * address. Backspace on an empty field removes the last person. Pasting a
 * list ("Ann <ann@x.com>, bob@y.com") adds them all.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Address } from "../types";
import { Avatar } from "./Avatar";

interface Contact { email: string; name: string | null; source: string }
const EMAIL = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;

export function parseAddressList(s: string): Address[] {
  return s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.*)<([^>]+)>$/);
    return m ? { name: m[1].trim().replace(/^"|"$/g, "") || null, email: m[2].trim().toLowerCase() } : { name: null, email: x.toLowerCase() };
  });
}

export function RecipientInput({ id, value, onChange, placeholder, autoFocus }: {
  id: string; value: Address[]; onChange: (v: Address[]) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (!q) { setResults([]); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      api<Contact[]>(`/api/contacts?q=${encodeURIComponent(q)}`).then((r) => {
        if (my !== seq.current) return;
        const have = new Set(value.map((v) => v.email));
        setResults(r.filter((c) => !have.has(c.email))); setSel(0); setOpen(true);
      }).catch(() => undefined);
    }, 120);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (list: Address[]) => {
    const have = new Set(value.map((v) => v.email));
    const fresh = list.filter((a) => a.email && !have.has(a.email) && (have.add(a.email), true));
    if (fresh.length) onChange([...value, ...fresh]);
    setText(""); setResults([]); setOpen(false);
  };
  const commit = (t = text) => {
    if (open && results[sel]) return add([{ name: results[sel].name, email: results[sel].email }]);
    const typed = parseAddressList(t);
    if (typed.length && typed.every((a) => EMAIL.test(a.email))) add(typed);
  };
  const remove = (email: string) => onChange(value.filter((v) => v.email !== email));
  const listId = `${id}-list`;

  return (
    <div className="rcpt" onClick={() => input.current?.focus()}>
      {value.map((a) => (
        <span key={a.email} className={`pill${EMAIL.test(a.email) ? "" : " bad"}`} title={a.email}>
          <Avatar name={a.name} email={a.email} />
          <span>{a.name || a.email}</span>
          <button type="button" aria-label={`Remove ${a.name || a.email}`} onClick={(e) => { e.stopPropagation(); remove(a.email); }}>×</button>
        </span>
      ))}
      <input ref={input} id={id} type="text" autoComplete="off" autoFocus={autoFocus} value={text} placeholder={value.length ? "" : placeholder}
        role="combobox" aria-expanded={open && results.length > 0} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && results[sel] ? `${listId}-${sel}` : undefined}
        onChange={(e) => { const v = e.target.value; if (/[,;]$/.test(v)) commit(v.slice(0, -1)); else setText(v); }}
        onPaste={(e) => { const p = e.clipboardData.getData("text"); if (/[,;\n]/.test(p) || EMAIL.test(p.trim())) { e.preventDefault(); add(parseAddressList(p).filter((a) => EMAIL.test(a.email))); } }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && results.length) { e.preventDefault(); setOpen(true); setSel((s) => (s + 1) % results.length); }
          else if (e.key === "ArrowUp" && results.length) { e.preventDefault(); setSel((s) => (s - 1 + results.length) % results.length); }
          else if ((e.key === "Enter" || (e.key === "Tab" && text.trim())) && (text.trim() || open)) { e.preventDefault(); commit(); }
          else if (e.key === "Escape") setOpen(false);
          else if (e.key === "Backspace" && !text && value.length) remove(value[value.length - 1].email);
        }}
        onBlur={() => setTimeout(() => { setOpen(false); if (text.trim()) commit(); }, 150)} />
      {open && results.length > 0 && (
        <ul className="suggest" id={listId} role="listbox">
          {results.map((c, i) => (
            <li key={c.email} id={`${listId}-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => { e.preventDefault(); add([{ name: c.name, email: c.email }]); }}>
              <Avatar name={c.name} email={c.email} size="sm" />
              <div style={{ minWidth: 0 }}><div className="nm">{c.name || c.email}</div>{c.name && <div className="em">{c.email}</div>}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
