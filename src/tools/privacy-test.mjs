// Verify SPEC §6 enforcement against the real corpus.
//
// Every input below is a verbatim post or comment recovered from the live
// internet on 2026-07-26, including the deliberate decoys from the 2026-07-18
// r/Seattle location-flooding campaign and the satirical Laurelhurst post that
// carries the dedicated subreddit's own RECENT SIGHTING flair.
//
//   node src/tools/privacy-test.mjs

import { redactCoordinates, snapToZone } from "../engine/privacy.mjs";
import { resolvePlaces, ZONES } from "../engine/gazetteer.mjs";
import { extract } from "../engine/extract.mjs";
import { PRIVACY } from "../config.mjs";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
};

const item = (title, text = "", origin = "forum") =>
  ({ title, text, origin, url: "https://example.test/x", images: [], meta: {} });

console.log("\n1. COORDINATE REDACTION — real inbound strings\n");

// r/SeattleWA 1v6l8wr, verbatim body.
const r1 = redactCoordinates("47.69121° N, 122.34483° W I SAW HIM HERE");
ok(!/47\.69121/.test(r1.text) && !/122\.34483/.test(r1.text),
   "hemisphere-marked pair is stripped", r1.text);
ok(r1.redacted === 1, "counted exactly one redaction", `got ${r1.redacted}`);
ok(r1.wasLocal, "flagged as inside Puget Sound");

const r2 = redactCoordinates("saw him at 47.66600, -122.39780 last night");
ok(!/47\.666/.test(r2.text), "signed decimal pair is stripped", r2.text);

const r3 = redactCoordinates(`47°41'28"N 122°20'41"W`);
ok(!/41'28/.test(r3.text), "DMS is stripped", r3.text);

// Must not mangle ordinary prose.
const r4 = redactCoordinates("$JIMOTHY is up 186% to a 11.2, 38.5 million cap");
ok(r4.redacted === 0, "does not redact ordinary numbers", r4.text);
const r5 = redactCoordinates("he weighs 12.5 lbs and is 2.3 feet long");
ok(r5.redacted === 0, "does not redact measurements", r5.text);

console.log("\n2. NO LOCATION FINER THAN A ZONE ESCAPES resolvePlaces()\n");

const finer = [];
const probes = [
  "spotted him at 24th Ave NW & NW 70th St",
  "he was on 15th Ave NW and NW 65th St",
  "saw him near NW 85th St",
  "crossing 20th Ave NW",
  "by the Ballard Locks",
  "at Golden Gardens",
  "somewhere in Ballard",
];
for (const p of probes) {
  for (const place of resolvePlaces(p)) {
    const named = ZONES.some((z) => z.zone === place.zone);
    if (!named) finer.push(`${p} -> "${place.zone}"`);
    if ((place.radius ?? 0) < PRIVACY.minZoneRadiusM) {
      finer.push(`${p} -> radius ${place.radius}m < ${PRIVACY.minZoneRadiusM}m`);
    }
  }
}
ok(finer.length === 0, "every resolved place is a named zone at >= minZoneRadiusM",
   finer.join("\n        "));

const cross = resolvePlaces("spotted him at 24th Ave NW & NW 70th St")[0];
ok(cross && !/&/.test(cross.zone), "cross-street is not emitted as a zone name",
   `zone = "${cross?.zone}"`);
ok(cross?.precision === "street" && cross?.gridRef === true,
   "cross-street is recorded as a street-level reference, blurred");

console.log("\n3. SNAPPING\n");
const snapped = snapToZone(47.6690, -122.3878, ZONES);
ok(ZONES.some((z) => z.zone === snapped.zone), "snap returns a named zone");
ok(snapped.radius >= PRIVACY.minZoneRadiusM, "snap radius respects the floor");

console.log("\n4. THE POISONING CAMPAIGN — decoys must not outrank honest reports\n");

// Verbatim, r/Seattle 1uxnd2c, +377. The best genuine report in the corpus.
// Prefixed with the thread title, because that is how it reaches extract() in
// production — fetchRedditComments passes comments as extraText alongside the
// parent post, and extract() requires the name to appear somewhere in the blob.
const honest = extract(item(
  "Jimothy the raccoon megathread",
  "I've seen this dude in our Ballard backyard multiple times over the past year or so. He usually hangs out in our apple tree"));

// Verbatim decoys from the 2026-07-18 flood, with their real scores.
const decoyTacoma = extract(item("I just saw Jimothy at the Museum of Glass in Tacoma"));
const decoyFremont = extract(item("Jimothy is living under the Fremont Troll, I saw him this morning"));

// r/JimothyTheRaccoon 1v243is, +218, flaired RECENT SIGHTING. Satire.
const satire = extract(item(
  "ATTENTION: Jimothy has been spotted multiple times today in LAURELHURST",
  "OP is very obviously being ironic/sarcastic. Whoosh."));

console.log(`     honest Ballard backyard report : ${honest.score.toFixed(3)}  ${honest.band}`);
console.log(`     decoy — Tacoma                 : ${decoyTacoma.score.toFixed(3)}  ${decoyTacoma.band}`);
console.log(`     decoy — Fremont Troll          : ${decoyFremont.score.toFixed(3)}  ${decoyFremont.band}`);
console.log(`     satire — Laurelhurst (+218)    : ${satire.score.toFixed(3)}  ${satire.band}`);

ok(honest.score > decoyTacoma.score, "honest report outranks the Tacoma decoy");
ok(honest.score > decoyFremont.score, "honest report outranks the Fremont decoy");
ok(honest.score > satire.score, "honest report outranks the flaired satire");
ok(satire.band === "MENTION" || satire.band === "UNVERIFIED",
   "satire does not reach PROBABLE", `band = ${satire.band}`);

console.log("\n5. A COORDINATE IN A TITLE NEVER REACHES A SCORE OR A ZONE\n");
const coordItem = extract(item("Jimothy: 47.69121° N, 122.34483° W I SAW HIM HERE"));
const leaked = (coordItem.places || []).filter((p) => !ZONES.some((z) => z.zone === p.zone));
ok(leaked.length === 0, "no raw coordinate becomes a place");
ok((coordItem.why || []).some((w) => w.k.startsWith("coordinates-redacted")),
   "redaction is recorded in the audit trail");

console.log(`\n${"-".repeat(60)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
