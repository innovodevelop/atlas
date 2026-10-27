/* atlas-filings.js — smart-home-only filing collector, live sources.
   Reader proxy: r.jina.ai fronts both origins with CORS headers, which is the
   only reason this works from the page. Direct patents.google.com and
   search.patentsview.org fetches are refused (CORS / API key).
   Every record carries an `origin` so live and cached are never conflated. */

const READER = 'https://r.jina.ai/';

/* ---------- smart-home classification ----------
   A filing enters the set only if it clears the class or keyword test and is not
   caught by the deny list. Classes are the real USPTO design / Locarno / FCC ones. */
export const SMART_HOME = {
  designClasses: {
    D26: 'Lighting — bulbs, luminaires, fixtures',
    D14: 'Recording, communication and data-processing equipment — speakers, hubs, displays',
    D23: 'Environmental, heating, ventilating and plumbing — thermostats, purifiers, valves',
    D13: 'Production and distribution of electricity — plugs, switches',
    D10: 'Measuring, testing and signalling instruments — sensors, detectors',
    D08: 'Tools and hardware — locks, latches'
  },
  locarno: { '13-03': 'Electrical apparatus', '26-05': 'Lighting devices', '23-04': 'Ventilation', '14-03': 'Communications' },
  fccEquipmentClasses: {
    DTS: 'Digital transmission system (Wi-Fi / Zigbee / Thread 2.4 GHz)',
    DSS: 'Spread-spectrum transmitter',
    NII: 'Unlicensed national information infrastructure (5/6 GHz Wi-Fi)',
    JBP: 'Part 15 low-power communication device'
  },
  allow: ['speaker','thermostat','doorbell','lock','deadbolt','camera','sensor','hub','bridge',
    'bulb','lamp','luminaire','light','plug','outlet','switch','dimmer','blind','shade','curtain',
    'vacuum','purifier','humidifier','valve','radiator','siren','chime','detector','smoke',
    'leak','mesh','router','access point','display','kettle','oven','fridge','refrigerator',
    'sprinkler','garage','gate','fan','heater','scale','feeder','thermometer','soundbar',
    'subwoofer','home','nest','echo','hue',
    /* wording observed in real grant records */
    'media receiver','media streaming','streaming device','push button','wall clock',
    'smart display','base station','digital media','voice assistant','wireless speaker'],
  deny: ['phone','handset','laptop','notebook','tablet','watch','earbud','earphone','headphone',
    'keyboard','mouse','stylus','vehicle','automobile','drone','trackpad','case for','charger',
    'charging','cable','adapter','stand for','strap','band for','pencil'],
  /* patent query terms — Google Patents accepts an OR group */
  queryTerms: ['speaker','thermostat','doorbell','lock','luminaire','lamp','hub',
    'sensor','plug','camera','display device','purifier']
};

export function isSmartHome(rec) {
  const hay = [rec.name, rec.title, rec.product, rec.equipment, rec.archetype,
    (rec.patents || []).map(p => p.title).join(' ')].filter(Boolean).join(' ').toLowerCase();
  if (!hay.trim()) return { ok: false, why: 'no description to classify' };
  const deny = SMART_HOME.deny.find(k => hay.includes(k));
  if (deny) return { ok: false, why: 'excluded category “' + deny + '”' };
  const cls = (rec.designClass || '').toUpperCase();
  if (cls && SMART_HOME.designClasses[cls]) return { ok: true, why: 'design class ' + cls };
  const hit = SMART_HOME.allow.find(k => hay.includes(k));
  if (hit) return { ok: true, why: 'keyword “' + hit + '”' };
  return { ok: false, why: 'no smart-home class or keyword' };
}

/* ---------- transport ---------- */
async function once(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(READER + url, { signal: ac.signal });
    if (r.status === 429) throw new Error('rate limited by the reader proxy — wait a moment and retry');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

/* The reader proxy rate-limits on a free tier, so a single failure is not a
   verdict on the source: retry once with backoff before giving up. */
async function read(url, ms) {
  const budget = ms || 22000;
  try { return await once(url, budget); }
  catch (e) {
    if (/abort/i.test(e.name || '') || /rate limited/.test(e.message)) {
      await new Promise(r => setTimeout(r, 1800));
      return await once(url, budget);
    }
    throw e;
  }
}

function why(e) {
  if (/abort/i.test(e.name || '')) return 'timed out';
  if (/Failed to fetch|NetworkError/i.test(e.message)) return 'blocked at the network boundary';
  return e.message;
}

async function pool(items, n, fn) {
  const out = [], q = items.slice();
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) { const it = q.shift(); try { out.push(await fn(it)); } catch (e) { /* skipped */ } }
  }));
  return out.filter(Boolean);
}

