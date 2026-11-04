/**
 * CHAT — ask Claude to do things in your mailbox: "archive everything from
 * this sender", "draft a reply to Raj saying yes", "add a to-do from this
 * email". Replies stream in with a line for each thing Claude did (with links
 * to the emails and drafts it touched). Anything destructive, outward-facing
 * or bulk shows a Confirm / Cancel card and only runs when you tap Confirm.
 * Claude can't send email from here: drafts wait for you in Drafts.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApi, useLive, toast } from "../hooks";
import { go } from "../router";
import { when } from "../format";
import { streamChat } from "../chatStream";
import type { ChatAction, ChatActivity, ChatDetail, ChatEvent, ChatIndex, ChatItem, ChatLink } from "../types";

export const SUGGESTIONS = [
  "What needs my attention today?",
  "Archive everything from Raj",
  "Draft a reply to Raj saying yes, Saturday works",
  "Move the dentist email to Done",
  "Label the invoice emails as Invoices",
  "Add a to-do to send Claire the Messiah scores",
  "Discard the dinner draft",
];
const THREAD_SUGGESTIONS = ["Summarise this email", "Add a to-do from this email", "Draft a reply saying yes", "Add this to my calendar", "Archive everything from this sender", "Move this to done"];

/** Start a chat (optionally about one email) and open it. */
export async function startChat(threadId?: string) {
  const c = await api<{ id: string }>("/api/chat", { method: "POST", body: threadId ? { thread_id: threadId } : {} });
  go(`/chat/${c.id}`);
}

const linkHref = (l: ChatLink) => l.kind === "thread" ? `#/thread/${l.id}` : l.kind === "draft" ? `#/thread/${l.thread_id}` : l.kind === "compose" ? `#/compose/${l.id}`
  : l.kind === "todo" ? "#/todo" : "#/calendar";

