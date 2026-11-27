import assert from 'node:assert/strict';
import test from 'node:test';
import type { Brand, ComparisonEvidenceRow } from '../../src/db/types.ts';
import { buildGeoReport, CHECK_RULES, rankActions, summariseVisibility } from '../../src/core/geo-report.ts';
import { auditSite } from '../../src/core/site-audit.ts';

const brand: Brand = {
  id: 'shop', user_id: 'u', domain: 'shop.pl', name: 'Kolorowy Sklep', category: 'książki dla dzieci',
  competitors: ['rival.pl'], aliases: [], exclude_terms: [], refresh_frequency: 'weekly',
  market: 'pl-PL', google_domain: 'google.pl', created_at: 0, updated_at: 0,
};

let seq = 0;
const row = (engine: string, prompt_id: string, prompt_text: string, mentioned: number, competitors: string[] = [], captured_at = 1_700_000_000_000, run_id = `run-${engine}`): ComparisonEvidenceRow => ({
  id: `r${seq++}`, run_id, prompt_id, prompt_text, engine, brand_mentioned: mentioned,
  competitors_mentioned: competitors, status: 'ok', captured_at, run_started_at: captured_at, mode: 'live',
});
const all = (rows: ComparisonEvidenceRow[]) => new Set(rows.map((r) => r.prompt_id));

async function audit(robots = 'User-agent: GPTBot\nDisallow: /\n\nSitemap: https://shop.pl/sm') {
  const page = (title: string, extra = '') => `<html><head><title>${title}</title>${extra}</head><body><h1>${title}</h1></body></html>`;
  const site: Record<string, string> = {
    'https://shop.pl/robots.txt': robots,
    'https://shop.pl/sm': '<urlset><url><loc>https://shop.pl/pl/p/a/1</loc></url></urlset>',
    'https://shop.pl/': page('Strona główna sklepu'),
    'https://shop.pl/pl/p/a/1': page('Książka pierwsza', '<meta name="description" content="Opis książki dla dzieci, który ma ponad pięćdziesiąt znaków.">'),
  };
  return auditSite((async (u: string) => (site[u] ? new Response(site[u]) : new Response('', { status: 404 }))) as typeof fetch, 'shop.pl', 5);
}

test('every scored AEO check has a rule; llms.txt has none (0 points)', async () => {
  const r = await audit();
  for (const c of r.checks) assert.equal(c.id in CHECK_RULES, c.points > 0, c.id);
});

test('site checks list failing pages', async () => {
  const r = await audit();
  const meta = r.checks.find((c) => c.id === 'meta-description')!;
  assert.deepEqual(meta.failingUrls, ['https://shop.pl/']);
  assert.deepEqual(r.checks.find((c) => c.id === 'ai-bot-access')!.failingUrls, ['https://shop.pl/robots.txt']);
  assert.deepEqual(r.checks.find((c) => c.id === 'title')!.failingUrls, []);
});

test('ai-bot-access: answer bot blocked is critical P1, training bots only is low and to verify', async () => {
  const empty = summariseVisibility(brand, [], new Set());
  const answer = buildGeoReport(brand, await audit(), empty, '0').actions.find((a) => a.id === 'ai-bot-access')!;
  assert.deepEqual([answer.severity, answer.priority, answer.to_verify], ['critical', 'P1', false]);
  const training = buildGeoReport(brand, await audit('User-agent: CCBot\nUser-agent: Bytespider\nDisallow: /\n'), empty, '0')
    .actions.find((a) => a.id === 'ai-bot-access')!;
  assert.deepEqual([training.severity, training.to_verify], ['low', true]);
  assert.notEqual(training.priority, 'P1');
  assert.match(training.title, /training/);
});

