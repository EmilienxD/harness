export interface SearchEntry {
  id: string;
  slug: string;
  href: string;
  title: string;
  articleTitle: string;
  group: string;
  tab: string;
  kind: "article" | "section";
  description: string;
  text: string;
}

export interface SearchResult extends SearchEntry {
  excerpt: string;
  approximate: boolean;
}

export function normalizeSearch(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

const stopWords = new Set(["a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is", "it", "me", "my", "of", "our", "the", "to", "we", "what", "with", "your"]);

export function searchTerms(query: string) {
  const words = [...new Set(normalizeSearch(query).split(/\s+/).filter(Boolean))];
  const useful = words.filter(word => !stopWords.has(word));
  return useful.length ? useful : words;
}

// A single insertion, deletion, substitution, or adjacent transposition.
function oneEditAway(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const differences: number[] = [];
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) differences.push(index);
      if (differences.length > 2) return false;
    }
    if (differences.length <= 1) return true;
    const [first, second] = differences;
    return second === first + 1 && left[first] === right[second] && left[second] === right[first];
  }
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) { shortIndex++; longIndex++; }
    else if (skipped) return false;
    else { skipped = true; longIndex++; }
  }
  return true;
}

function fieldMatch(words: string[], term: string) {
  if (words.includes(term)) return 1;
  if (term.length >= 3 && words.some(word => word.startsWith(term))) return .85;
  if (term.length >= 5 && words.some(word => oneEditAway(word, term))) return .55;
  return 0;
}

function excerpt(text: string, terms: string[]) {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const matches = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const match = matches.length ? Math.min(...matches) : 0;
  const start = match > 70 ? compact.indexOf(" ", match - 60) + 1 : 0;
  let end = Math.min(start + 165, compact.length);
  if (end < compact.length) end = compact.lastIndexOf(" ", end);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

export function searchDocumentation(index: SearchEntry[], query: string) {
  const terms = searchTerms(query);
  if (!terms.length) return { results: [] as SearchResult[], total: 0 };
  const phrase = normalizeSearch(query);
  const ranked = index.flatMap(entry => {
    const fields = [
      { words: normalizeSearch(entry.title).split(" "), weight: 70 },
      { words: normalizeSearch(entry.description).split(" "), weight: 22 },
      { words: normalizeSearch(entry.text).split(" "), weight: 14 },
      { words: normalizeSearch(entry.group).split(" "), weight: 8 },
    ];
    let score = entry.kind === "article" ? 3 : 0;
    let approximate = false;
    for (const term of terms) {
      const matches = fields.map(field => ({ quality: fieldMatch(field.words, term), weight: field.weight }));
      const exact = matches.filter(match => match.quality >= .85);
      const candidates = exact.length ? exact : matches;
      const best = Math.max(...candidates.map(match => match.quality * match.weight));
      if (!best) return [];
      approximate ||= !exact.length;
      score += best;
    }
    const title = normalizeSearch(entry.title);
    if (title === phrase) score += 120;
    else if (title.startsWith(phrase)) score += 45;
    else if (title.includes(phrase)) score += 25;
    if (approximate) score *= .65;
    return [{ entry, score, approximate }];
  }).sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title));

  // Show the best destination per article instead of repeating the same page.
  const seen = new Set<string>();
  const matches = ranked.filter(({ entry }) => {
    if (seen.has(entry.slug)) return false;
    seen.add(entry.slug);
    return true;
  });
  return {
    total: matches.length,
    results: matches.slice(0, 12).map(({ entry, approximate }) => ({ ...entry, approximate, excerpt: excerpt(entry.text || entry.description, terms) })),
  };
}