export function ChatList({ selected }: { selected?: string }) {
  const { data, error, reload } = useApi<ChatIndex>("/api/chat");
  useLive(["chat"], () => void reload());
  const remove = async (id: string, title: string) => {
    if (!window.confirm(`Delete the chat “${title || "New chat"}”?`)) return;
    try { await api(`/api/chat/${id}`, { method: "DELETE" }); if (selected === id) go("/chat"); await reload(); }
    catch (e) { toast((e as Error).message, "error"); }
  };
  return (
    <div>
      <div className="toolbar"><h1>Chat</h1>
        <button className="btn small primary" onClick={() => void startChat().catch((e) => toast((e as Error).message, "error"))}>✦ New chat</button></div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <><div className="skeleton" /><div className="skeleton" /></>}
      {data && data.chats.length === 0 && <div className="empty"><span className="big">✦</span>Ask Claude to archive, label, draft replies, add to-dos and calendar events.<br />
        <span className="small">Claude never sends email — drafts wait for you in Drafts.</span></div>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {(data?.chats ?? []).map((c, i) => (
          <li key={c.id} className="trow" style={{ ["--i" as string]: i }}>
            <div className="face chat-row" role="link" tabIndex={0} aria-current={selected === c.id ? "true" : undefined}
              onClick={() => go(`/chat/${c.id}`)} onKeyDown={(e) => { if (e.key === "Enter") go(`/chat/${c.id}`); }}>
              <span className="from">{c.title || "New chat"}</span>
              <span className="muted small">{when(c.updated_at)}</span>
              <span className="badges">
                {c.context_thread_id && <span className="badge accent">About an email</span>}
                {c.tainted && <span className="badge danger" title="An email in this chat contained instructions aimed at an AI">⚠ Cautious</span>}
                <button className="btn ghost small" style={{ marginLeft: "auto" }} aria-label={`Delete chat ${c.title}`}
                  onClick={(e) => { e.stopPropagation(); void remove(c.id, c.title); }}>Delete</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionCard({ action, onChange }: { action: ChatAction; onChange: (a: ChatAction) => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (what: "confirm" | "cancel") => {
    setBusy(true);
    try {
      const r = await api<{ status: ChatAction["status"]; activity?: ChatActivity; error?: string }>(`/api/chat/actions/${action.id}/${what}`, { method: "POST" });
      onChange({ ...action, status: r.status, result: r.activity ?? null, error: r.error ?? null });
      if (r.status === "failed") toast(r.error ?? "That didn't work", "error");
    } catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(false); }
  };
  if (action.status === "pending") return (
    <div className="chat-confirm" role="group" aria-label="Needs your confirmation">
      <div><strong>Needs your OK:</strong> {action.summary}</div>
      <div className="row" style={{ marginTop: ".45rem" }}>
        <button className="btn small primary" disabled={busy} onClick={() => void decide("confirm")}>{busy ? <span className="spinner" /> : "Confirm"}</button>
        <button className="btn small" disabled={busy} onClick={() => void decide("cancel")}>Cancel</button>
      </div>
    </div>
  );
  return (
    <div className="chat-act">
      <span aria-hidden>{action.status === "done" ? "✓" : action.status === "failed" ? "⚠" : "✕"}</span>
      <span>{action.status === "done" ? action.result?.summary ?? action.summary : action.status === "failed" ? `Failed: ${action.summary} — ${action.error ?? ""}` : `Cancelled: ${action.summary}`}</span>
      {action.result?.links.slice(0, 6).map((l) => <a key={l.kind + l.id} className="chat-link" href={linkHref(l)}>{l.label}</a>)}
    </div>
  );
}

function ActivityLine({ a }: { a: ChatActivity }) {
  const ico = a.status === "done" ? "✓" : a.status === "error" ? "⚠" : a.status === "needs_confirmation" ? "?" : "·";
  return (
    <div className={`chat-act ${a.status}`}>
      <span aria-hidden>{ico}</span><span>{a.summary}</span>
      {a.links.slice(0, 6).map((l) => <a key={l.kind + l.id} className="chat-link" href={linkHref(l)}>{l.label}</a>)}
    </div>
  );
}

export function ChatView({ id, split }: { id: string; split?: boolean }) {
  const { data, error, reload, setData } = useApi<ChatDetail>(`/api/chat/${id}`);
  const { data: index } = useApi<ChatIndex>("/api/chat");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); busyRef.current = busy;
  const end = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  useLive(["chat"], () => { if (!busyRef.current) void reload(); });
  useEffect(() => { if (data && !busy) setItems(data.items); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [items.length, busy]);
  useEffect(() => () => abort.current?.abort(), []);

  if (error) return <div className="pane"><div className="banner error">{error}</div></div>;
  if (!data) return <div className="pane empty"><span className="spinner" /></div>;
  const conv = data.conversation;

  const setAction = (a: ChatAction) => setItems((xs) => xs.map((x) => x.kind === "activity" && x.action?.id === a.id ? { ...x, action: a } : x));
  const send = async (msg: string) => {
    const t = msg.trim();
    if (!t || busy) return;
    setBusy(true); setText("");
    const stamp = new Date().toISOString(); let n = 0;
    const add = (it: ChatItem) => setItems((xs) => [...xs, it]);
    add({ kind: "user", id: `local-${stamp}`, text: t, at: stamp });
    abort.current = new AbortController();
    try {
      await streamChat(id, { text: t }, (e: ChatEvent) => {
        const key = `live-${stamp}-${n++}`;
        if (e.type === "text") add({ kind: "assistant", id: key, text: e.text, at: stamp });
        else if (e.type === "activity") add({ kind: "activity", id: key, activity: e.activity, action: e.action ?? null, at: stamp });
        else if (e.type === "notice") add({ kind: "notice", id: key, text: e.text, at: stamp });
        else if (e.type === "error") add({ kind: "notice", id: key, text: `⚠ ${e.error}`, at: stamp });
      }, abort.current.signal);
      setBusy(false);
      await reload(); // the stored version (with confirm-card states) replaces the live lines
    } catch (e) {
      setBusy(false);
      if ((e as Error).name !== "AbortError") { add({ kind: "notice", id: `err-${stamp}`, text: `⚠ ${(e as Error).message}`, at: stamp }); setText(t); }
    }
  };
  const changeModel = async (model: string) => {
    try { const c = await api<ChatDetail["conversation"]>(`/api/chat/${id}`, { method: "PATCH", body: { model } }); setData((d) => d ? { ...d, conversation: c } : d); }
    catch (e) { toast((e as Error).message, "error"); }
  };
  const suggestions = conv.context_thread_id ? THREAD_SUGGESTIONS : SUGGESTIONS;

  return (
    <div className="pane pane-anim chat-pane" key={id}>
      <div className="toolbar">
        {!split && <button className="btn small" onClick={() => go("/chat")} aria-label="Back to chats">‹</button>}
        <h2>{conv.title || "New chat"}</h2>
        {index && <><label className="sr-only" htmlFor="chat-model">Model</label>
          <select id="chat-model" value={conv.model} style={{ width: "auto" }} disabled={busy} onChange={(e) => void changeModel(e.target.value)}>
            {index.models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></>}
      </div>
      {conv.context_thread_id && <div className="banner info small">About <a href={`#/thread/${conv.context_thread_id}`}>this email</a> — “this email” means that one.</div>}
      {conv.tainted && <div className="banner error small" role="status">⚠ An email in this chat contained text trying to instruct an AI. Claude won't act on it, and every change now asks you first.</div>}
      <div className="chat-log" aria-live="polite">
        {items.length === 0 && <div className="chat-empty">
          <p className="muted">Ask Claude to do something with your email. It never sends anything — replies it writes wait in Drafts, and anything risky asks you first.</p>
          <div className="chips wrap">{suggestions.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}</div>
        </div>}
        {items.map((it) => it.kind === "user" ? <div key={it.id} className="chat-msg me">{it.text}</div>
          : it.kind === "assistant" ? <div key={it.id} className="chat-msg claude">{it.text}</div>
          : it.kind === "notice" ? <div key={it.id} className="chat-note">{it.text}</div>
          : it.action ? <ActionCard key={it.id} action={it.action} onChange={setAction} />
          : <ActivityLine key={it.id} a={it.activity} />)}
        {busy && <div className="chat-msg claude typing" aria-label="Claude is working"><span className="spinner" /> Working…</div>}
        <div ref={end} />
      </div>
      <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <label className="sr-only" htmlFor="chat-input">Message Claude</label>
        <textarea id="chat-input" rows={2} placeholder="Ask Claude… e.g. “archive everything from this sender”" value={text} maxLength={4000}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()} aria-label="Send to Claude">{busy ? <span className="spinner" /> : "↑"}</button>
      </form>
    </div>
  );
}