test('visibility: unbranded rate per engine, branded prompts left out, newest answer per prompt wins', () => {
  const rows = [
    row('chatgpt', 'p1', 'najlepsze książki o emocjach', 0, ['rival.pl'], 1),
    row('chatgpt', 'p1', 'najlepsze książki o emocjach', 1, [], 2),
    row('chatgpt', 'p2', 'książki dla 5-latka', 0, ['rival.pl']),
    row('chatgpt', 'p3', 'czy Kolorowy Sklep jest dobry', 1),
    row('chatgpt', 'p4', 'Kolorowy czy Rival – co wybrać?', 1),
    row('claude', 'p2', 'książki dla 5-latka', 0),
  ];
  const v = summariseVisibility({ ...brand, aliases: ['Kolorowy'] }, rows, all(rows));
  assert.equal(v.visibility.branded_prompts_excluded, 2, 'full name and alias');
  assert.deepEqual(v.visibility.per_engine.map((e) => [e.engine, e.mentioned, e.answers, e.expected]), [['chatgpt', 1, 2, 2], ['claude', 0, 1, 2]]);
  assert.equal(v.visibility.rate, 0.333);
  assert.equal(v.visibility.runs, 2);
  assert.deepEqual(v.absent, ['książki dla 5-latka']);
  assert.deepEqual(v.losing, [{ prompt: 'książki dla 5-latka', competitors: ['rival.pl'] }]);
});

test('visibility: a partial rerun replaces only the prompts it re-asked; retired prompts are dropped', () => {
  const rows = [
    row('gemini', 'p1', 'a', 0, [], 1, 'full'),
    row('gemini', 'p2', 'b', 0, [], 1, 'full'),
    row('gemini', 'p3', 'retired', 1, [], 1, 'full'),
    row('gemini', 'p1', 'a', 1, [], 5, 'retry'),
  ];
  const v = summariseVisibility(brand, rows, new Set(['p1', 'p2']));
  assert.deepEqual(v.visibility.per_engine.map((e) => [e.answers, e.mentioned, e.runs]), [[2, 1, 2]]);
});

test('visibility: exclude_terms keep a homograph brand name from marking prompts as branded', () => {
  const monday = { ...brand, domain: 'monday.com', name: 'Monday', exclude_terms: ['monday'] };
  const rows = [row('claude', 'p1', 'best planner to start Monday morning', 0)];
  assert.equal(summariseVisibility(monday, rows, all(rows)).visibility.branded_prompts_excluded, 0);
});

test('visibility: runs started before an identity change are skipped', () => {
  const rows = [row('claude', 'p1', 'x', 1, [], 5)];
  const v = summariseVisibility({ ...brand, identity_changed_at: 10 }, rows, all(rows));
  assert.equal(v.visibility.rate, null);
  assert.equal(v.visibility.window, null);
});

test('report: jev-seo shape, GEO-### ranked by jev-seo rules, no overall score', async () => {
  const rows = [row('chatgpt', 'p1', 'książki o emocjach', 0, ['rival.pl']), row('chatgpt', 'p2', 'książki dla 5-latka', 0)];
  const r = buildGeoReport(brand, await audit(), summariseVisibility(brand, rows, all(rows)), '0.0.0');
  assert.equal(r.schema_version, '1.0');
  assert.equal(r.tool.name, 'mlw-geo');
  assert.equal(r.scores.overall, null);
  assert.equal(r.scores.categories.ai_visibility, 0);
  assert.match(r.scores.notes.ai_visibility, /0\/2, .*n = 1 runs.*market pl-PL.*under 10 answers/);
  const [first] = r.actions;
  assert.deepEqual([first.action_id, first.id, first.priority, first.impact], ['GEO-001', 'ai-bot-access', 'P1', 100]);
  assert.deepEqual(r.actions.map((a) => a.action_id), r.actions.map((_, i) => `GEO-${String(i + 1).padStart(3, '0')}`));
  const low = r.actions.find((a) => a.id === 'ai_visibility_low')!;
  assert.equal(low.to_verify, true, 'under 20 answers');
  assert.match(low.evidence, /to verify: chatgpt answered 2 of 2 prompts/);
  assert.deepEqual(low.prompts, ['książki dla 5-latka', 'książki o emocjach']);
  assert.equal(r.actions.find((a) => a.id === 'competitors_preferred')!.count, 1);
  assert.ok(!r.actions.some((a) => a.id === 'llms-txt'));
  for (const a of r.actions) assert.equal(a.status, 'to_do');
});

