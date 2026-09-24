// app/_lib/ai-crawlers.ts — the AI crawler product tokens app/robots.ts blocks SITE-WIDE.
//
// ═══ DECISION (Jon, 2026-09-24) ═══
// AI crawlers are blocked from the whole site, and "it's fine that it blocks AI assistant
// answers". Normal search engines (Googlebot, Bingbot, Applebot, DuckDuckBot, …) stay allowed and
// keep getting the `User-Agent: *` group. The trigger was the Vercel cost spike: GPTBot walking
// /search filter permutations was ~96% of the Aug–Sep bill.
//
// ═══ HOW THESE ARE MATCHED (RFC 9309 §2.2.1) ═══
// A crawler obeys ONLY the group whose User-Agent line matches its product token
// (case-insensitive), falling back to `*` only when none matches. Groups are not merged. So:
//   - each token here gets `Disallow: /` and nothing else, and that alone covers /search too;
//   - a token that is NOT here (Googlebot, Bingbot, Applebot, facebookexternalhit, …) is
//     untouched by this list and keeps the `*` group's rules.
// Matching is on the whole token, so `Applebot-Extended` does not capture `Applebot` and
// `Google-Extended` does not capture `Googlebot` (both vendors document exactly this; see below).
//
// ═══ robots.txt IS A REQUEST, NOT A LOCK ═══
// Several user-initiated fetchers say in their own docs that they may ignore robots.txt:
// ChatGPT-User, Perplexity-User, Meta-ExternalFetcher and Amzn-User. They are listed anyway, since
// listing them costs nothing and states the site's policy. Enforcing it takes a firewall rule
// (the Vercel Firewall AI-bot ruleset, recommendation 2 of the cost investigation), not this file.
//
// Sources (fetched 2026-09-24):
//   OpenAI     https://developers.openai.com/api/docs/bots
//   Anthropic  https://support.claude.com/en/articles/8896518
//   Perplexity https://docs.perplexity.ai/guides/bots
//   Google     https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
//   Apple      https://support.apple.com/en-us/119829
//   Meta       https://developers.facebook.com/docs/sharing/webmasters/web-crawlers
//   Amazon     https://developer.amazon.com/amazonbot
//   Common Crawl https://commoncrawl.org/ccbot
//   DuckDuckGo https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
//   Mistral    https://docs.mistral.ai/robots
//   Cohere     https://docs.cohere.com/docs/cohere-web-crawlers
//   Webz.io    https://webz.io/bot.html
//   Third-party (no vendor page found): https://knownagents.com/agents/bytespider,
//              https://knownagents.com/agents/diffbot, https://knownagents.com/agents/omgilibot

export const AI_CRAWLER_USER_AGENTS = [
  // OpenAI
  'GPTBot', //           model training
  'OAI-SearchBot', //    ChatGPT search
  'ChatGPT-User', //     user-initiated fetches; OpenAI: "robots.txt rules may not apply"
  // Anthropic
  'ClaudeBot', //        model training
  'Claude-User', //      user-initiated fetches
  'Claude-SearchBot', // Claude search
  'Claude-Web', //       legacy token; not in Anthropic's current list, kept for older agents
  'anthropic-ai', //     legacy token; same
  // Perplexity
  'PerplexityBot', //    Perplexity search index
  'Perplexity-User', //  user-initiated; Perplexity: "generally ignores robots.txt rules"
  // Google: a CONTROL TOKEN, not a crawler. Googlebot does the fetching and still follows `*`.
  // Google: it "does not impact a site's inclusion in Google Search nor is it used as a ranking signal".
  'Google-Extended', //  Gemini training and grounding
  'Google-CloudVertexBot', // Vertex AI Agents; Google: no impact on Search
  // Apple: Applebot-Extended "does not crawl webpages"; it controls AI-training use of what
  // Applebot fetched. Apple: pages that disallow it "can still be included in search results".
  'Applebot-Extended',
  // Meta. NOT facebookexternalhit: that is the link-preview fetcher for shares on
  // Facebook/Instagram/Messenger, and blocking it would break every shared KIDS FUN link.
  'meta-externalagent', // model training
  'Meta-ExternalFetcher', // user-initiated; Meta: "may bypass robots.txt rules"
  'Meta-WebIndexer', //  Meta AI search
  'FacebookBot', //      legacy token; no longer on Meta's crawler page, kept for older agents
  // Amazon
  'Amazonbot', //        Amazon: "may train Amazon AI models"
  'Amzn-SearchBot', //   Alexa / Amazon-product search (not a public web search engine); judgment call, see IMPL doc
  'Amzn-User', //        user-initiated Alexa fetches; Amazon: "may not follow all robots.txt directives"
  // Others
  'CCBot', //            Common Crawl, the most widely used open training corpus
  'Bytespider', //       ByteDance (Doubao) training
  'DuckAssistBot', //    DuckDuckGo AI answers. DuckDuckBot (search) is separate and stays allowed.
  'MistralAI-User', //   Mistral user-initiated
  'MistralAI-Index', //  Mistral search
  'MistralAI-Training', // Mistral training
  'cohere-ai', //        Cohere says it runs no crawler today; token kept (harmless, per the brief)
  'Diffbot', //          knowledge-graph extraction, sold for AI training
  'Omgilibot', //        Webz.io legacy token
  'Webzio-Extended', //  Webz.io's AI-use control token
] as const;
