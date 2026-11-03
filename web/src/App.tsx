/**
 * APP SHELL
 * - Sign-in gate (first-run setup, password + code, passkey)
 * - Auto-lock after idle time
 * - Navigation: side rail + three panes on wide landscape (iPad landscape,
 *   desktop); bottom tab bar + one screen at a time on phones and iPad portrait
 * - Live updates (SSE), offline banner, push registration, update check
 * - Screen changes animate (View Transitions where available, a fade-up otherwise)
 */
import React, { useEffect, useState } from "react";
import { api, onAuthChange, onOffline, isSignedIn, subscribeEvents, tryResume, flushQueue } from "./api";
import { liveBus, useWide, useToast } from "./hooks";
import { useRoute, go } from "./router";
import { Login, LockScreen } from "./screens/Login";
import { Inbox } from "./screens/Inbox";
import { ThreadView } from "./screens/Thread";
import { People, PersonView } from "./screens/People";
import { CalendarView } from "./screens/Calendar";
import { Settings } from "./screens/Settings";
import { Usage } from "./screens/Usage";
import { Status } from "./screens/Status";
import { Onboarding } from "./screens/Onboarding";
import { Attention } from "./screens/Attention";
import { SearchView } from "./screens/Search";
import { Share } from "./screens/Share";
import { ComposeList, ComposeEditor } from "./screens/Compose";
import { Todo } from "./screens/Todo";
import { registerPush, checkForUpdate } from "./platform";
import { APP_VERSION } from "./config";

const NAV = [
  { name: "inbox", label: "Inbox", ico: "✉︎" },
  { name: "todo", label: "To-do", ico: "☑︎" },
  { name: "calendar", label: "Calendar", ico: "▦" },
  { name: "people", label: "People", ico: "☺︎" },
  { name: "settings", label: "Settings", ico: "⚙︎" },
];

export function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [checked, setChecked] = useState(false);
  const [locked, setLocked] = useState(false);
  const [offline, setOffline] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(10);
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const route = useRoute();
  const wide = useWide();
  const toastMsg = useToast();

  useEffect(() => { void tryResume().then((ok) => { setSignedIn(ok); setChecked(true); }); }, []);
  useEffect(() => onAuthChange(() => setSignedIn(isSignedIn())), []);
  useEffect(() => onOffline(setOffline), []);

  // theme + idle lock time from settings
  useEffect(() => {
    if (!signedIn) return;
    api<{ settings: { theme: string; idle_lock_minutes: number } }>("/api/settings").then((s) => {
      document.documentElement.dataset.theme = s.settings.theme === "system" ? "" : s.settings.theme;
      setIdleMinutes(s.settings.idle_lock_minutes);
    }).catch(() => undefined);
    void registerPush().catch(() => undefined);
    void checkForUpdate().then(setUpdate).catch(() => undefined);
    void flushQueue();
    return subscribeEvents((t, d) => liveBus.emit(t, d));
  }, [signedIn]);

  // auto-lock after idle
  useEffect(() => {
    if (!signedIn) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ["pointerdown", "keydown", "scroll", "touchstart"];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const vis = () => { if (document.visibilityState === "visible" && Date.now() - last > idleMinutes * 60_000) setLocked(true); };
    document.addEventListener("visibilitychange", vis);
    const t = setInterval(() => { if (Date.now() - last > idleMinutes * 60_000) setLocked(true); }, 15_000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); document.removeEventListener("visibilitychange", vis); clearInterval(t); };
  }, [signedIn, idleMinutes]);

  if (!checked) return <div className="empty"><span className="spinner" /></div>;
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;

  const section = ["thread", "inbox", "attention", "search"].includes(route.name) ? "inbox" : route.name === "person" ? "people" : ["usage", "status", "onboarding"].includes(route.name) ? "settings" : route.name;

  let body: React.JSX.Element;
  switch (route.name) {
    case "thread":
    case "inbox":
      body = wide
        ? <div className="three"><div className="pane"><Inbox selected={route.id} query={route.query} /></div><ThreadView id={route.id} split /></div>
        : route.name === "thread" && route.id ? <div className="stack"><ThreadView id={route.id} /></div> : <div className="stack"><Inbox query={route.query} /></div>;
      break;
    case "compose":
      body = wide
        ? <div className="three" style={{ gridTemplateColumns: "minmax(300px, 27%) minmax(0, 1fr)" }}><div className="pane"><ComposeList selected={route.id} /></div>
            {route.id ? <ComposeEditor key={route.id} id={route.id} split /> : <div className="pane empty"><span className="big">✎</span>Pick an email, or start a new one.</div>}</div>
        : <div className="stack">{route.id ? <ComposeEditor key={route.id} id={route.id} /> : <ComposeList />}</div>;
      break;
    case "todo": body = <div className="stack"><Todo key="todo" view={route.id ?? "today"} /></div>; break;
    case "people": body = <div className="stack"><People /></div>; break;
    case "person": body = <div className="stack"><PersonView id={route.id!} /></div>; break;
    case "calendar": body = <div className="stack"><CalendarView /></div>; break;
    case "settings": body = <div className="stack"><Settings /></div>; break;
    case "usage": body = <div className="stack"><Usage /></div>; break;
    case "status": body = <div className="stack"><Status /></div>; break;
    case "onboarding": body = <div className="stack"><Onboarding /></div>; break;
    case "attention": body = <div className="stack"><Attention /></div>; break;
    case "search": body = <div className="stack"><SearchView q={route.query.get("q") ?? ""} /></div>; break;
    case "share": body = <div className="stack"><Share text={route.query.get("text") ?? ""} title={route.query.get("title") ?? ""} /></div>; break;
    default: go("/inbox"); body = <div />;
  }

  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="brand" aria-hidden>✦</div>
        <a className="compose-btn" href="#/compose" title="Write a new email" aria-label="Write a new email" aria-current={section === "compose" ? "page" : undefined}>✎</a>
        {NAV.map((n) => <a key={n.name} href={`#/${n.name}`} aria-current={section === n.name ? "page" : undefined}><span className="ico" aria-hidden>{n.ico}</span>{n.label}</a>)}
      </nav>
      <div className="main">
        {offline && <div className="banner offline" role="status">Offline — showing saved copies. Edits will sync when you're back online.</div>}
        {update && <div className="banner info" role="status">Version {update.version} is available (you have {APP_VERSION}). <a href={update.url} target="_blank" rel="noreferrer">Download</a></div>}
        {body}
        {section === "inbox" && !(route.name === "thread" && !wide) && <a className="fab" href="#/compose" aria-label="Write a new email" title="Write a new email">✎</a>}
        {toastMsg && <div className={`toast${toastMsg.kind === "error" ? " error" : ""}`} role="status">{toastMsg.text}</div>}
        <nav className="tabbar" aria-label="Main">
          {NAV.map((n) => <a key={n.name} href={`#/${n.name}`} aria-current={section === n.name ? "page" : undefined}><span className="ico" aria-hidden>{n.ico}</span>{n.label}</a>)}
        </nav>
      </div>
      {locked && <LockScreen onUnlock={() => setLocked(false)} />}
    </div>
  );
}
