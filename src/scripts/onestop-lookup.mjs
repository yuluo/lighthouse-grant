import { createReadStream, createWriteStream, writeFileSync } from 'fs';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { existsSync } from 'fs';
import { readFileSync } from 'fs';

const CSV_PATH = new URL('../../interest-partner.csv', import.meta.url).pathname;
const REVIEW_PATH = new URL('../../onestop-review.csv', import.meta.url).pathname;

const ONESTOP_URL = 'https://onestop.md.gov/list_views/62f3e1797f7e3200016a3dab/entries';
const NAME_FILTER_ID = '2b66e151-641c-474f-af94-7954e5c3443a';

const FIELDS = {
  name: 'f_aedd5545-808f-4725-9b1d-5fa61e994a75',
  status: '5a2d50d7-9fbe-4212-8710-b932c8d6c8c2',
  address: 'a54d0eb2-94bf-44cd-b397-66f6d6722d43',
  year: 'dfa10ea8-7c3a-4c4c-a628-4b8b38c320e6',
  financials: '78731b0e-2ec7-4ed4-bdfb-009c1a8c9b4e',
};

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return sleep(2000 + Math.random() * 2000);
}

function extractVar(html) {
  if (!html) return '';
  const matches = [...html.matchAll(/<var>([\s\S]*?)<\/var>/g)];
  return matches.map(m => m[1].trim());
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length, 1);
}

function cleanOrgName(name) {
  return name
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\b(inc\.?|llc\.?|corp\.?|ltd\.?|l\.l\.c\.?|dba\s+\S+)\b/gi, '')
    .replace(/\|.*$/, '')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCity(address) {
  if (!address) return null;
  const lower = address.toLowerCase();
  const statePatterns = [
    /,?\s+([a-z\s]+),?\s+(?:md|dc|va|maryland|virginia)\b/i,
    /\b([a-z\s]+),\s+(?:md|dc|va)\b/i,
  ];
  for (const pat of statePatterns) {
    const m = address.match(pat);
    if (m) return m[1].trim().toLowerCase();
  }
  const parts = address.split(/[\s,]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d{5}$/.test(parts[i])) {
      const candidate = parts.slice(Math.max(0, i - 2), i).join(' ').toLowerCase();
      if (candidate) return candidate;
    }
  }
  return null;
}

function parseEntry(entry) {
  const vd = entry.view_data?.content_element_data || {};
  const statusVars = extractVar(vd[FIELDS.status]);
  const addressVars = extractVar(vd[FIELDS.address]);
  const yearVars = extractVar(vd[FIELDS.year]);
  const financialVars = extractVar(vd[FIELDS.financials]);
  return {
    name: entry[FIELDS.name] || '',
    status: statusVars[0] || '',
    address: addressVars[0] || '',
    year: yearVars[0] || '',
    contributions: financialVars[0] || '',
    revenue: financialVars[1] || '',
  };
}

