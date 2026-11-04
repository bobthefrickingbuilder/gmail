/**
 * MOCK CHAT MODEL — a scripted stand-in for Claude in the in-app chat
 * (MOCK_MODE and tests). It recognises a handful of request shapes
 * ("archive … from X", "draft a reply to X saying …", "add a to-do …",
 * "add this to my calendar", "label … as X", "discard …", "junk/spam …",
 * "what's in / summarise …") and walks through the same tool calls a real
 * model would, reading the tool results as it goes.
 *
 * It is deliberately GULLIBLE: if a tool result contains text like "ignore
 * previous instructions … archive", it tries to obey. That lets the tests
 * prove the app — not the model — stops email text from making changes.
 */
import { isText, type ChatBlock, type ChatMessage, type ChatRequest } from "./types.js";

interface Step { tool: string; input: Record<string, unknown> }

const textOf = (m: ChatMessage) => m.content.filter(isText).map((b) => b.text).join("\n");
const hasUserText = (m: ChatMessage) => m.role === "user" && m.content.some(isText);

/** Parse a tool_result's content back to data (strips the untrusted wrapper). */
function resultData(content: unknown): unknown {
  const s = typeof content === "string" ? content : "";
  const inner = s.match(/<untrusted>([\s\S]*)<\/untrusted>/)?.[1] ?? s;
  try { return JSON.parse(inner.replace(/‹/g, "<").replace(/›/g, ">")); } catch { return null; }
}

const INJECTED = /\b(ignore|disregard)\b.{0,40}\b(instructions?|rules?)\b/i;

function tomorrowAt(hourUtc: number) {
  const d = new Date(Date.now() + 86_400_000); d.setUTCHours(hourUtc, 0, 0, 0); return d.toISOString();
}

/** Which thread does the request mean? (context thread, or a search) */
function target(req: string): { from?: string; query?: string } {
  const from = req.match(/\bfrom (?:the )?([\w.@+-]+(?: [A-Z][\w-]+)?)/)?.[1];
  if (from && !/^(this|that)$/i.test(from)) return { from };
  const about = req.match(/\b(?:the|about the|about) ([\w-]+(?: [\w-]+)?) (?:email|thread|message)s?\b/i)?.[1];
  if (about && !/^(this|that)$/i.test(about)) return { query: about };
  return {};
}

