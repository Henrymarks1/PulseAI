import { NextRequest, NextResponse } from "next/server";
import Exa from "exa-js";

const exa = new Exa(process.env.EXA_API_KEY);

// Primary/first-hand source domains — government, military, intl orgs, wire services
const PRIMARY_DOMAINS = [
  "whitehouse.gov",
  "state.gov",
  "defense.gov",
  "centcom.mil",
  "congress.gov",
  "treasury.gov",
  "justice.gov",
  "fbi.gov",
  "cia.gov",
  "cdc.gov",
  "who.int",
  "un.org",
  "nato.int",
  "europarl.europa.eu",
  "ec.europa.eu",
  "gov.uk",
  "parliament.uk",
  "elysee.fr",
  "bundeskanzler.de",
  "kremlin.ru",
  "mfa.gov.cn",
  "mod.gov.il",
  "gov.il",
  "supremecourt.gov",
  "federalreserve.gov",
  "sec.gov",
  "reuters.com",
  "apnews.com",
  "afp.com",
];

export async function POST(req: NextRequest) {
  try {
    const { query, numResults = 15, startPublishedDate } = await req.json();

    if (!query) {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    const since =
      startPublishedDate ||
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const searchOpts = {
      type: "neural" as const,
      useAutoprompt: true,
      startPublishedDate: since,
      contents: {
        text: { maxCharacters: 1000 },
      },
    };

    // Run both searches in parallel: primary sources + general news
    const [primaryRes, generalRes] = await Promise.all([
      exa.search(query + " official statement announcement", {
        ...searchOpts,
        numResults: 10,
        includeDomains: PRIMARY_DOMAINS,
      }).catch(() => null),
      exa.search(query, {
        ...searchOpts,
        numResults,
        category: "news",
      }),
    ]);

    const seen = new Set<string>();
    const results: Array<{
      title: string;
      url: string;
      publishedDate: string | null;
      author: string | null;
      text: string;
      isPrimary: boolean;
    }> = [];

    const mapResult = (r: (typeof generalRes.results)[0], isPrimary: boolean) => ({
      title: r.title || "Untitled",
      url: r.url,
      publishedDate: r.publishedDate || null,
      author: r.author || null,
      text: r.text || "",
      isPrimary,
    });

    // Add primary sources first
    if (primaryRes) {
      for (const r of primaryRes.results) {
        if (!seen.has(r.url)) {
          seen.add(r.url);
          results.push(mapResult(r, true));
        }
      }
    }

    // Then general news
    for (const r of generalRes.results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        const domain = new URL(r.url).hostname.replace("www.", "");
        const isPrimary = PRIMARY_DOMAINS.some(
          (d) => domain === d || domain.endsWith("." + d)
        );
        results.push(mapResult(r, isPrimary));
      }
    }

    return NextResponse.json({ results });
  } catch (error: unknown) {
    console.error("Exa search error:", error);
    const message = error instanceof Error ? error.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
