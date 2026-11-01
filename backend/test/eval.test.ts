import { describe, it, expect } from "vitest";
import { runChecks, possibleFabrications, similarity } from "../src/eval/checks.js";
import { buildReplyMime } from "../src/mail/mime.js";

const mime = (body: string, inReplyTo: string | null = "<m1@x>", sig: string | null = "Matthew Menard\n613-863-9796") => buildReplyMime({
  from: { name: null, email: "m@x" }, to: [{ name: "Claire", email: "c@x.org" }], cc: [], subject: "Re: Messiah",
  inReplyTo, references: inReplyTo, bodyText: body, signatureText: sig, signatureHtml: null }, "seed");
const base = { sources: ["Can you do Tuesday 17 November at 7 pm? Fee is $400."], eventSummaries: ["Opera Lyra rehearsal — Nov 18"],
  expectedInReplyTo: "<m1@x>", expectedTo: ["c@x.org"], signatureText: "Matthew Menard", formal: true };

describe("eval checks", () => {
  it("a clean draft passes everything", () => {
    const d = "Hi Claire,\n\nTuesday at 7 pm works. The $400 fee is fine.";
    expect(Object.values(runChecks({ ...base, draft: d, mime: mime(d) })).filter(Boolean)).toEqual([]);
  });
  it("catches fabrication, disclosure, filler, sign-off, contractions, threading, missing signature", () => {
    const d = "Hi Claire,\n\nI really can't do the 18th because of the Opera Lyra rehearsal. My fee is $650 and I'm free Friday at 3 pm.\n\nBest,\nMatthew";
    const r = runChecks({ ...base, draft: d, mime: mime(d, null, null), expectedInReplyTo: "<m1@x>" });
    expect(r.possible_fabrication).toMatch(/\$650/);
    expect(r.possible_fabrication).toMatch(/friday/);
    expect(r.schedule_disclosure).toMatch(/Opera Lyra/);
    expect(r.filler_words).toMatch(/really/);
    expect(r.extra_signoff).not.toBeNull();
    expect(r.contractions_in_formal).toMatch(/can't/);
    expect(r.wrong_threading).toMatch(/In-Reply-To/);
    expect(r.missing_signature).not.toBeNull();
  });
  it("placeholders are not fabrications; similarity is sane", () => {
    expect(possibleFabrications("Fee: [CONFIRM: $500]", [])).toEqual([]);
    expect(similarity("yes tuesday works fine", "yes tuesday works fine").jaccard).toBe(1);
  });
});
