import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { parseHash } from "../src/router";
import { insertAvailability } from "../src/components/DraftPanel";
import { SendDialog } from "../src/components/SendDialog";

describe("router", () => {
  it("parses hash routes", () => {
    const r = parseHash("#/thread/abc?x=1");
    expect(r.name).toBe("thread"); expect(r.id).toBe("abc"); expect(r.query.get("x")).toBe("1");
    expect(parseHash("").name).toBe("inbox");
  });
});

describe("insert availability", () => {
  it("replaces the availability placeholder, else inserts after the first paragraph", () => {
    expect(insertAvailability("Hi,\n\n[CONFIRM: availability]\n\nThanks", "I am free Tuesday.")).toBe("Hi,\n\nI am free Tuesday.\n\nThanks");
    expect(insertAvailability("Hi Claire,\n\nThanks.", "I am free Tuesday.")).toBe("Hi Claire,\n\nI am free Tuesday.\n\nThanks.");
  });
});

describe("send dialog", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  });
  it("shows recipients and only sends with the confirmation token after the explicit tap", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = url.endsWith("/send/prepare")
        ? { token: "tok-123456789", expiresInSeconds: 120, from: "m@x", to: [{ name: "Claire", email: "c@x.org" }], cc: [], subject: "Re: Hi", preview: "Hello", flags: [], hasPlaceholders: false }
        : { messageId: "1" };
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const onSent = vi.fn();
    render(<SendDialog draftId="d1" onClose={() => undefined} onSent={onSent} />);
    await screen.findByText("Claire <c@x.org>");
    expect(calls.map((c) => c.url)).toEqual(["/api/drafts/d1/send/prepare"]); // nothing sent yet
    fireEvent.click(screen.getByText("Send now"));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(calls[1]).toEqual({ url: "/api/drafts/d1/send", body: { token: "tok-123456789", confirm: true } });
  });
});
