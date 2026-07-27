// Tiny RSS 2.0 / Atom 1.0 reader. Deliberately not a general XML parser — it
// only needs to survive the two shapes we actually consume:
//   * Google News  -> RSS 2.0  <item><title><link><pubDate><source>
//   * old.reddit   -> Atom 1.0 <entry><title><link href=><updated><content>
// Keeping it here avoids a dependency for ~60 lines of work.

import { decodeEntities, stripTags } from "./text.mjs";

function blocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  // Unwrap CDATA if present.
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return decodeEntities(v).trim();
}

function attr(block, tag, name) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

/**
 * Parse a feed document into normalised items.
 * @returns {Array<{title:string, link:string, published:number|null, summary:string, author:string, sourceName:string}>}
 */
export function parseFeed(xml) {
  if (!xml || typeof xml !== "string") return [];
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const items = isAtom ? blocks(xml, "entry") : blocks(xml, "item");

  return items.map((b) => {
    const title = tagText(b, "title");
    const link = isAtom ? attr(b, "link", "href") || tagText(b, "id") : tagText(b, "link");
    const dateRaw = isAtom
      ? tagText(b, "updated") || tagText(b, "published")
      : tagText(b, "pubDate") || tagText(b, "dc:date");
    const ts = dateRaw ? Date.parse(dateRaw) : NaN;
    const rawSummary =
      tagText(b, "content") || tagText(b, "summary") || tagText(b, "description");
    // Atom <author><name>x</name></author>; reddit puts /u/name there.
    const author = tagText(b, "name") || tagText(b, "dc:creator") || "";
    return {
      title,
      link,
      published: Number.isNaN(ts) ? null : ts,
      summary: stripTags(rawSummary).slice(0, 1200),
      author,
      sourceName: tagText(b, "source") || "",
    };
  }).filter((i) => i.title || i.summary);
}