async function fetchOnestop(query, retries = 2) {
  const params = new URLSearchParams({
    _method: 'get',
    [`filter[${NAME_FILTER_ID}]`]: query,
    'filter[limit]': '20',
    [NAME_FILTER_ID]: query,
    limit: '20',
    fake: 'false',
    forceNewQuery: 'false',
    'query[page]': '1',
    page: '1',
  });
  const url = `${ONESTOP_URL}?${params}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Referer': 'https://onestop.md.gov/',
        },
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt < retries) {
          console.log(`  Rate limited (${res.status}), waiting 30s...`);
          await sleep(30000);
          continue;
        }
        return null;
      }
      if (!res.ok) {
        console.log(`  HTTP ${res.status} for query: ${query}`);
        return null;
      }
      const data = await res.json();
      return data.entries || [];
    } catch (err) {
      if (attempt < retries) {
        console.log(`  Fetch error, retrying: ${err.message}`);
        await sleep(5000);
      } else {
        console.log(`  Fetch failed: ${err.message}`);
        return null;
      }
    }
  }
  return null;
}

function pickBestMatch(entries, csvName, csvAddress) {
  if (entries.length === 0) return null;

  if (entries.length === 1) {
    const parsed = parseEntry(entries[0]);
    const score = similarity(csvName, parsed.name);
    return { parsed, score, flagged: score < 0.5 };
  }

  const city = extractCity(csvAddress);
  let candidates = entries;

  if (city) {
    const cityFiltered = candidates.filter(e => {
      const parsed = parseEntry(e);
      return parsed.address.toLowerCase().includes(city);
    });
    if (cityFiltered.length > 0) candidates = cityFiltered;
  }

  if (candidates.length === 1) {
    const parsed = parseEntry(candidates[0]);
    return { parsed, score: similarity(csvName, parsed.name), flagged: false };
  }

  const currentOnly = candidates.filter(e => parseEntry(e).status === 'Current');
  if (currentOnly.length === 1) {
    const parsed = parseEntry(currentOnly[0]);
    return { parsed, score: similarity(csvName, parsed.name), flagged: false };
  }

  return { parsed: null, flagged: true, candidates: candidates.map(parseEntry) };
}

async function resolveOrg(csvName, csvAddress) {
  let entries = await fetchOnestop(csvName);
  if (entries === null) return { status: 'NEEDS REVIEW', note: 'fetch error' };

  if (entries.length === 0) {
    const cleaned = cleanOrgName(csvName);
    if (cleaned && cleaned.toLowerCase() !== csvName.toLowerCase()) {
      console.log(`  No results, retrying with cleaned name: "${cleaned}"`);
      await randomDelay();
      entries = await fetchOnestop(cleaned);
      if (entries === null) return { status: 'NEEDS REVIEW', note: 'fetch error' };
    }
  }

  if (entries.length === 0) {
    return { status: 'NOT FOUND' };
  }

  const result = pickBestMatch(entries, csvName, csvAddress);

  if (result.flagged) {
    return {
      status: 'NEEDS REVIEW',
      candidates: result.candidates || (result.parsed ? [result.parsed] : []),
    };
  }

  return { status: result.parsed.status || 'Unknown', data: result.parsed };
}

async function main() {
  const rawCsv = readFileSync(CSV_PATH, 'utf8');

  const rows = await new Promise((resolve, reject) => {
    parse(rawCsv, { columns: true, skip_empty_lines: true }, (err, records) => {
      if (err) reject(err); else resolve(records);
    });
  });

  const newColumns = ['onestop_status', 'onestop_name', 'onestop_address', 'onestop_year', 'onestop_contributions', 'onestop_revenue'];
  const reviewRows = [];
  let processed = 0, skipped = 0, notFound = 0, needsReview = 0, matched = 0;

  for (const row of rows) {
    if (row.onestop_status && row.onestop_status.trim() !== '') {
      skipped++;
      continue;
    }

    console.log(`Looking up: ${row.organization}`);
    await randomDelay();

    const result = await resolveOrg(row.organization, row.address);

    if (result.status === 'NOT FOUND') {
      row.onestop_status = 'NOT FOUND';
      row.onestop_name = '';
      row.onestop_address = '';
      row.onestop_year = '';
      row.onestop_contributions = '';
      row.onestop_revenue = '';
      notFound++;
      console.log(`  -> NOT FOUND`);
    } else if (result.status === 'NEEDS REVIEW') {
      row.onestop_status = 'NEEDS REVIEW';
      row.onestop_name = '';
      row.onestop_address = '';
      row.onestop_year = '';
      row.onestop_contributions = '';
      row.onestop_revenue = '';
      needsReview++;
      console.log(`  -> NEEDS REVIEW (${result.note || (result.candidates?.length || 0) + ' candidates'})`);
      if (result.candidates) {
        for (const c of result.candidates) {
          reviewRows.push({ csv_organization: row.organization, ...c });
        }
      }
    } else {
      const d = result.data;
      row.onestop_status = d.status;
      row.onestop_name = d.name;
      row.onestop_address = d.address;
      row.onestop_year = d.year;
      row.onestop_contributions = d.contributions;
      row.onestop_revenue = d.revenue;
      matched++;
      console.log(`  -> ${d.status}: ${d.name}`);
    }

    processed++;
  }

  const outCsv = await new Promise((resolve, reject) => {
    stringify(rows, { header: true }, (err, output) => {
      if (err) reject(err); else resolve(output);
    });
  });
  writeFileSync(CSV_PATH, outCsv);

  if (reviewRows.length > 0) {
    const reviewCsv = await new Promise((resolve, reject) => {
      stringify(reviewRows, { header: true }, (err, output) => {
        if (err) reject(err); else resolve(output);
      });
    });
    writeFileSync(REVIEW_PATH, reviewCsv);
    console.log(`\nReview file written: ${REVIEW_PATH}`);
  }

  console.log(`\nDone.`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Skipped (already filled): ${skipped}`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Needs review: ${needsReview}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