/* ---------- source 1: Google Patents design filings ---------- */
async function patentQuery(q) {
  const txt = await read('https://patents.google.com/xhr/query?url=' + encodeURIComponent(q), 30000);
  const i = txt.indexOf('{"results"');
  if (i < 0) return null;
  return JSON.parse(txt.slice(i));
}

export async function fetchPatents(brand, assignee) {
  const who = assignee || brand;
  /* the OR group is richer; the single-term shape is the one proven to parse, so
     it stands in when the group form comes back in an unexpected shape */
  let j = await patentQuery('q=(' + SMART_HOME.queryTerms.join(' OR ') +
    ')&assignee=' + who + '&type=DESIGN');
  if (!j) j = await patentQuery('q=' + SMART_HOME.queryTerms[0] + '&assignee=' + who + '&type=DESIGN');
  if (!j) throw new Error('no parseable payload from either query shape');
  const rows = [];
  ((j.results || {}).cluster || []).forEach(c => (c.result || []).forEach(r => {
    const p = r.patent || {}, id = String(r.id || '').split('/')[1] || '';
    if (!/^USD\d+/.test(id)) return;               /* design patents only */
    rows.push({
      no: id.replace(/^US/, '').replace(/S\d*$/, ''),
      title: (p.title || '').replace(/<[^>]*>/g, '').trim(),
      granted: p.grant_date || '', filed: p.filing_date || '',
      assignee: p.assignee || assignee || brand
    });
  }));
  return rows;
}

/* ---------- source 2: FCC equipment authorisations ---------- */
/* Two index hosts: coverage differs per grantee. fcc.report exposes Apple's BCG
   index as a table of links but renders Google's A4R page without any IDs, so a
   second host is tried before calling discovery unavailable. */
const INDEX_HOSTS = [
  (g) => 'https://fcc.report/FCC-ID/' + encodeURIComponent(g),
  (g) => 'https://fccid.io/' + encodeURIComponent(g),
  (g) => 'https://fccid.io/grantee-code/' + encodeURIComponent(g),
  (g) => 'https://fcc.report/company/' + encodeURIComponent(g)
];

/* Returns the parsed rows carrying the host that actually answered — coverage
   differs per grantee, so which host worked is diagnostic information. */
export async function fetchGranteeIndex(grantee) {
  const tried = [];
  for (const host of INDEX_HOSTS) {
    const url = host(grantee), name = url.split('/')[2];
    try {
      const rows = parseIndex(await read(url), grantee);
      if (rows.length) { rows.host = name; rows.tried = tried; return rows; }
      tried.push(name + ': no IDs in page');
    } catch (e) { tried.push(name + ': ' + why(e)); }
  }
  throw new Error('no host exposed an index — ' + tried.join('; '));
}

