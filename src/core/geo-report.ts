// GEO report in the jev-seo report model (shoper-growth-mcp decision 19):
// the same top-level shape as jev-seo audit.json (schema_version, tool, run,
// site, scores, actions), so one importer reads both. Actions carry GEO-###
// IDs, priority P1-P3, impact, effort, evidence, fix, source and a to_verify
// flag; scores state their method and are never traffic predictions; AI
// visibility is a rate with n answers, runs, window, engine and market.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Brand, ComparisonEvidenceRow, Db } from '../db/types.js';
import { brandMarket } from './market.js';
import { findTermSetMatchIndex } from './openai.js';
import { auditSite, MAX_CRAWL_LIMIT, type SiteCheck } from './site-audit.js';

type Severity = 'critical' | 'high' | 'medium' | 'low';
// Same weights and priority rules as jev-seo (jevseo/checks.py, score.py).
const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 6, medium: 3, low: 1 };

const G = 'https://developers.google.com/search/docs';
const HEADINGS = 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/Heading_Elements';
const SD = `${G}/appearance/structured-data/intro-structured-data`;

type Rule = { category: string; severity: Severity; effort: number; title: string; fix: string; source: string; heuristic?: boolean };

// One rule per AEO check. llms-txt and rss-feed have none: no evidence that either
// moves AI answers (decision 18), so they never become an action.
export const CHECK_RULES: Record<string, Rule> = {
  'ai-bot-access': { category: 'crawl', severity: 'critical', effort: 1, title: 'AI crawlers blocked in robots.txt',
    fix: 'Allow OAI-SearchBot, ChatGPT-User, GPTBot, ClaudeBot and PerplexityBot in robots.txt.',
    source: 'https://platform.openai.com/docs/bots' },
  indexability: { category: 'crawl', severity: 'high', effort: 1, title: 'Pages marked noindex',
    fix: 'Remove noindex from pages meant to be found; keep it on login, basket and account pages.',
    source: `${G}/crawling-indexing/block-indexing` },
  'ai-meta-tags': { category: 'crawl', severity: 'high', effort: 1, title: 'Pages block AI snippets (nosnippet, noai)',
    fix: 'Drop nosnippet, noai and noimageai from the robots meta tag on pages that should be quoted.',
    source: `${G}/crawling-indexing/robots-meta-tag` },
  title: { category: 'onpage', severity: 'medium', effort: 1, title: 'Missing or too short page titles',
    fix: 'Write a descriptive title of at least 10 characters naming the page topic.',
    source: `${G}/appearance/title-link` },
  'meta-description': { category: 'onpage', severity: 'medium', effort: 1, title: 'Missing or too short meta descriptions',
    fix: 'Write a meta description of 50+ characters that summarises the page.',
    source: `${G}/appearance/snippet` },
  canonical: { category: 'crawl', severity: 'low', effort: 1, title: 'Pages without a canonical URL',
    fix: 'Add a rel=canonical link pointing at the preferred URL.',
    source: `${G}/crawling-indexing/consolidate-duplicate-urls` },
  h1: { category: 'structure', severity: 'low', effort: 1, title: 'Pages without exactly one H1',
    fix: 'Give each page one H1 naming its topic (theme template on most platforms).', source: HEADINGS },
  'heading-hierarchy': { category: 'structure', severity: 'low', effort: 1, title: 'Flat or skipped heading outline',
    fix: 'Use H2/H3 subheadings in order, without skipping levels.', source: HEADINGS },
  schema: { category: 'structured', severity: 'medium', effort: 2, title: 'Pages without JSON-LD structured data',
    fix: 'Add JSON-LD (Product, Organization, BreadcrumbList, Article) matching the page.', source: SD },
  'schema-types': { category: 'structured', severity: 'medium', effort: 2, title: 'JSON-LD without a recognised schema type',
    fix: 'Use a schema.org type AI engines and Google understand (Product, Organization, Article, FAQPage, BreadcrumbList).', source: SD },
  og: { category: 'structured', severity: 'low', effort: 1, title: 'Missing Open Graph title or description',
    fix: 'Add og:title and og:description to every page.', source: 'https://ogp.me/' },
  'internal-links': { category: 'links', severity: 'low', effort: 2, title: 'Pages with fewer than 5 internal links',
    fix: 'Link to related categories, products and guides from the page body.',
    source: `${G}/crawling-indexing/links-crawlable` },
  'image-alt': { category: 'content', severity: 'low', effort: 1, title: 'Images without alt text',
    fix: 'Describe each meaningful image in its alt attribute (product: title, format, what is shown).',
    source: `${G}/appearance/google-images` },
  'text-depth': { category: 'content', severity: 'medium', effort: 3, title: 'Thin pages (under 250 words)',
    fix: 'Add the substance a buyer asks AI about: who it is for, specifics, answers to common questions.',
    source: `${G}/fundamentals/creating-helpful-content`, heuristic: true },
};

