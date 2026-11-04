/** GET /api/drafts: one list of every unsent draft (AI replies + new emails), filterable, never including sent or discarded ones. */
import { describe, it, expect, beforeEach } from "vitest";
import { setup, authedServer } from "./helpers.js";
import { pollOnce } from "../src/worker/index.js";

beforeEach(async () => { await setup(); });

describe("drafts list", () => {
  it("lists reply drafts and new emails together, filters by kind and text, and drops discarded ones", async () => {
    const { call } = await authedServer();
    await pollOnce(); // mock mail → Claude writes reply drafts
    const c = (await call("POST", "/api/compose", { to: [{ name: "Raj Patel", email: "raj@example.net" }], subject: "Zebra plans", body: "Hello Raj" })).json();

    const all = (await call("GET", "/api/drafts")).json() as { kind: string; id: string; thread_id: string | null; subject: string; model_key: string | null }[];
    const replies = all.filter((d) => d.kind === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.every((d) => d.thread_id && d.model_key)).toBe(true);
    expect(all.find((d) => d.kind === "new")?.id).toBe(c.id);

    expect((await call("GET", "/api/drafts?kind=new")).json()).toHaveLength(1);
    expect((await call("GET", "/api/drafts?kind=reply")).json()).toHaveLength(replies.length);
    const hit = (await call("GET", "/api/drafts?q=zebra")).json();
    expect(hit).toHaveLength(1);
    expect(hit[0].subject).toBe("Zebra plans");

    await call("DELETE", `/api/drafts/${replies[0].id}`);
    await call("DELETE", `/api/compose/${c.id}`);
    const after = (await call("GET", "/api/drafts")).json() as { id: string }[];
    expect(after).toHaveLength(replies.length - 1);
    expect(after.some((d) => d.id === replies[0].id || d.id === c.id)).toBe(false);
  });
});