test('report: no scan in market means no visibility actions and a null score with the reason', async () => {
  const r = buildGeoReport(brand, await audit(), summariseVisibility(brand, [], new Set()), '0.0.0');
  assert.equal(r.scores.categories.ai_visibility, null);
  assert.match(r.scores.notes.ai_visibility, /Not assessed/);
  assert.ok(r.actions.every((a) => a.origin === 'aeo'));
});

test('rankActions: top action is always 100, also when all are low', () => {
  const base = { origin: 'aeo' as const, category: 'x', effort: 1, title: 't', fix: 'f', source: 's', count: 1, evidence: 'e', heuristic: false, to_verify: false, urls: [] };
  const [a, b] = rankActions([{ ...base, id: 'a', severity: 'high', reach: 1 }, { ...base, id: 'b', severity: 'low', reach: 0 }]);
  assert.deepEqual([a.priority, a.impact, a.quick_win], ['P1', 100, true]);
  assert.deepEqual([b.priority, b.impact], ['P3', 10]);
  const lows = rankActions([{ ...base, id: 'a', severity: 'low', reach: 0.5 }, { ...base, id: 'b', severity: 'low', reach: 0 }]);
  assert.deepEqual(lows.map((x) => x.impact), [100, 75]);
});

test('google visibility, competitor ranking and the worked example', async () => {
  const { googleVisibility, pickExample, rankCompetitors, excerpt } = await import('../../src/core/geo-report.ts');
  const b = { ...brand, competitors: ['rival.pl', 'other.pl'] };
  const org = (...hosts: string[]) => hosts.map((host, i) => ({ position: i + 1, host, url: `https://${host}/`, title: host }));
  const rows = [
    { ...row('ai_overviews', 'p1', 'książki o emocjach', 0), organic_results: org('rival.pl', 'x.pl', 'shop.pl') },
    { ...row('ai_overviews', 'p2', 'książki dla 5-latka', 0), organic_results: org('y.pl') },
    row('chatgpt', 'p1', 'książki o emocjach', 0, ['rival.pl', 'other.pl']),
    row('claude', 'p1', 'książki o emocjach', 0, []),
    row('gemini', 'p2', 'książki dla 5-latka', 0, ['rival.pl']),
  ];
  const g = googleVisibility(b, rows);
  assert.deepEqual([g.questions, g.shop_top10, g.competitor_top10], [2, 1, { 'rival.pl': 1, 'other.pl': 0 }]);
  assert.deepEqual(g.prompts.find((p) => p.prompt_id === 'p1')!.competitors, [{ domain: 'rival.pl', position: 1 }]);
  assert.deepEqual(rankCompetitors(b, rows, g).map((c) => [c.domain, c.ai_mentions]), [['rival.pl', 2], ['other.pl', 1]]);
  const pick = pickExample(rows, g)!;
  assert.deepEqual([pick.prompt, pick.withCompetitor.engine, pick.withoutCompetitor.engine], ['książki o emocjach', 'chatgpt', 'claude']);
  const long = `${'wstęp '.repeat(200)}Polecam Rival i jego serię. ${'koniec '.repeat(200)}`;
  const e = excerpt(long, ['rival.pl']);
  assert.ok(e.startsWith('… ') && e.endsWith(' …') && e.includes('Polecam Rival'));
  assert.equal(excerpt('Krótka odpowiedź.'), 'Krótka odpowiedź.');
});
