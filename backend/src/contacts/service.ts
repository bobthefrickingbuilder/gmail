/**
 * CONTACTS — the address book behind "To:" autocomplete.
 * Filled from two places:
 *   1. Google contacts (saved + Gmail's "other contacts"), when the account
 *      granted contacts access
 *   2. Everyone in your synced mail: people who wrote to you, and people you
 *      wrote to (counted, so the ones you email most come first)
 * Refreshed every 6 hours by the worker and on demand from Settings.
 * Read only: nothing here changes your Google contacts.
 */
import { getDb, now, uid, pj } from "../db/index.js";
import { contactsFor } from "../providers/index.js";
import { ContactsPermissionError } from "../providers/contacts.js";
import { getSettingRaw, setSettingRaw } from "../settings.js";
import type { Address } from "../mail/types.js";

export const CONTACTS_REFRESH_MS = 6 * 60 * 60 * 1000;

export interface ContactsStatus { last_sync_at: string | null; google: "ok" | "needs_permission" | "error" | "never"; count: number; error?: string }

export async function contactsStatus(): Promise<ContactsStatus> {
  const db = await getDb();
  const s = await getSettingRaw<Omit<ContactsStatus, "count">>("contacts_sync");
  const c = await db.selectFrom("contacts").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
  return { last_sync_at: s?.last_sync_at ?? null, google: s?.google ?? "never", error: s?.error, count: Number(c?.n ?? 0) };
}

interface Seen { name: string | null; times: number; last: string | null }

/** Rebuild the contact list for every enabled account. Never throws for a missing contacts permission. */
export async function syncContacts(): Promise<ContactsStatus> {
  const db = await getDb();
  const accounts = await db.selectFrom("accounts").selectAll().where("enabled", "=", 1).execute();
  let google: ContactsStatus["google"] = "ok"; let error: string | undefined;
  for (const acc of accounts) {
    const seen = new Map<string, Seen & { source: string }>();
    const mine = new Set([acc.email.toLowerCase(), ...pj<{ email: string }[]>(acc.send_as_json, []).map((s) => s.email.toLowerCase())]);
    const bump = (a: Address, date: string, source: string) => {
      const email = a.email?.toLowerCase().trim();
      if (!email || mine.has(email) || /no-?reply|donotreply|mailer-daemon|notifications?@/i.test(email)) return;
      const cur = seen.get(email) ?? { name: null, times: 0, last: null, source };
      cur.times++; if (!cur.last || date > cur.last) cur.last = date;
      if (!cur.name && a.name) cur.name = a.name;
      seen.set(email, cur);
    };

    // 1. mail: senders of incoming mail, recipients of mail you sent (the stronger signal, so it counts double)
    const msgs = await db.selectFrom("messages").select(["from_email", "from_name", "to_json", "cc_json", "is_from_me", "date"])
      .where("account_id", "=", acc.id).execute();
    for (const m of msgs) {
      if (m.is_from_me) for (const a of [...pj<Address[]>(m.to_json, []), ...pj<Address[]>(m.cc_json, [])]) { bump(a, m.date, "mail"); bump(a, m.date, "mail"); }
      else bump({ name: m.from_name, email: m.from_email }, m.date, "mail");
    }

    // 2. Google contacts (names from Google win; they are the ones you saved)
    try {
      for (const c of await contactsFor(acc).list()) {
        const cur = seen.get(c.email);
        if (cur) { cur.source = c.source === "google" ? "google" : cur.source; if (c.name) cur.name = c.name; }
        else if (!mine.has(c.email)) seen.set(c.email, { name: c.name, times: 0, last: null, source: c.source });
      }
    } catch (e) {
      if (e instanceof ContactsPermissionError) google = "needs_permission";
      else { google = "error"; error = (e as Error).message.slice(0, 200); }
    }

    const existing = new Map((await db.selectFrom("contacts").select(["id", "email"]).where("account_id", "=", acc.id).execute()).map((r) => [r.email, r.id]));
    const ts = now();
    for (const [email, c] of seen) {
      const row = { name: c.name, source: c.source, times_contacted: c.times, last_contacted_at: c.last, updated_at: ts };
      const id = existing.get(email);
      if (id) await db.updateTable("contacts").set(row).where("id", "=", id).execute();
      else await db.insertInto("contacts").values({ id: uid(), account_id: acc.id, email, ...row }).execute();
    }
  }
  await setSettingRaw("contacts_sync", { last_sync_at: now(), google, ...(error ? { error } : {}) });
  return contactsStatus();
}

export async function syncContactsIfStale() {
  const s = await getSettingRaw<{ last_sync_at?: string }>("contacts_sync");
  if (s?.last_sync_at && Date.now() - new Date(s.last_sync_at).getTime() < CONTACTS_REFRESH_MS) return;
  await syncContacts();
}

/** Prefix match on name words and on the address; people you email most come first. */
export async function searchContacts(q: string, limit = 8) {
  const db = await getDb();
  const term = q.trim().toLowerCase().replace(/[%_]/g, "");
  if (!term) return [];
  const rows = await db.selectFrom("contacts").select(["email", "name", "source", "times_contacted", "last_contacted_at"])
    .where((eb) => eb.or([eb("email", "like", `${term}%`), eb("email", "like", `%.${term}%`), eb("email", "like", `%@${term}%`),
      eb("name", "like", `${term}%`), eb("name", "like", `% ${term}%`)]))
    .orderBy("times_contacted", "desc").orderBy("last_contacted_at", "desc").limit(limit * 4).execute();
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true))).slice(0, limit)
    .map((r) => ({ email: r.email, name: r.name, source: r.source }));
}
