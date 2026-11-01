import { describe, it, expect, beforeEach } from "vitest";
import { setup } from "./helpers.js";
import { findOrCreatePerson, editPerson, mergePeople, splitPerson, deletePerson, proposeUpdate, applyProposal, revertTo, sanitizeSnapshot, snapshotOf, capWords } from "../src/profiles/service.js";
import { sensitiveKind } from "../src/profiles/sensitive.js";
import { saveSettings } from "../src/settings.js";

describe("sensitive-data filter", () => {
  it("detects health, financial, government ID data", () => {
    expect(sensitiveKind("His SIN is 123 456 789")).toBe("government_id");
    expect(sensitiveKind("card 4111 1111 1111 1111")).toBe("financial");
    expect(sensitiveKind("She was diagnosed with diabetes")).toBe("health");
    expect(sensitiveKind("Prefers Tuesday rehearsals")).toBeNull();
  });
  it("scrubs snapshots and reports what was removed (not the text)", () => {
    const { snapshot, report } = sanitizeSnapshot({ display_name: "A", organization: null, role: null, relationship: null, formality: null, tone: null, language: null,
      summary: "Choir parent. Her bank account number is 12345. Likes Bach.", data: { topics: [], commitments: [], facts: ["Has cancer", "Plays cello"], do_not_mention: [], response_expectations: null } });
    expect(snapshot.summary).toBe("Choir parent. Likes Bach.");
    expect(snapshot.data.facts).toEqual(["Plays cello"]);
    expect(report.removed.map((r) => r.kind).sort()).toEqual(["financial", "health"]);
  });
  it("caps summary length", () => { expect(capWords("w ".repeat(400)).split(" ").length).toBeLessThanOrEqual(301); });
});

describe("profiles", () => {
  beforeEach(async () => { await setup({ seed: false }); });

  it("one person per normalized address", async () => {
    const a = await findOrCreatePerson("Claire@Choir.org", "Claire");
    const b = await findOrCreatePerson("claire@choir.org", null);
    expect(a.id).toBe(b.id);
  });

  it("edits create versions; revert restores; notes are kept out of versions", async () => {
    const p = await findOrCreatePerson("c@x.org", "Claire");
    await editPerson(p.id, { summary: "Version one.", notes_to_assistant: "Offer two options." });
    await editPerson(p.id, { summary: "Version two." });
    const { getDb } = await import("../src/db/index.js");
    const db = await getDb();
    const versions = await db.selectFrom("profile_versions").selectAll().where("person_id", "=", p.id).orderBy("version").execute();
    expect(versions.map((v) => v.status)).toEqual(["superseded", "applied"]);
    await revertTo(versions[0].id);
    const now = await db.selectFrom("people").selectAll().where("id", "=", p.id).executeTakeFirstOrThrow();
    expect(now.summary).toBe("Version one.");
    expect(now.notes_to_assistant).toBe("Offer two options.");
    expect(JSON.stringify(versions.map((v) => v.snapshot_json))).not.toContain("Offer two options");
  });

  it("model proposals wait for approval by default, auto-apply when enabled, never touch notes", async () => {
    const p = await findOrCreatePerson("c@x.org", "Claire");
    await editPerson(p.id, { notes_to_assistant: "Never mention fees." });
    const v = await proposeUpdate(p.id, ["Agreed to sing Messiah"], "context");
    const { getDb } = await import("../src/db/index.js");
    const db = await getDb();
    expect((await db.selectFrom("profile_versions").select("status").where("id", "=", v.id).executeTakeFirstOrThrow()).status).toBe("proposed");
    expect((await db.selectFrom("people").select("summary").where("id", "=", p.id).executeTakeFirstOrThrow()).summary).toBe("");
    await applyProposal(v.id);
    const after = await db.selectFrom("people").selectAll().where("id", "=", p.id).executeTakeFirstOrThrow();
    expect(after.summary).toContain("Agreed to sing Messiah");
    expect(after.notes_to_assistant).toBe("Never mention fees.");
    await saveSettings({ auto_apply_profile_updates: true });
    const v2 = await proposeUpdate(p.id, ["New fact"], "ctx");
    expect((await db.selectFrom("profile_versions").select("status").where("id", "=", v2.id).executeTakeFirstOrThrow()).status).toBe("applied");
  });

  it("merge combines addresses and facts; split separates; delete removes derived data", async () => {
    const { getDb } = await import("../src/db/index.js");
    const db = await getDb();
    const a = await findOrCreatePerson("claire@work.org", "Claire");
    const b = await findOrCreatePerson("claire@home.net", "Claire D");
    await editPerson(a.id, { data: { facts: ["Conducts City Choir"] } as never });
    await editPerson(b.id, { data: { facts: ["Has a dog named Bach"] } as never, notes_to_assistant: "personal address" });
    await mergePeople(a.id, b.id);
    const merged = await db.selectFrom("people").selectAll().where("id", "=", a.id).executeTakeFirstOrThrow();
    expect(snapshotOf(merged).data.facts).toEqual(["Conducts City Choir", "Has a dog named Bach"]);
    expect(merged.notes_to_assistant).toBe("personal address");
    expect((await db.selectFrom("person_addresses").select("email").where("person_id", "=", a.id).execute()).length).toBe(2);
    expect(await db.selectFrom("people").select("id").where("id", "=", b.id).executeTakeFirst()).toBeUndefined();
    const nid = await splitPerson(a.id, ["claire@home.net"]);
    expect((await db.selectFrom("person_addresses").select("person_id").where("email", "=", "claire@home.net").executeTakeFirstOrThrow()).person_id).toBe(nid);
    await expect(splitPerson(a.id, ["claire@work.org"])).rejects.toThrow(); // can't split off everything
    await db.insertInto("pinned_docs").values({ id: "d1", person_id: a.id, title: "t", content: "c", created_at: "x" }).execute();
    await deletePerson(a.id);
    expect(await db.selectFrom("pinned_docs").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("profile_versions").selectAll().where("person_id", "=", a.id).execute()).toEqual([]);
  });
});
