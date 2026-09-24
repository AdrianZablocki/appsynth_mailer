import { readBenchmarkFiles } from './store';
import type { ClientRecord } from './effective';

type Branch = 'rorleggere' | 'elektrikere';

interface Check { id: string; name: string; max_points: number; points: number; passed: boolean; evidence?: string }
interface Record_ {
  domain: string; url?: string; score: number | null; label?: string; error?: string;
  categories?: { key: string; checks: Check[] }[];
  firma?: { navn?: string; orgnr?: string; kommune?: string; ansatte?: string; nace?: string };
}

export interface BenchRow {
  branch: Branch; domain: string; host: string; navn: string; kommune: string; score: number | null; label: string; unreachable: boolean;
}

/* Od 2026-09-24 maile tylko po angielsku: TRADE = branża w l.mn., SERVICE = usługa, o którą pytaliśmy AI. */
const BRANCH_WORDS: Record<Branch, { TRADE: string; SERVICE: string }> = {
  rorleggere: { TRADE: 'plumbers', SERVICE: 'plumbing work' },
  elektrikere: { TRADE: 'electricians', SERVICE: 'electrical work' },
};

/* Krótkie sformułowania znalezisk do zdania "[company.no] is missing …" w cold mailu.
   Klucz = id checku z METODOLOGIA v0.4. Brak w mapie → nazwa PL z benchmarku (do ręcznej poprawki). */
const FINDINGS: Record<string, string> = {
  A2: 'access for GPTBot (blocked in robots.txt)',
  A8: 'access for AI crawlers — the firewall blocks them',
  A9: 'crawler access (global Disallow in robots.txt)',
  B1: 'readable content in the HTML (everything loads via JavaScript)',
  B2: 'content without JavaScript (empty SPA shell)',
  B3: 'language tag (<html lang>)',
  C1: 'structured data (JSON-LD)',
  C2: 'Organization/LocalBusiness data',
  C3: 'FAQ data (FAQPage)',
  C4: 'breadcrumb data (BreadcrumbList)',
  D1: 'a single clear H1',
  D2: 'a clean heading hierarchy',
  D3: 'an FAQ or questions in headings',
  D4: 'title and meta description',
  D5: 'descriptive headings',
  E1: 'phone and e-mail in the HTML',
  E2: 'a physical address on the site',
  E3: 'org. number in the HTML',
  E4: 'a consistent company name',
  F1: 'sitemap.xml',
  F2: 'a canonical tag on the home page',
  F3: 'HTTPS with redirect from HTTP',
  F4: 'a fast home-page response',
  F7: 'the bare domain (only www works)',
};

let cache: { rows: BenchRow[]; records: Map<string, Record_ & { branch: Branch }>; medians: Record<Branch, number>; counts: Record<Branch, number> } | null = null;

function load() {
  if (cache) return cache;
  const rows: BenchRow[] = [];
  const records = new Map<string, Record_ & { branch: Branch }>();
  const medians = { rorleggere: 0, elektrikere: 0 } as Record<Branch, number>;
  const counts = { rorleggere: 0, elektrikere: 0 } as Record<Branch, number>; // firmy z wynikiem (bez nieosiągalnych)
  for (const { branch, lines } of readBenchmarkFiles()) {
    const scores: number[] = [];
    for (const l of lines) {
      let r: Record_;
      try { r = JSON.parse(l); } catch { continue; }
      const host = hostOf(r.domain);
      if (typeof r.score === 'number') scores.push(r.score);
      records.set(host, { ...r, branch });
      rows.push({
        branch, domain: r.domain, host,
        navn: r.firma?.navn ?? '', kommune: r.firma?.kommune ?? '',
        score: r.score, label: r.label ?? (r.error ? 'nieosiągalna' : ''), unreachable: r.score == null,
      });
    }
    scores.sort((a, b) => a - b);
    medians[branch] = scores.length ? median(scores) : 0;
    counts[branch] = scores.length;
  }
  rows.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));
  cache = { rows, records, medians, counts };
  return cache;
}

const median = (s: number[]) => (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);

export function hostOf(d: string) {
  return d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
}

export function searchBenchmark(q: string, limit = 40): BenchRow[] {
  const { rows } = load();
  const needle = q.trim().toLowerCase();
  const hit = needle
    ? rows.filter((r) => r.host.includes(needle) || r.navn.toLowerCase().includes(needle) || r.kommune.toLowerCase().includes(needle))
    : rows.filter((r) => !r.unreachable);
  return hit.slice(0, limit);
}

export function benchmarkMedians() { return load().medians; }

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
const cleanName = (navn: string) => titleCase(navn.replace(/\s+(AS|ASA|ENK|DA|ANS|SA)$/i, '').trim());

export function generateClient(host: string): { record: ClientRecord; notes: string[] } {
  const { records, medians, counts } = load();
  const r = records.get(hostOf(host));
  if (!r) throw new Error(`Brak ${host} w benchmarku v0.4`);
  if (r.score == null) throw new Error(`${host}: strona była nieosiągalna w benchmarku — brak danych`);

  const words = BRANCH_WORDS[r.branch];
  const firma = cleanName(r.firma?.navn ?? host);
  const by = titleCase(r.firma?.kommune ?? '');
  const score = String(r.score);
  const med = String(Math.round(medians[r.branch]));
  const notes: string[] = [];

  // 3 najbardziej "kosztowne" niezaliczone checki (bez G — te są ręczne) → FUNN/FINDING
  const failed = (r.categories ?? [])
    .filter((c) => c.key !== 'G')
    .flatMap((c) => c.checks)
    .filter((c) => !c.passed)
    .sort((a, b) => (b.max_points - b.points) - (a.max_points - a.points));
  const top = failed.slice(0, 3);
  const finding = top.map((c) => FINDINGS[c.id] ?? `[${c.id}: ${c.name}]`);
  for (const c of top) if (!FINDINGS[c.id]) notes.push(`Check ${c.id} bez tłumaczenia — popraw FINDING ręcznie`);
  while (finding.length < 3) { finding.push(''); notes.push('Mniej niż 3 niezaliczone checki — uzupełnij FINDING'); }

  const record: ClientRecord = {
    customer: hostOf(host),
    to: '',
    'FIRST NAME': '',
    COMPANY: firma,
    'company.no': hostOf(host),
    SERVICE: words.SERVICE,
    CITY: by,
    'COMPETITOR 1': '', 'COMPETITOR 2': '', 'COMPETITOR 3': '',
    '57': score, '70': med, COUNT: String(counts[r.branch]),
    TRADE: words.TRADE,
    'AI OBSERVATION': '',
    'FINDING 1': finding[0], 'FINDING 2': finding[1], 'FINDING 3': finding[2],
    templates: {},
    notes: `${r.firma?.navn ?? ''} · org.nr ${r.firma?.orgnr ?? '?'} · ${r.firma?.ansatte ?? '?'} ansatte · benchmark v0.4: ${score}/100 (${r.label ?? ''}), mediana ${words.TRADE} ${med}.`,
  };
  notes.push(`Wynik ${score}/100 (v0.4), mediana ${words.TRADE}: ${med}. Konkurenci, imię, adres i obserwacja AI — z ręcznych testów G.`);
  return { record, notes };
}
