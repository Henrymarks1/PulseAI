import { NextRequest, NextResponse } from "next/server";
import Exa from "exa-js";
import OpenAI from "openai";
import {
  getStories,
  upsertStory,
  getTimeline,
  getKnownUrls,
  addTimelineEntry,
} from "@/lib/store";
import { SearchResult, TimelineEntry } from "@/lib/types";

const exa = new Exa(process.env.EXA_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PRIMARY_DOMAINS = [
  "whitehouse.gov", "state.gov", "defense.gov", "centcom.mil",
  "congress.gov", "treasury.gov", "justice.gov", "fbi.gov", "cia.gov",
  "cdc.gov", "who.int", "un.org", "nato.int",
  "gov.uk", "parliament.uk", "supremecourt.gov",
  "federalreserve.gov", "sec.gov",
  "reuters.com", "apnews.com", "afp.com",
];

// Protect the cron endpoint with a secret
function isAuthorized(req: NextRequest): boolean {
  const secret = req.nextUrl.searchParams.get("secret");
  return secret === process.env.CRON_SECRET;
}

async function updateStory(storyId: string, storyTitle: string) {
  const timeline = getTimeline(storyId);
  const knownUrls = getKnownUrls(storyId);

  const lastTimestamp =
    timeline.length > 0 ? timeline[0].timestamp : undefined;
  const since =
    lastTimestamp ||
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const searchOpts = {
    type: "neural" as const,
    useAutoprompt: true,
    startPublishedDate: since,
    contents: { text: { maxCharacters: 1000 } },
  };

  // Dual search: primary sources + general news
  const [primaryRes, generalRes] = await Promise.all([
    exa.search(storyTitle + " official statement announcement", {
      ...searchOpts,
      numResults: 10,
      includeDomains: PRIMARY_DOMAINS,
    }).catch(() => null),
    exa.search(storyTitle, {
      ...searchOpts,
      numResults: 15,
      category: "news",
    }),
  ]);

  const seen = new Set<string>();
  const allResults: SearchResult[] = [];

  const mapResult = (r: (typeof generalRes.results)[0], isPrimary: boolean): SearchResult => ({
    title: r.title || "Untitled",
    url: r.url,
    publishedDate: r.publishedDate || null,
    author: r.author || null,
    text: r.text || "",
    isPrimary,
  });

  if (primaryRes) {
    for (const r of primaryRes.results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        allResults.push(mapResult(r, true));
      }
    }
  }
  for (const r of generalRes.results) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      const domain = new URL(r.url).hostname.replace("www.", "");
      const isPrimary = PRIMARY_DOMAINS.some(
        (d) => domain === d || domain.endsWith("." + d)
      );
      allResults.push(mapResult(r, isPrimary));
    }
  }

  // Filter to only new sources
  const newSources = allResults.filter((r) => !knownUrls.has(r.url));

  if (newSources.length === 0 && timeline.length > 0) {
    const entry: TimelineEntry = {
      id: Date.now().toString(36),
      timestamp: new Date().toISOString(),
      summary: "No new developments found since the last check.",
      newSources: [],
      totalSourceCount: knownUrls.size,
    };
    addTimelineEntry(storyId, entry);
    return { storyId, newSources: 0 };
  }

  // Summarize with primary source priority
  const sorted = [...(newSources.length > 0 ? newSources : allResults)].sort(
    (a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)
  );

  const articleSummaries = sorted
    .slice(0, 8)
    .map(
      (a, i) =>
        `[${i + 1}]${a.isPrimary ? " [PRIMARY SOURCE]" : ""} "${a.title}" (${a.url})\n${a.text}`
    )
    .join("\n\n---\n\n");

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `You are a wire service editor writing live updates for a breaking news blog. Your job is to extract the single most important NEW, SPECIFIC development from the articles provided and write it up as a discrete event update.

Rules:
- PRIORITIZE articles marked [PRIMARY SOURCE] — these are official statements, government releases, or wire service dispatches. Build your update around these when available.
- Lead with the most concrete, specific new fact
- Write 2-4 short paragraphs, like a wire service dispatch
- Include specific details: names, places, numbers, direct quotes when available
- Attribute information to its original source
- Do NOT write vague summaries or overviews of the general situation
- Do NOT use phrases like "significant developments" or "escalating tensions"
- Write as if each update is a standalone news item a reader encounters on a live blog
- Use past tense for events that happened, present tense for ongoing situations`,
      },
      {
        role: "user",
        content: `Extract the most important specific new development from these articles about "${storyTitle}" and write it as a live blog update:\n\n${articleSummaries}`,
      },
    ],
  });

  const summary =
    completion.choices[0]?.message?.content || "Unable to generate summary.";

  const updatedKnownCount = knownUrls.size + newSources.length;

  const entry: TimelineEntry = {
    id: Date.now().toString(36),
    timestamp: new Date().toISOString(),
    summary,
    newSources,
    totalSourceCount: updatedKnownCount,
  };

  addTimelineEntry(storyId, entry);

  return { storyId, newSources: newSources.length };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stories = getStories();
  if (stories.length === 0) {
    return NextResponse.json({ message: "No stories to update" });
  }

  // Check which stories are due for an update
  const now = Date.now();
  const due = stories.filter((s) => {
    const last = new Date(s.lastUpdated).getTime();
    const intervalMs = s.refreshInterval * 60 * 1000;
    return now - last >= intervalMs;
  });

  if (due.length === 0) {
    return NextResponse.json({
      message: "No stories due for update",
      nextCheck: stories
        .map((s) => {
          const next =
            new Date(s.lastUpdated).getTime() + s.refreshInterval * 60 * 1000;
          return { title: s.title, nextUpdate: new Date(next).toISOString() };
        })
        .sort(
          (a, b) =>
            new Date(a.nextUpdate).getTime() - new Date(b.nextUpdate).getTime()
        ),
    });
  }

  const results = [];
  for (const story of due) {
    try {
      const result = await updateStory(story.id, story.title);
      // Update the story's lastUpdated
      upsertStory({ ...story, lastUpdated: new Date().toISOString() });
      results.push(result);
    } catch (err) {
      console.error(`Failed to update story ${story.id}:`, err);
      results.push({
        storyId: story.id,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return NextResponse.json({ updated: results });
}