function parseIndex(txt, grantee) {
  /* Grantee pages come back in two shapes: some as a markdown table of links,
     some as flat text with no links at all. Read links where they exist, then fall
     back to matching bare IDs by their grantee prefix — that is markup-independent. */
  const seen = new Set(), rows = [];
  const push = (id, date) => {
    id = id.toUpperCase().replace(/-$/, '');
    if (id === grantee.toUpperCase() || id.length < grantee.length + 2 || seen.has(id)) return;
    seen.add(id);
    rows.push({ fcc: id, granted: date || '' });
  };
  for (const line of txt.split('\n')) {
    const date = (line.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    const link = line.match(/\[([A-Z0-9-]{4,})\]\(https:\/\/(?:fcc\.report\/FCC-ID|fccid\.io)\/([A-Z0-9-]+)\/?\)/i);
    if (link) { push(link[2] || link[1], date); continue; }
    const bare = new RegExp('\\b' + grantee.toUpperCase() + '[-]?[A-Z0-9]{2,}\\b', 'g');
    for (const m of line.toUpperCase().matchAll(bare)) push(m[0], date);
  }
  rows.sort((a, b) => (b.granted || '').localeCompare(a.granted || ''));
  return rows;
}

/* Per-device page: equipment name plus the exhibit list — external photos are
   what calibration traces against, so their direct links are captured. */
export async function fetchFiling(id) {
  const txt = await read('https://fcc.report/FCC-ID/' + encodeURIComponent(id), 15000);
  /* fcc.report renders the grant's product description as a bare "Equipment <name>"
     line, and the model as "Product Code-<code>". The "### Equipment:" heading above
     it is followed by the applicant, not the product — do not read that one. */
  let equipment = '', code = '';
  const eq = txt.match(/(?:^|\n)Equipment[ \t]+([^\n|#][^\n]*)/);
  if (eq) equipment = eq[1].trim();
  const nm = txt.match(/\|\s*(?:Product|Equipment|Device)\s*Name[^|]*\|\s*([^|\n]+)\|/i);
  if (nm && nm[1].trim()) equipment = nm[1].trim();
  /* Grant-certificate pages carry no "Product Code" or bare "Equipment" line at all —
     the description sits in the page title suffix and in the Notes field. */
  if (!equipment) {
    const ti = txt.match(/Title:\s*FCC ID\s+[A-Z0-9-]+\s*[-–]\s*([^\n]+)/i);
    if (ti) equipment = ti[1].trim();
  }
  if (!equipment) {
    const no = txt.match(/\*\*Notes:\*\*+\s*([^*\n]+)/i);
    if (no) equipment = no[1].trim();
  }
  const ec = txt.match(/\*\*Equipment Class:\*\*+\s*([^*\n]+)/i);
  const equipmentClass = ec ? ec[1].trim() : '';
  const pc = txt.match(/Product Code[-:\s]+([A-Za-z0-9._-]+)/);
  if (pc) code = pc[1].trim();

  /* The last cell of an exhibit row is a NESTED markdown link whose label holds an
     image: [pdf ![Image 7](…/external.svg)](…/4938486.pdf). A single pattern cannot
     cross the inner ']', so matching left-to-right captures the icon instead of the
     document. Take the LAST fcc.report .pdf URL on the row — that is the exhibit. */
  const exhibits = [];
  for (const line of txt.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const pdf = [...line.matchAll(/\((https:\/\/fcc\.report\/[^)\s]+\.pdf)\)/g)].map(m => m[1]).pop();
    if (!pdf) continue;
    const name = (line.match(/\|\s*\[([^\]]+)\]/) || [])[1];
    const type = (line.match(/\|\s*\[[^\]]+\]\([^)]*\)\s*\|\s*([^|]+)\|/) || [])[1];
    exhibits.push({ name: (name || 'Exhibit').trim(), type: (type || '').trim(), pdf });
  }
  const photos = exhibits.filter(e => /external photo/i.test(e.type + ' ' + e.name));
  const labels = exhibits.filter(e => /label/i.test(e.type + ' ' + e.name));
  return { fcc: id, equipment, equipmentClass, code, exhibits: exhibits.length, photos, labels,
    page: 'https://fcc.report/FCC-ID/' + id };
}

/* ---------- resolve real FCC IDs ----------
   Constructing an ID from grantee + model is guesswork, and three of mine did not
   exist. Deriving one is exact: every filing page carries a "Product Code-XXXX"
   line, and that code IS the manufacturer model number the registry already
   stores (HomePod mini A2374 -> Product Code-A2374). The join key is the model,
   so the lookup is deterministic rather than a guess. */