// A public standard, not a link to this tool: reports must not name the tools that built them.
const VISIBILITY_SOURCE = 'https://developers.google.com/search/docs/appearance/ai-features';
// Fewer answers than this per report = a rate too noisy to act on without a rerun.
export const MIN_ANSWERS = 20;
// Fewer answers than this on one engine = that engine's rate is flagged in the evidence.
export const MIN_ENGINE_ANSWERS = 10;
// Stored answers older than this are not used: the weekly scan refreshes them.
export const WINDOW_DAYS = 30;
// Bots that fetch pages for AI answers and search. Blocking only the others
// (CCBot, Bytespider, Google-Extended, anthropic-ai: training) is often deliberate.
const ANSWER_BOTS = ['gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'perplexitybot'];

export type Action = {
  action_id: string;
  id: string;
  origin: 'aeo' | 'visibility';
  category: string;
  severity: Severity;
  priority: 'P1' | 'P2' | 'P3';
  impact: number;
  effort: number;
  quick_win: boolean;
  title: string;
  fix: string;
  source: string;
  count: number;
  evidence: string;
  heuristic: boolean;
  to_verify: boolean;
  urls: string[];
  prompts?: string[];
  status: 'to_do';
};

type Draft = Omit<Action, 'action_id' | 'priority' | 'impact' | 'quick_win' | 'status'> & { reach: number };

export type EngineVisibility = { engine: string; runs: number; mentioned: number; answers: number; expected: number; rate: number };
export type Visibility = {
  rate: number | null;
  mentioned: number;
  answers: number;
  runs: number;
  window: { from: string; to: string } | null;
  market: string;
  google_domain: string;
  branded_prompts_excluded: number;
  per_engine: EngineVisibility[];
};

type Audit = Awaited<ReturnType<typeof auditSite>>;

function aeoDrafts(audit: Audit): Draft[] {
  const out: Draft[] = [];
  for (const c of audit.checks as SiteCheck[]) {
    const rule = CHECK_RULES[c.id];
    if (!rule || c.failingUrls.length === 0) continue;
    const robotsUnknown = c.id === 'ai-bot-access' && !!audit.robots.error;
    const trainingOnly = c.id === 'ai-bot-access' && !robotsUnknown
      && !audit.robots.aiBotBlocked.some((b) => ANSWER_BOTS.includes(b));
    const perPage = !['ai-bot-access', 'rss-feed'].includes(c.id);
    out.push({
      id: c.id, origin: 'aeo', category: rule.category,
      // A check that passes site-wide (80%+) still lists its failing pages, one level lower.
      severity: robotsUnknown ? 'high' : trainingOnly ? 'low' : c.passed ? lower(rule.severity) : rule.severity,
      effort: rule.effort, source: rule.source,
      title: trainingOnly ? 'Only AI training crawlers blocked in robots.txt' : rule.title,
      fix: trainingOnly ? 'Answer and search bots are allowed. Keep the training-bot blocks if they are deliberate.' : rule.fix,
      count: c.failingUrls.length,
      evidence: perPage ? `${c.details} ${c.label} failed on ${c.failingUrls.length} of ${audit.crawledPages} crawled pages.` : c.details,
      heuristic: !!rule.heuristic,
      // noindex is often intended (login, basket): a person confirms which pages should be indexed.
      to_verify: !!rule.heuristic || robotsUnknown || trainingOnly || c.id === 'indexability',
      urls: c.failingUrls,
      reach: perPage ? c.failingUrls.length / Math.max(1, audit.crawledPages) : 1,
    });
  }
  return out;
}

const lower = (s: Severity): Severity => (s === 'critical' ? 'high' : s === 'high' ? 'medium' : 'low');

function visibilityDrafts({ visibility: v, losing, absent, promptCount }: VisibilitySummary, sources: Source[] = []): Draft[] {
  if (v.rate === null) return [];
  const out: Draft[] = [];
  const to_verify = v.answers < MIN_ANSWERS || v.per_engine.some((e) => e.answers < MIN_ENGINE_ANSWERS);
  const thin = v.per_engine.filter((e) => e.answers < MIN_ENGINE_ANSWERS || e.answers < e.expected);
  const engines = v.per_engine.map((e) => `${e.engine} ${e.mentioned}/${e.answers}`).join(', ')
    + (thin.length ? `; to verify: ${thin.map((e) => `${e.engine} answered ${e.answers} of ${e.expected} questions`).join(', ')}` : '');
  // Newest answer per engine and question: one answer per question from each assistant, not repeated samples.
  const sample = `${v.answers} answers to ${promptCount} questions that do not name the brand, one per question from each assistant, ${v.window?.from.slice(0, 10)} to ${v.window?.to.slice(0, 10)}, market ${v.market}`;
  // Third-party pages the assistants cite (catalogues, shops, blogs): where a brand gets recommended.
  const cited = sources.filter((s) => s.kind === 'other').slice(0, 5).map((s) => s.host);
  if (v.rate < 0.3 && absent.length > 0) {
    out.push({
      id: 'ai_visibility_low', origin: 'visibility', category: 'visibility',
      severity: v.rate < 0.1 ? 'high' : 'medium', effort: 3,
      title: 'Brand missing from AI answers to buyer questions',
      fix: (cited.length
        ? `Get the brand and its products listed, reviewed and mentioned on the sites AI assistants cite for these questions, above all ${cited.join(', ')}. `
        : '')
        + 'Publish pages that answer these questions directly (category texts, buyer Q&A, specs), then rescan the same questions.',
      source: VISIBILITY_SOURCE, count: absent.length,
      evidence: `Mentioned in ${v.mentioned} of ${v.answers} answers (${Math.round(v.rate * 100)} %; ${engines}); ${absent.length} questions with no mention from any assistant. Sample: ${sample}.`,
      heuristic: false, to_verify, urls: [], prompts: absent, reach: absent.length / promptCount,
    });
  }
  if (losing.length > 0) {
    const counts = new Map<string, number>();
    for (const l of losing) for (const c of l.competitors) counts.set(c, (counts.get(c) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([c, n]) => `${c} (${n})`);
    out.push({
      id: 'competitors_preferred', origin: 'visibility', category: 'visibility', severity: 'medium', effort: 3,
      title: 'AI assistants name competitors instead of the brand',
      fix: 'For each question, compare what the assistants say about the named competitor with your matching category or product page, and close the gap in what the page states (audience, topic, format, proof).',
      source: VISIBILITY_SOURCE, count: losing.length,
      evidence: `${losing.length} questions where an answer names a competitor but not the brand. Most named: ${top.join(', ')}. Sample: ${sample}.`,
      heuristic: false, to_verify, urls: [], prompts: losing.map((l) => l.prompt), reach: losing.length / promptCount,
    });
  }
  return out;
}

/** jev-seo rules: impact normalised to the top action = 100; P1 critical or high with impact 40+. */
export function rankActions(drafts: Draft[]): Action[] {
  const raw = drafts.map((d) => SEVERITY_WEIGHT[d.severity] * (0.6 + 0.4 * d.reach));
  const top = Math.max(0, ...raw) || 1;
  const ranked = drafts.map(({ reach: _reach, ...d }, i) => {
    const impact = Math.round((100 * raw[i]) / top);
    const priority: Action['priority'] = d.severity === 'critical' || (d.severity === 'high' && impact >= 40) ? 'P1'
      : impact >= 30 || d.severity === 'high' ? 'P2' : 'P3';
    return { ...d, priority, impact, quick_win: impact >= 35 && d.effort <= 1 };
  });
  ranked.sort((a, b) => a.priority.localeCompare(b.priority) || b.impact - a.impact || a.effort - b.effort || a.id.localeCompare(b.id));
  return ranked.map((a, i) => ({ action_id: `GEO-${String(i + 1).padStart(3, '0')}`, ...a, status: 'to_do' as const }));
}

/**
 * Unbranded AI visibility from stored answers in the brand's current market:
 * the newest answer per engine and active prompt within WINDOW_DAYS, so a
 * partial rerun only replaces the prompts it re-asked. Prompts naming the brand
 * are left out (they measure recall, not discovery); runs started before an
 * identity change are skipped.
 */
export function summariseVisibility(brand: Brand, rows: ComparisonEvidenceRow[], activePromptIds: Set<string>) {
  const market = brandMarket(brand);
  // Aliases count: 'Studio Koloru czy Dwie Siostry' names the brand without its full name.
  const names = (text: string) => findTermSetMatchIndex(text, {
    domain: brand.domain, name: brand.name, aliases: brand.aliases, excludeTerms: brand.exclude_terms,
  }) !== -1;
  const branded = new Set<string>();
  const unbranded = new Set<string>();
  const latest = new Map<string, ComparisonEvidenceRow>(); // engine+prompt -> newest ok row
  const latestBranded = new Map<string, ComparisonEvidenceRow>(); // same, for questions that name the brand
  for (const r of rows) {
    if (r.status !== 'ok' || !activePromptIds.has(r.prompt_id)) continue;
    if (brand.identity_changed_at && (r.run_started_at ?? r.captured_at) < brand.identity_changed_at) continue;
    const isBranded = names(r.prompt_text);
    (isBranded ? branded : unbranded).add(r.prompt_id);
    const into = isBranded ? latestBranded : latest;
    const key = `${r.engine}\u0000${r.prompt_id}`;
    const prev = into.get(key);
    if (!prev || r.captured_at > prev.captured_at) into.set(key, r);
  }
  const used = [...latest.values()];
  const brandedUsed = [...latestBranded.values()];
  const per_engine: EngineVisibility[] = [...new Set(used.map((r) => r.engine))].sort().map((engine) => {
    const e = used.filter((r) => r.engine === engine);
    const mentioned = e.filter((r) => r.brand_mentioned === 1).length;
    return { engine, runs: new Set(e.map((r) => r.run_id)).size, mentioned, answers: e.length, expected: unbranded.size,
      rate: Math.round((1000 * mentioned) / e.length) / 1000 };
  });
  const mentioned = used.filter((r) => r.brand_mentioned === 1).length;
  const times = used.map((r) => r.captured_at).sort((a, b) => a - b);
  const visibility: Visibility = {
    rate: used.length ? Math.round((1000 * mentioned) / used.length) / 1000 : null,
    mentioned, answers: used.length, runs: new Set(used.map((r) => r.run_id)).size,
    window: times.length ? { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString() } : null,
    market: market.market, google_domain: market.google_domain,
    branded_prompts_excluded: branded.size, per_engine,
  };
  const byPrompt = new Map<string, { prompt: string; hit: boolean; competitors: Set<string> }>();
  for (const r of used) {
    const p = byPrompt.get(r.prompt_id) ?? { prompt: r.prompt_text, hit: false, competitors: new Set<string>() };
    if (r.brand_mentioned === 1) p.hit = true;
    else for (const c of r.competitors_mentioned) p.competitors.add(c);
    byPrompt.set(r.prompt_id, p);
  }
  const prompts = [...byPrompt.values()].sort((a, b) => a.prompt.localeCompare(b.prompt));
  const absent = prompts.filter((p) => !p.hit).map((p) => p.prompt);
  const losing = prompts.filter((p) => p.competitors.size > 0).map((p) => ({ prompt: p.prompt, competitors: [...p.competitors].sort() }));
  return { visibility, absent, losing, promptCount: prompts.length, used, brandedUsed };
}
export type VisibilitySummary = ReturnType<typeof summariseVisibility>;

export function buildGeoReport(brand: Brand, audit: Audit, vis: VisibilitySummary & Partial<Awaited<ReturnType<typeof collectVisibility>>>, version: string) {
  const { visibility } = vis;
  const sources = vis.sources ?? sourcesOf(brand, vis.used);
  const actions = rankActions([...aeoDrafts(audit), ...visibilityDrafts(vis, sources)]);
  return {
    schema_version: '1.0',
    tool: { name: 'mlw-geo', version },
    run: { generated_at: audit.generatedAt, options: { brand_id: brand.id, max_pages: audit.maxPages }, crawl_ms: audit.diagnostics.crawlMs },
    site: { domain: brand.domain, brand_name: brand.name, brand_aliases: brand.aliases, url: audit.url, market: visibility.market, google_domain: visibility.google_domain,
      crawled_pages: audit.crawledPages, page_types: audit.pageTypes, robots: audit.robots, llms_txt: audit.llmsTxt },
    scores: {
      categories: { aeo: audit.foundationalScore, ai_visibility: visibility.rate === null ? null : Math.round(visibility.rate * 100) },
      category_names: { aeo: 'AI search foundations (site audit)', ai_visibility: 'AI visibility on buyer prompts' },
      notes: {
        aeo: `16 deterministic checks on ${audit.crawledPages} crawled pages; a site-wide check passes when 80%+ of pages pass it; llms.txt weighs 0. Ranks work, not a traffic prediction. Content quality (6 dimensions) is scored by the calling model from pages_for_review, not here.`,
        ai_visibility: visibility.rate === null
          ? `Not assessed: no completed scan in market ${visibility.market}. Run refresh_brand, then rebuild the report.`
          : `Share of unbranded answers that mention the brand: ${visibility.mentioned}/${visibility.answers}, newest answer per engine and active prompt in the last ${WINDOW_DAYS} days (n = ${visibility.runs} runs), ${visibility.window!.from.slice(0, 10)} to ${visibility.window!.to.slice(0, 10)}, market ${visibility.market} (${visibility.google_domain}). ${visibility.branded_prompts_excluded} prompts naming the brand left out. A sample, not a ranking or traffic prediction.${visibility.answers < MIN_ANSWERS ? ` Under ${MIN_ANSWERS} answers: to verify with a rerun.` : ''}${visibility.per_engine.some((e) => e.answers < MIN_ENGINE_ANSWERS) ? ` An engine has under ${MIN_ENGINE_ANSWERS} answers: its rate is to verify.` : ''}`,
      },
      // Not combined into one overall: a site audit and sampled AI answers do not share a scale.
      overall: null,
    },
    visibility,
    actions,
    // For the client reports: Google top 10 per question, competitors ranked, one worked example.
    google: vis.google ?? null,
    competitors: vis.competitors ?? null,
    example: vis.example ?? null,
    // Pages the assistants cite in answers to the same questions, and what they say when asked about the brand by name.
    sources,
    brand_answers: vis.brand_answers ?? null,
    pages_for_review: audit.pagesForReview,
  };
}

export async function collectVisibility(db: Db, brand: Brand, now = Date.now()) {
  const [rows, active] = await Promise.all([
    db.getResponsesSince(brand.id, now - WINDOW_DAYS * 86_400_000),
    db.getActivePrompts(brand.id),
  ]);
  const vis = summariseVisibility(brand, rows, new Set(active.map((p) => p.id)));
  const google = googleVisibility(brand, vis.used);
  const pick = pickExample(vis.used, google);
  const ids = [...(pick ? [pick.withCompetitor.id, pick.withoutCompetitor.id] : []), ...vis.brandedUsed.map((r) => r.id)];
  const [raw, cited] = await Promise.all([
    ids.length ? db.getRawResponses(ids) : Promise.resolve({} as Record<string, string>),
    db.getCitedUrls([...vis.used, ...vis.brandedUsed].map((r) => r.id)),
  ]);
  for (const r of [...vis.used, ...vis.brandedUsed]) r.cited_urls = cited[r.id] ?? [];
  return {
    ...vis, google, competitors: rankCompetitors(brand, vis.used, google), example: pick ? exampleOf(pick, raw) : null,
    sources: sourcesOf(brand, vis.used), brand_answers: brandAnswersOf(brand, vis.brandedUsed, raw),
  };
}

// ─── Google visibility, competitors, worked example (SEO + GEO client reports) ──

const sameSite = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const hostOf = (u: string): string | null => {
  try {
    return new URL(u.includes('://') ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
};

export type Source = { host: string; answers: number; engines: Record<string, number>; kind: 'shop' | 'competitor' | 'other' };

/**
 * Domains the assistants cite in their answers to the unbranded questions,
 * counted once per answer. A competitor is a tracked rival brand; everything
 * else (catalogues, shops, blogs, video) is a source the brand can work with.
 */
export function sourcesOf(brand: Brand, used: ComparisonEvidenceRow[], limit = 15): Source[] {
  const by = new Map<string, Source>();
  for (const r of used) {
    for (const host of new Set((r.cited_urls ?? []).map(hostOf).filter((h): h is string => !!h))) {
      const kind: Source['kind'] = sameSite(host, brand.domain) ? 'shop' : brand.competitors.some((c) => sameSite(host, c)) ? 'competitor' : 'other';
      const s = by.get(host) ?? { host, answers: 0, engines: {}, kind };
      s.answers += 1;
      s.engines[r.engine] = (s.engines[r.engine] ?? 0) + 1;
      by.set(host, s);
    }
  }
  return [...by.values()].sort((a, b) => b.answers - a.answers || a.host.localeCompare(b.host)).slice(0, limit);
}

/** What each assistant answered to the questions that name the brand: reputation and facts, not discovery. */
export function brandAnswersOf(brand: Brand, rows: ComparisonEvidenceRow[], raw: Record<string, string>) {
  const byPrompt = new Map<string, { prompt: string; answers: { engine: string; captured_at: string; named: boolean; sources: string[]; excerpt: string }[] }>();
  for (const r of [...rows].sort((a, b) => a.prompt_text.localeCompare(b.prompt_text) || a.engine.localeCompare(b.engine))) {
    const p = byPrompt.get(r.prompt_id) ?? { prompt: r.prompt_text, answers: [] };
    p.answers.push({
      engine: r.engine, captured_at: new Date(r.captured_at).toISOString(), named: r.brand_mentioned === 1,
      sources: [...new Set((r.cited_urls ?? []).map(hostOf).filter((h): h is string => !!h))].slice(0, 5),
      excerpt: excerpt(raw[r.id] ?? '', [brand.name, ...brand.aliases]),
    });
    byPrompt.set(r.prompt_id, p);
  }
  return [...byPrompt.values()];
}

/**
 * Organic top 10 per buyer question, from the google.pl response the AI
 * Overviews engine already fetched (newest row per question). The SEO report
 * turns it into its Google visibility area; mlw-geo makes no actions from it.
 */
export function googleVisibility(brand: Brand, used: ComparisonEvidenceRow[]) {
  const rows = used.filter((r) => r.engine === 'ai_overviews' && r.organic_results);
  const prompts = rows.map((r) => {
    const organic = r.organic_results ?? [];
    const shop = organic.find((o) => sameSite(o.host, brand.domain));
    return {
      prompt_id: r.prompt_id, prompt: r.prompt_text, captured_at: new Date(r.captured_at).toISOString(),
      shop_position: shop?.position ?? null,
      competitors: brand.competitors.flatMap((c) => {
        const hit = organic.find((o) => sameSite(o.host, c));
        return hit ? [{ domain: c, position: hit.position }] : [];
      }),
      top: organic.slice(0, 10),
    };
  }).sort((a, b) => a.prompt.localeCompare(b.prompt));
  const competitorTop10 = Object.fromEntries(brand.competitors.map((c) => [c, prompts.filter((p) => p.competitors.some((x) => x.domain === c)).length]));
  return {
    questions: prompts.length,
    shop_top10: prompts.filter((p) => p.shop_position !== null).length,
    competitor_top10: competitorTop10,
    google_domain: brandMarket(brand).google_domain,
    prompts,
  };
}

/** Competitors ranked by AI mentions, then Google top 10 presence; the reports use the top 3. */
export function rankCompetitors(brand: Brand, used: ComparisonEvidenceRow[], google: ReturnType<typeof googleVisibility>) {
  return brand.competitors
    .map((domain) => ({ domain, ai_mentions: used.filter((r) => r.competitors_mentioned.includes(domain)).length, google_top10: google.competitor_top10[domain] ?? 0 }))
    .sort((a, b) => b.ai_mentions - a.ai_mentions || b.google_top10 - a.google_top10 || a.domain.localeCompare(b.domain));
}

/**
 * One question for both reports: a competitor is in Google's top 10, one AI
 * assistant names a competitor and another names nobody (neither brand nor
 * competitor). Most competitors named wins; ties by question text, so a
 * re-audit picks the same question while it still fits.
 */
export function pickExample(used: ComparisonEvidenceRow[], google: ReturnType<typeof googleVisibility>) {
  let best: { prompt: string; google: (typeof google.prompts)[number]; withCompetitor: ComparisonEvidenceRow; withoutCompetitor: ComparisonEvidenceRow } | null = null;
  for (const g of google.prompts) {
    if (g.competitors.length === 0) continue;
    const answers = used.filter((r) => r.prompt_id === g.prompt_id && r.engine !== 'ai_overviews');
    const withC = answers.filter((r) => r.competitors_mentioned.length > 0).sort((a, b) => b.competitors_mentioned.length - a.competitors_mentioned.length || a.engine.localeCompare(b.engine))[0];
    const without = answers.filter((r) => r.competitors_mentioned.length === 0 && r.brand_mentioned === 0 && r.engine !== withC?.engine).sort((a, b) => a.engine.localeCompare(b.engine))[0];
    if (!withC || !without) continue;
    if (!best || withC.competitors_mentioned.length > best.withCompetitor.competitors_mentioned.length
      || (withC.competitors_mentioned.length === best.withCompetitor.competitors_mentioned.length && g.prompt.localeCompare(best.prompt) < 0)) {
      best = { prompt: g.prompt, google: g, withCompetitor: withC, withoutCompetitor: without };
    }
  }
  return best;
}

export const EXCERPT_CHARS = 600;

/**
 * Excerpt around the first matching term (a domain counts by its root, e.g. "zakamarki"),
 * or the answer start. It opens on a sentence or line start and ends on a word boundary;
 * line breaks are kept so list items stay readable.
 */
export function excerpt(text: string, terms: string[] = []): string {
  const clean = text.replace(/[^\S\n]+/g, ' ').replace(/ *\n\s*/g, '\n').trim();
  const roots = terms.map((c) => (c.includes('.') && !c.includes(' ') ? c.split('.')[0] : c)).filter((r) => r.length >= 3);
  const lower = clean.toLowerCase();
  const hits = roots.map((r) => ({ at: lower.indexOf(r.toLowerCase()), len: r.length })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  const hit = hits[0];
  let start = 0;
  if (hit && hit.at >= EXCERPT_CHARS / 3) {
    const base = Math.max(0, hit.at - EXCERPT_CHARS / 2);
    const before = clean.slice(base, hit.at);
    // Last line break or sentence end before the match ("np. " and similar abbreviations do not count).
    const ends = [...before.matchAll(/\n|(?<!\b(?:np|tj|m\.in|ok|tzw|ul|godz|nr|r|e\.g|i\.e|etc))[.!?] /g)];
    const last = ends[ends.length - 1];
    start = last ? base + last.index! + last[0].length : clean.lastIndexOf(' ', hit.at - EXCERPT_CHARS / 3) + 1;
  }
  let end = Math.min(clean.length, start + EXCERPT_CHARS);
  if (end < clean.length) {
    // End on whitespace, never before the matched term.
    const cut = Math.max(clean.lastIndexOf(' ', end), clean.lastIndexOf('\n', end));
    end = Math.max(cut, hit ? hit.at + hit.len : start + 1, start + 1);
  }
  return `${start > 0 ? '… ' : ''}${clean.slice(start, end).trim()}${end < clean.length ? ' …' : ''}`;
}

function exampleOf(pick: NonNullable<ReturnType<typeof pickExample>>, raw: Record<string, string>) {
  const answer = (r: ComparisonEvidenceRow) => ({
    engine: r.engine, captured_at: new Date(r.captured_at).toISOString(), competitors: r.competitors_mentioned,
    excerpt: excerpt(raw[r.id] ?? '', r.competitors_mentioned),
  });
  return { prompt: pick.prompt, google: pick.google, with_competitor: answer(pick.withCompetitor), without_competitor: answer(pick.withoutCompetitor) };
}

export function registerGeoReportTool(server: McpServer, db: Db, f: typeof fetch, version: string): void {
  server.registerTool(
    'geo.report',
    {
      title: 'GEO report (jev-seo model)',
      description:
        "Build the GEO report for a tracked brand in the jev-seo report model: runs the AEO site audit and reads stored AI answers from the last 30 days (no new engine calls). Returns scores with their method, AI visibility as a rate with n answers, runs, window and market, and GEO-### actions (priority, impact, effort, evidence, fix, source, to_verify). Example: brand_id='studiokoloru'.",
      inputSchema: {
        brand_id: z.string().describe('Tracked brand ID.'),
        max_pages: z.number().int().min(1).max(MAX_CRAWL_LIMIT).optional().describe('Pages to crawl, default 30.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ brand_id, max_pages }) => {
      const brand = await db.getBrand(brand_id);
      if (!brand) throw new Error(`Unknown brand_id '${brand_id}'. Call list_brands for tracked IDs.`);
      const [audit, vis] = await Promise.all([auditSite(f, brand.domain, max_pages ?? MAX_CRAWL_LIMIT), collectVisibility(db, brand)]);
      const payload = buildGeoReport(brand, audit, vis, version);
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );
}