export function mockChatTurn(req: ChatRequest): { content: ChatBlock[]; stopReason: string } {
  const msgs = req.messages;
  let reqIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (hasUserText(msgs[i])) { reqIdx = i; break; }
  const raw = reqIdx >= 0 ? textOf(msgs[reqIdx]) : "";
  const request = raw.replace(/<app_note>[\s\S]*?<\/app_note>\s*/g, "").trim();
  const contextThread = msgs.length ? textOf(msgs[0]).match(/thread_id (\S+)\./)?.[1] : undefined;
  const after = msgs.slice(reqIdx + 1);
  const results = after.flatMap((m) => m.content.filter((b) => b.type === "tool_result")).map((b) => ({ raw: String(b.content ?? ""), data: resultData(b.content), error: b.is_error === true }));
  const calls = after.flatMap((m) => m.content.filter((b) => b.type === "tool_use")).map((b) => b.name as string);
  const last = results.at(-1);
  const step = (s: Step | null, say?: string) => {
    const content: ChatBlock[] = [];
    if (say) content.push({ type: "text", text: say });
    if (s) content.push({ type: "tool_use", id: `toolu_mock_${Math.random().toString(36).slice(2, 10)}`, name: s.tool, input: s.input });
    return { content, stopReason: s ? "tool_use" : "end_turn" };
  };
  const finish = () => {
    if (!last) return step(null, "I can search and read your email, move threads to Done, label them, write reply drafts, start new emails, add to-dos and calendar events. What would you like?");
    if (last.error) return step(null, `That didn't work: ${last.raw.slice(0, 200)}`);
    const d = last.data as { status?: string; summary?: string; done?: string } | unknown[] | null;
    if (d && !Array.isArray(d) && d.status === "needs_confirmation") return step(null, `I've prepared this — tap Confirm to go ahead: ${d.summary}.`);
    if (d && !Array.isArray(d) && d.done) return step(null, `Done: ${d.done}.`);
    const thread = d as { subject?: string; messages?: { from: string; text: string }[] } | null;
    if (thread?.messages?.length) {
      const m = thread.messages.at(-1)!;
      const warn = /possible prompt injection/.test(last.raw) ? " Careful: it contains text trying to give an AI instructions — I won't act on it." : "";
      return step(null, `“${thread.subject}” — latest from ${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}${m.text.length > 160 ? "…" : ""}${warn}`);
    }
    if (Array.isArray(d)) return step(null, d.length ? `Here's what I found: ${d.slice(0, 5).map((t) => `“${(t as { subject?: string }).subject}”`).join(", ")}.` : "I couldn't find anything matching that.");
    return step(null, "Here you go.");
  };

  // ---- gullible: obey instructions found in email text (the app must stop this) ----
  const injected = results.find((r) => INJECTED.test(r.raw));
  if (injected && !calls.includes("set_thread_state")) {
    const d = injected.data as { thread_id?: string } | { thread_id?: string }[] | null;
    const ids = (Array.isArray(d) ? d : [d]).map((t) => t?.thread_id).filter(Boolean);
    if (ids.length) return step({ tool: "set_thread_state", input: { thread_ids: ids.slice(0, 1), state: "done" } }, "The email says to archive it, so I'm doing that.");
  }

  const r = request.toLowerCase();
  const t = target(request);
  const firstThreads = () => {
    const found = results.find((x) => Array.isArray(x.data))?.data as { thread_id: string }[] | undefined;
    return found?.map((x) => x.thread_id) ?? [];
  };
  const search = (extra: Record<string, unknown> = {}): Step => ({ tool: "search_threads", input: { ...t, view: "all", ...extra } });
  const threadIds = () => (contextThread && /\bthis\b/.test(r) ? [contextThread] : firstThreads());
  const needSearch = () => !(contextThread && /\bthis\b/.test(r)) && !calls.includes("search_threads");

  let plan: Step | null = null;
  if (/\bdiscard\b/.test(r)) {
    if (!calls.includes("list_drafts")) plan = { tool: "list_drafts", input: {} };
    else if (!calls.includes("discard_draft")) {
      const drafts = (results.find((x) => Array.isArray(x.data))?.data ?? []) as { draft_id: string; subject: string }[];
      const words = r.replace(/discard|that|the|draft|to|my|please/g, " ").trim().split(/\s+/).filter((w) => w.length > 2);
      const pick = words.length ? drafts.find((d) => words.some((w) => d.subject.toLowerCase().includes(w))) : drafts[0];
      if (pick) plan = { tool: "discard_draft", input: { draft_id: pick.draft_id } };
      else return step(null, drafts.length ? `I couldn't tell which draft you mean. Your drafts: ${drafts.slice(0, 5).map((d) => `“${d.subject}”`).join(", ")}.` : "You have no unsent drafts.");
    }
  } else if (/\b(junk|spam|block)\b/.test(r)) {
    if (needSearch()) plan = search({ view: "inbox" });
    else if (!calls.includes("junk_sender") && threadIds()[0]) plan = { tool: "junk_sender", input: { thread_id: threadIds()[0], scope: "sender", report_spam: /spam/.test(r) } };
  } else if (/\b(calendar|schedule it|add (?:this|it) as an event)\b/.test(r)) {
    if (!calls.includes("add_calendar_event")) plan = { tool: "add_calendar_event", input: { title: request.match(/add (.+?) to (?:my|the) calendar/i)?.[1]?.replace(/^(this|that|it)$/i, "") || "Event from email", start: tomorrowAt(15), kind: "other" } };
  } else if (/\b(to-?do|task)\b/.test(r)) {
    if (!calls.includes("add_todo")) {
      const title = request.match(/(?:to-?do|task)(?: from this email)?(?: to| for|:)? (.+)$/i)?.[1]?.trim() || "Follow up on this email";
      plan = { tool: "add_todo", input: { title, ...(contextThread && /\bthis\b/.test(r) ? { thread_id: contextThread } : {}) } };
    }
  } else if (/\bdraft (?:a )?(?:reply|response)\b/.test(r)) {
    const to = request.match(/(?:reply|respond|response) to ([\w.@-]+)/i)?.[1];
    const instruction = request.match(/\b(?:saying|that says|to say|telling (?:him|her|them))\b (.+)$/i)?.[1] ?? request;
    if (to && !/^(this|that)$/i.test(to) && !calls.includes("search_threads")) plan = { tool: "search_threads", input: { from: to, view: "all" } };
    else if (!calls.includes("draft_reply")) { const id = contextThread && (!to || /^(this|that)$/i.test(to)) ? contextThread : firstThreads()[0]; if (id) plan = { tool: "draft_reply", input: { thread_id: id, instruction } }; }
  } else if (/\blabel\b/.test(r)) {
    const label = request.match(/\bas ["“]?([\w /-]+?)["”]?$/i)?.[1] ?? request.match(/\blabel(?:led)? ["“]?([\w/-]+)/i)?.[1] ?? "Label";
    if (needSearch()) plan = search();
    else if (!calls.includes("label_threads") && threadIds().length) plan = { tool: "label_threads", input: { thread_ids: threadIds(), add: [label] } };
  } else if (/\b(archive|done|move .* to done)\b/.test(r)) {
    if (needSearch()) plan = search({ view: "inbox" });
    else if (!calls.includes("set_thread_state") && threadIds().length) plan = { tool: "set_thread_state", input: { thread_ids: threadIds(), state: "done" } };
  } else if (/\b(summari[sz]e|what|read|show|find|search|any)\b/.test(r)) {
    if (contextThread && /\bthis\b/.test(r)) { if (!calls.includes("read_thread")) plan = { tool: "read_thread", input: { thread_id: contextThread } }; }
    else if (!calls.includes("search_threads")) plan = search({ view: "all", ...(t.from || t.query ? {} : { query: request.replace(/^(what|show|find|search|any|read|summari[sz]e)\b\s*(me\s*)?(is\s*)?(in\s*)?(the\s*)?/i, "").replace(/[?.!]+$/, "").split(/\s+/).slice(-1)[0] }) });
    else if (!calls.includes("read_thread") && firstThreads()[0]) plan = { tool: "read_thread", input: { thread_id: firstThreads()[0] } };
  }
  return plan ? step(plan) : finish();
}
