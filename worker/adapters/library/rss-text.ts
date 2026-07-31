// worker/adapters/library/rss-text.ts — dependency-free XML/HTML text helpers shared
// by the library family's RSS platform handlers.
//
// WHY THIS EXISTS (extracted, not duplicated — same rationale as worker/core/time.ts)
// These helpers were private to the BiblioCommons parser in ./index.ts. The NVDPL
// `generic_rss` handler needs the identical primitives, so they moved here rather than
// being copied: a second copy of an entity-decoding table is a second copy that can rot
// independently, and both handlers must agree on what "the text of this node" means.
//
// A small regex extractor (rather than an XML-parser dependency) keeps the worker
// runtime at pg + puppeteer-core with no lockfile churn, and matches the style the
// library adapter already used.

/**
 * Decode ONE layer of XML text: unwrap CDATA and resolve the five predefined XML
 * entities plus the handful of numeric/HTML ones our feeds actually emit.
 *
 * ONE LAYER IS DELIBERATE. `&amp;` → `&` must not then be re-scanned, or a literal
 * "&amp;amp;" in source data would silently collapse two levels. Callers that need a
 * second layer (an RSS feed whose <description> contains ESCAPED HTML markup, e.g.
 * NVDPL's `&lt;p&gt;&lt;strong&gt;`) ask for it explicitly by decoding, then calling
 * stripHtml on the result — see genericRssItemText().
 */
export function decodeXmlText(value = ''): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Inner text of every `<tag>…</tag>` occurrence, raw (not entity-decoded). */
export function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) out.push(match[1]);
  return out;
}

/** Entity-decoded inner text of the FIRST `<tag>…</tag>`, or undefined if absent. */
export function firstTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = re.exec(xml);
  return match ? decodeXmlText(match[1]) : undefined;
}

/** A numeric character reference's character, or the reference verbatim if out of range. */
function codePointOrRaw(raw: string, codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0xffff) return raw;
  return String.fromCharCode(codePoint);
}

/** Collapse HTML markup + the entities that survive one decode pass into plain text. */
export function stripHtml(html = ''): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    // Literal U+00A0 (NBSP): NVDPL emits `&amp;nbsp;`, which decodes to `&nbsp;` above,
    // but the feed also carries bare NBSP bytes. Normalise both to a plain space.
    .replace(/\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&quot;/g, '"')
    // Numeric character references, decimal and hex. NVDPL's descriptions are
    // WYSIWYG-authored, so which entities appear is not a closed set — a raw `&ndash;`
    // leaked into an ageText field before this existed. Bounded to the BMP; anything
    // out of range is left as-is rather than turned into a replacement character.
    .replace(/&#(\d{1,7});/g, (m, dec) => codePointOrRaw(m, Number(dec)))
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (m, hex) => codePointOrRaw(m, Number.parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Finite float or undefined — never NaN leaking into a coordinate field. */
export function finiteFloat(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}