const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* token overlap on the product description — fallback only, when no code matches */
function nameScore(a, b) {
  const A = String(a || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const B = String(b || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (!A.length || !B.length) return 0;
  const set = new Set(B);
  return A.filter(t => set.has(t)).length / A.length;
}

export async function resolveFccIds(brand, meta, opts) {
  opts = opts || {};
  const say = opts.onStatus || (() => {});
  const cap = opts.cap || 36;
  const grantee = (meta.grantee || '').split(/\s*\/\s*/)[0];
  const products = (meta.products || []).filter(p => isSmartHome(p).ok);

  const idx = await fetchGranteeIndex(grantee);
  say({ phase: 'index', brand, host: idx.host, n: idx.length });

  /* Reading a chronological window misses everything older than it: Apple's newest
     36 filings are 2025 hardware, so HomePod mini's 2020 grant was never opened.
     Most vendors mint the ID as grantee + model (BCG-A2374 for model A2374), so
     first pick the index rows whose ID already contains a wanted model code — that
     is an exact, cheap targeting step — and only then fall back to a window. */
  const wanted = products.map(p => norm(p.model)).filter(Boolean);
  const targeted = idx.filter(r => wanted.some(w => w && norm(r.fcc).includes(w)));
  const rest = idx.filter(r => !targeted.includes(r));
  const queue = targeted.concat(rest.slice(0, Math.max(0, cap - targeted.length)));
  say({ phase: 'target', brand, targeted: targeted.length, queue: queue.length });

  const byCode = new Map(), all = [];
  let n = 0;
  await pool(queue, 4, async (row) => {
    const f = await fetchFiling(row.fcc);
    say({ phase: 'read', brand, n: ++n, of: queue.length,
      fcc: row.fcc, code: f.code, equipment: f.equipment });
    const rec = { fcc: row.fcc, code: f.code, equipment: f.equipment, granted: row.granted };
    all.push(rec);
    if (f.code) byCode.set(norm(f.code), rec);
    /* index the ID's own tail too — BCG-A2374 carries the model in the ID */
    const tail = norm(row.fcc).replace(norm(grantee), '');
    if (tail && !byCode.has(tail)) byCode.set(tail, rec);
    return true;
  });

  /* direct probe: cheaper and deeper than the index for anything already carrying
     an ID, and it works regardless of how far back the index goes */
  const direct = products.filter(p => (p.fcc || p.fccConstructed) &&
    !all.some(r => r.fcc === (p.fcc || p.fccConstructed)));
  await pool(direct, 3, async (p) => {
    const id = p.fcc || p.fccConstructed;
    try {
      const f = await fetchFiling(id);
      const rec = { fcc: id, code: f.code, equipment: f.equipment, granted: '' };
      if (!f.code && !f.equipment) {
        say({ phase: 'probe', brand, fcc: id, ok: false, absent: true,
          why: 'page loaded but carries no grant content' });
      } else {
        all.push(rec);
        if (f.code) byCode.set(norm(f.code), rec);
        byCode.set(norm(id).replace(norm(grantee), ''), rec);
        say({ phase: 'probe', brand, fcc: id, code: f.code, equipment: f.equipment, ok: true });
      }
    } catch (e) {
      /* transport failure — the ID's status is unknown, not disproved */
      say({ phase: 'probe', brand, fcc: id, ok: false, absent: false, why: why(e) });
    }
    return true;
  });

  const out = [];
  for (const p of products) {
    const want = norm(p.model);
    let hit = (want && byCode.get(want)) || null, how = 'model code';
    if (!hit && want) {
      for (const [code, rec] of byCode) {
        if (code && (code.includes(want) || want.includes(code))) {
          hit = rec; how = 'model code (partial)'; break;
        }
      }
    }
    if (!hit) {
      let best = 0, cand = null;
      for (const rec of all) {
        const sc = nameScore(p.name, rec.equipment);
        if (sc > best) { best = sc; cand = rec; }
      }
      if (best >= 0.5) { hit = cand; how = 'description match ' + Math.round(best * 100) + '%'; }
    }
    out.push(hit
      ? { name: p.name, model: p.model, was: p.fcc || p.fccConstructed || null,
          fcc: hit.fcc, equipment: hit.equipment, how, state: 'resolved' }
      : { name: p.name, model: p.model, was: p.fcc || p.fccConstructed || null,
          state: 'unresolved',
          how: 'no filing among the ' + all.length + ' read for ' + grantee +
               ' carries this model code' });
  }
  return { brand, grantee, host: idx.host, indexSize: idx.length, read: all.length, results: out };
}

/* ---------- pipeline ----------
   Three phases, ordered by reliability:
     1 verify   — re-read every known smart-home filing live, attach its photo exhibits
     2 discover — sample the grantee index across its whole span and classify
     3 patents  — best effort; the reader proxy cannot always render patents.google.com
   Chronological scanning was the earlier mistake: a brand's newest filings are
   whatever it shipped last week, so smart-home devices never surfaced. */

async function verifyCorpus(brand, meta, say) {
  const known = (meta.products || []).filter(p => p.fcc);
  const out = [];
  let n = 0;
  await pool(known, 3, async (p) => {
    try {
      const f = await fetchFiling(p.fcc);
      say({ phase: 'verify', brand, n: ++n, of: known.length, name: p.name,
        equipment: f.equipment, photos: (f.photos || []).length });
      out.push({ ...p, brand, origin: 'cache', verified: true, kind: 'product',
        equipment: f.equipment, photos: f.photos, labels: f.labels, exhibits: f.exhibits,
        page: f.page, why: isSmartHome(p).why });
    } catch (e) {
      say({ phase: 'verify', brand, n: ++n, of: known.length, name: p.name, err: why(e) });
      out.push({ ...p, brand, origin: 'cache', verified: false, kind: 'product',
        why: isSmartHome(p).why });
    }
    return true;
  });
  return out;
}

/* Sample evenly across the index so the scan spans years, not the newest week. */
function stratify(rows, n) {
  if (rows.length <= n) return rows;
  const step = rows.length / n, out = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

async function discover(brand, grantee, cap, say) {
  const idx = await fetchGranteeIndex(grantee);
  const sample = stratify(idx, cap);
  say({ phase: 'source', brand, src: 'FCC — grantee ' + grantee, state: 'ok', n: idx.length,
    extra: 'sampling ' + sample.length + ' across ' +
      (idx.length ? idx[idx.length - 1].granted.slice(0, 4) + '–' + idx[0].granted.slice(0, 4) : '') });

  let n = 0, rejected = 0;
  const kept = [];
  await pool(sample, 4, async (row) => {
    const f = await fetchFiling(row.fcc);
    const t = isSmartHome(f);
    say({ phase: 'enrich', brand, n: ++n, of: sample.length,
      name: f.equipment || row.fcc, kept: t.ok });
    if (!t.ok) { rejected++; return true; }
    kept.push({ brand, name: f.equipment, model: f.code, kind: 'fcc', fcc: f.fcc,
      granted: row.granted, exhibits: f.exhibits, photos: f.photos, labels: f.labels,
      page: f.page, origin: 'live:fcc', conf: 'live', why: t.why });
    return true;
  });
  return { kept, scanned: n, rejected, indexSize: idx.length };
}

let _running = false;
export async function collect(opts) {
  if (_running) throw new Error('a collection is already running');
  _running = true;
  try { return await _collect(opts); } finally { _running = false; }
}

async function _collect(opts) {
  const brands = opts.brands || [];
  const registry = opts.registry || {};
  const say = opts.onStatus || (() => {});
  const cap = opts.enrichCap || 12;
  const log = [], records = [];
  let scanned = 0, rejected = 0, live = 0, blocked = 0, verified = 0, photos = 0;

  for (const brand of brands) {
    const meta = (registry.catalog || {})[brand] || {};
    const grantee = (meta.grantee || '').split(/\s*\/\s*/)[0];
    const assignee = meta.assignee || brand;

    /* 1 — verify the known corpus */
    const vs = await verifyCorpus(brand, meta, say);
    vs.forEach(v => { records.push(v); if (v.verified) verified++; photos += (v.photos || []).length; });
    log.push({ brand, source: 'FCC — verify corpus', state: 'ok', n: vs.filter(v => v.verified).length });

    /* 2 — discover */
    let t0 = performance.now();
    try {
      const d = await discover(brand, grantee, cap, say);
      live++;
      scanned += d.scanned; rejected += d.rejected;
      d.kept.forEach(k => { if (!records.some(r => r.fcc === k.fcc)) records.push(k); });
      log.push({ brand, source: 'FCC — discover', state: 'ok', n: d.kept.length });
    } catch (e) {
      blocked++;
      log.push({ brand, source: 'FCC — discover', state: 'blocked', why: why(e) });
      say({ phase: 'source', brand, src: 'FCC — discover', state: 'blocked', why: why(e),
        ms: Math.round(performance.now() - t0) });
    }

    /* 3 — patents, best effort */
    t0 = performance.now();
    try {
      const ps = await fetchPatents(brand, assignee);
      const kept = ps.filter(p => isSmartHome(p).ok);
      live++;
      log.push({ brand, source: 'Google Patents', state: 'ok', n: kept.length });
      say({ phase: 'source', brand, src: 'Google Patents — design filings', state: 'ok',
        n: kept.length, extra: (ps.length - kept.length) + ' out of category',
        ms: Math.round(performance.now() - t0) });
      kept.forEach(p => records.push({ brand, name: p.title, kind: 'patent', patents: [p],
        origin: 'live:patents', conf: 'live', why: isSmartHome(p).why }));
    } catch (e) {
      blocked++;
      const msg = /abort|timed out/i.test(why(e))
        ? 'the reader proxy could not render patents.google.com in time'
        : why(e);
      log.push({ brand, source: 'Google Patents', state: 'blocked', why: msg });
      say({ phase: 'source', brand, src: 'Google Patents — design filings', state: 'blocked',
        why: msg, ms: Math.round(performance.now() - t0) });
    }
  }

  say({ phase: 'done', n: records.length, scanned, rejected, live, blocked, verified, photos });
  return { records, log, scanned, rejected, live, blocked, verified, photos };
}
