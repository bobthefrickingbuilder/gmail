/**
 * PROVIDER REGISTRY — hands out the right mail/calendar/LLM implementation:
 * mock ones in MOCK_MODE (or for accounts created in mock mode), real ones
 * otherwise. Tests can inject their own instances with setProviders().
 */
import { env } from "../config.js";
import type { MailProvider } from "./mail/types.js";
import type { CalendarProvider } from "./calendar/types.js";
import type { LlmProvider } from "./llm/types.js";
import { MockMailProvider } from "./mail/mock.js";
import { MockCalendarProvider } from "./calendar/mock.js";
import { MockLlmProvider } from "./llm/mock.js";
import { GoogleMailProvider } from "./mail/google.js";
import { GoogleCalendarProvider } from "./calendar/google.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { GoogleContactsProvider, MockContactsProvider, type ContactsProvider } from "./contacts.js";

const mailCache = new Map<string, MailProvider>();
const calCache = new Map<string, CalendarProvider>();
let llm: LlmProvider | null = null;
let mockMail: MockMailProvider | null = null;
let mockCal: MockCalendarProvider | null = null;
let mockContacts: MockContactsProvider | null = null;

export function getMockMail() { return (mockMail ??= new MockMailProvider()); }
export function getMockCalendar() { return (mockCal ??= new MockCalendarProvider()); }

export function mailFor(account: { id: string; provider: string }): MailProvider {
  if (account.provider === "mock") return getMockMail();
  let p = mailCache.get(account.id);
  if (!p) { p = new GoogleMailProvider(account.id); mailCache.set(account.id, p); }
  return p;
}
export function calendarFor(account: { id: string; provider: string }): CalendarProvider {
  if (account.provider === "mock") return getMockCalendar();
  let p = calCache.get(account.id);
  if (!p) { p = new GoogleCalendarProvider(account.id); calCache.set(account.id, p); }
  return p;
}
export function contactsFor(account: { id: string; provider: string }): ContactsProvider {
  if (account.provider === "mock") return (mockContacts ??= new MockContactsProvider());
  return new GoogleContactsProvider(account.id);
}
export function getLlm(): LlmProvider {
  if (!llm) llm = env().MOCK_MODE ? new MockLlmProvider() : new AnthropicProvider();
  return llm;
}
/** Drop cached clients (e.g. after reconnecting Google). */
export function resetProviderCache(accountId?: string) {
  if (accountId) { mailCache.delete(accountId); calCache.delete(accountId); } else { mailCache.clear(); calCache.clear(); }
}
export function setProviders(p: { mail?: MockMailProvider | null; calendar?: MockCalendarProvider | null; llm?: LlmProvider | null }) {
  if (p.mail !== undefined) mockMail = p.mail;
  if (p.calendar !== undefined) mockCal = p.calendar;
  if (p.llm !== undefined) llm = p.llm;
}
