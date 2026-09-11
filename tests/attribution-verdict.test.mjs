// `cc-usage doctor` must DECIDE whether this machine's setup can upload, not
// describe both possibilities.
//
// The bug this file exists for: a colleague signed into the SHARED account with
// a token that names nobody got "cc-usage doctor: healthy", then silent 403s on
// every upload. doctor could not tell a personal account from a shared one, so
// it printed "fine for a personal account; a SHARED account will reject" and let
// the reader guess.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { attributionVerdict } from "../cc-usage/tools/core/verify.mjs";
import { DEFAULT_WORK_DOMAIN } from "../cc-usage/tools/core/config.mjs";

const SHARED = "ai_account@nnb24.de";
const ME = "yu.zha@nnb24.de";

test("shared account + a token naming nobody is a FAILURE, not a note", () => {
  const v = attributionVerdict({
    me: SHARED, domain: "nnb24.de", operator: null,
    enrolledEmails: [SHARED], sharedAccounts: [SHARED],
  });
  assert.equal(v.level, "fail");
  assert.match(v.message, /SHARED/);
  assert.match(v.message, /cc-usage login/, "must name the command that fixes it");
});

test("shared account + a token naming a person is ok, and says who", () => {
  const v = attributionVerdict({
    me: SHARED, domain: "nnb24.de", operator: ME,
    enrolledEmails: [SHARED], sharedAccounts: [SHARED],
  });
  assert.equal(v.level, "ok");
  assert.match(v.message, new RegExp(ME.replace(".", "\\.")));
});

test("a non-work account is a deliberate note, never a failure", () => {
  // The user's own case: /login to a personal Gmail mid-session. Nothing is
  // broken and nothing should be uploaded — but silence reads as breakage.
  const v = attributionVerdict({
    me: "floraundstein.studio@gmail.com", domain: "nnb24.de", operator: null,
    enrolledEmails: [SHARED], sharedAccounts: [SHARED],
  });
  assert.equal(v.level, "note");
  assert.match(v.message, /never uploaded/);
});

test("a non-work account is judged BEFORE the token, so it never reports a 403", () => {
  // Ordering matters: this address is also not among the token's accounts, and
  // the enrolment branch would have called it a failure. It cannot be one —
  // the collector never uploads it in the first place.
  const v = attributionVerdict({
    me: "someone@gmail.com", domain: "nnb24.de", operator: null,
    enrolledEmails: [ME], sharedAccounts: [],
  });
  assert.equal(v.level, "note");
  assert.doesNotMatch(v.message, /rejected/);
});

test("a work account the token does not cover is a FAILURE", () => {
  // Previously only a `note:` line, so doctor exited 0 while every upload 403d.
  const v = attributionVerdict({
    me: "neu@nnb24.de", domain: "nnb24.de", operator: null,
    enrolledEmails: [SHARED], sharedAccounts: [SHARED],
  });
  assert.equal(v.level, "fail");
  assert.match(v.message, /not among this token/);
});

test("a personal work account is fine with no operator at all", () => {
  const v = attributionVerdict({
    me: ME, domain: "nnb24.de", operator: null,
    enrolledEmails: [ME], sharedAccounts: [],
  });
  assert.equal(v.level, "note");
  assert.doesNotMatch(v.message, /reject/);
});

test("case differences never change the verdict", () => {
  const v = attributionVerdict({
    me: "AI_Account@NNB24.de", domain: "NNB24.DE", operator: null,
    enrolledEmails: ["ai_account@nnb24.de"], sharedAccounts: ["ai_account@nnb24.de"],
  });
  assert.equal(v.level, "fail", "an upper-case sign-in must not read as a different account");
});

test("an older dashboard that omits sharedAccounts never invents a failure", () => {
  // sharedAccounts: [] is what an out-of-date deployment degrades to. Claiming
  // "shared and broken" there would be a wrong assertion, not a safe default.
  const v = attributionVerdict({
    me: SHARED, domain: "nnb24.de", operator: null,
    enrolledEmails: [SHARED], sharedAccounts: [],
  });
  assert.notEqual(v.level, "fail");
});

test("not signed in is a note, not a crash", () => {
  const v = attributionVerdict({ me: null, domain: "nnb24.de" });
  assert.equal(v.level, "note");
});

test("attributionVerdict tolerates being called with nothing", () => {
  assert.equal(attributionVerdict().level, "note");
});

test("the doctor copy of the work domain matches the bundle's", () => {
  // Two constants, two languages, one gate. The bundle decides what uploads;
  // config.mjs only decides what doctor SAYS about it. A drift would make
  // doctor describe a rule that is not the one running.
  const src = readFileSync(
    new URL("../packages/collector/src/config.ts", import.meta.url), "utf8",
  );
  const m = src.match(/DEFAULT_WORK_DOMAIN\s*=\s*"([^"]+)"/);
  assert.ok(m, "the bundle must still declare DEFAULT_WORK_DOMAIN");
  assert.equal(DEFAULT_WORK_DOMAIN, m[1]);
});
