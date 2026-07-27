// Verify the recognition filter end-to-end against one image.
//
//   OPENROUTER_API_KEY=... node src/tools/vision-test.mjs
//   OPENROUTER_API_KEY=... node src/tools/vision-test.mjs <image-url>
//
// With no URL it pulls the most recent real iNaturalist raccoon photo near
// Ballard, so the test exercises the exact path production uses.

import * as recog from "../engine/recognise.mjs";
import { inaturalistSource } from "../sources/wildlife.mjs";

const st = recog.status();
console.log(`vision: ${st.enabled ? `${st.provider}` : "DISABLED — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY"}`);
if (st.enabled) console.log(`  triage: ${st.triageModel}\n  id:     ${st.idModel}`);
if (!st.enabled) process.exit(1);

let url = process.argv[2];
if (!url) {
  console.log("\nno url given — pulling the latest real Ballard raccoon photo from iNaturalist…");
  const items = await inaturalistSource.fetch();
  const withPhoto = items.filter((i) => !i.meta.baseline && i.images?.length)[0]
    || items.filter((i) => i.images?.length)[0];
  if (!withPhoto) {
    console.error("no iNaturalist observation with a photo found");
    process.exit(1);
  }
  url = withPhoto.images[0];
  console.log(`  ${withPhoto.url}`);
}

console.log(`\nscoring: ${url}\n`);
const t0 = Date.now();
const r = await recog.recogniseImage(url);
console.log(JSON.stringify(r, null, 2));
console.log(`\n${Date.now() - t0}ms · status=${r.status}`);
