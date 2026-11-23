export function normalizeSearchText(value, locale) {
  return typeof value === "string"
    ? value.toLocaleLowerCase(locale).normalize("NFD").replace(/\p{Mark}/gu, "")
      .replace(/ي/gu, "ی").replace(/ك/gu, "ک").replace(/\u200c/gu, " ")
    : "";
}

// Each module controls which entries and fields are visible to workspace search.
export function searchWorkspaceModules(query, locale, sources) {
  let searchLocale;
  try {
    [searchLocale] = Intl.getCanonicalLocales(locale);
  } catch {
    // A missing or unsupported locale can still use browser-default case folding.
  }
  const terms = normalizeSearchText(query, searchLocale).split(/\s+/u).filter(Boolean);
  if (!terms.length || !Array.isArray(sources)) return [];

  const results = [];
  for (const source of sources) {
    if (!Array.isArray(source?.entries)) continue;
    const entries = source.entries.filter((entry) => {
      if (!Array.isArray(entry?.keywords)) return false;
      const values = entry.keywords.map((keyword) => normalizeSearchText(keyword, searchLocale)).filter(Boolean);
      return terms.every((term) => values.some((value) => value.includes(term)));
    });
    if (entries.length) results.push({ ...source, entries });
  }
  return results;
}
