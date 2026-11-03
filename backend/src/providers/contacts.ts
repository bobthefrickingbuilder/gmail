/**
 * CONTACTS PROVIDER — your Google contacts, for address autocomplete.
 * Two lists, like Gmail's own autocomplete:
 *   google = contacts you saved (People API connections)
 *   other  = "Other contacts" Gmail saved automatically when you emailed someone
 * Needs the contacts.readonly + contacts.other.readonly scopes; without them
 * the call fails with 403 and the app falls back to addresses from your mail.
 */
import { google } from "googleapis";
import { authorizedClient } from "../google/oauth.js";
import { withRetry } from "../retry.js";

export interface RemoteContact { email: string; name: string | null; source: "google" | "other" }

export class ContactsPermissionError extends Error { constructor() { super("Contacts access not granted"); } }

export interface ContactsProvider { list(): Promise<RemoteContact[]> }

export class GoogleContactsProvider implements ContactsProvider {
  constructor(private accountId: string) {}
  async list(): Promise<RemoteContact[]> {
    const people = google.people({ version: "v1", auth: await authorizedClient(this.accountId) });
    const out: RemoteContact[] = [];
    const add = (source: RemoteContact["source"], p: { names?: { displayName?: string | null }[]; emailAddresses?: { value?: string | null }[] }) => {
      const name = p.names?.[0]?.displayName ?? null;
      for (const e of p.emailAddresses ?? []) if (e.value) out.push({ email: e.value.toLowerCase().trim(), name, source });
    };
    try {
      let pageToken: string | undefined;
      do {
        const r = await withRetry(() => people.people.connections.list({ resourceName: "people/me", personFields: "names,emailAddresses", pageSize: 1000, pageToken }));
        (r.data.connections ?? []).forEach((p) => add("google", p));
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken);
      pageToken = undefined;
      do {
        const r = await withRetry(() => people.otherContacts.list({ readMask: "names,emailAddresses", pageSize: 1000, pageToken }));
        (r.data.otherContacts ?? []).forEach((p) => add("other", p));
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (e) {
      const status = (e as { response?: { status?: number }; code?: number }).response?.status ?? (e as { code?: number }).code;
      if (status === 403) throw new ContactsPermissionError();
      throw e;
    }
    return out;
  }
}

export class MockContactsProvider implements ContactsProvider {
  contacts: RemoteContact[] = [
    { email: "sarah.chen@orchestra.example", name: "Sarah Chen", source: "google" },
    { email: "luc.tremblay@example.ca", name: "Luc Tremblay", source: "google" },
    { email: "booking@ottawavenue.example", name: "Ottawa Venue Bookings", source: "other" },
  ];
  async list() { return this.contacts; }
}
