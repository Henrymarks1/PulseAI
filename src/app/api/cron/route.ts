import { NextRequest, NextResponse } from "next/server";
import Exa from "exa-js";
import {
  getStories,
  upsertStory,
  getTimeline,
  addTimelineEntry,
} from "@/lib/store";
import { TimelineEntry } from "@/lib/types";

const exa = new Exa(process.env.EXA_API_KEY);

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description:
        "A specific, concrete headline for the single most important new development",
    },
    summary: {
      type: "string",
      description:
        "2-4 paragraph wire-service style dispatch. Include names, places, numbers, direct quotes. Attribute to sources. Separate paragraphs with double newlines.",
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          publishedDate: { type: "string" },
          isPrimary: {
            type: "boolean",
            description:
              "True if first-hand/official source (government, military, wire service)",
          },
        },
        required: ["title", "url"],
      },
    },
    hasNewDevelopments: {
      type: "boolean",
      description: "False if no genuinely new developments were found since the given time",
    },
  },
  required: ["headline", "summary", "sources", "hasNewDevelopments"],
};

function isAuthorized(req: NextRequest): boolean {
  const secret = req.nextUrl.searchParams.get("secret");
  return secret === process.env.CRON_SECRET;
}

async function updateStory(storyId: string, storyTitle: string) {
  const timeline = getTimeline(storyId);
  const lastTimestamp =
    timeline.length > 0 ? timeline[0].timestamp : undefined;
  const since = lastTimestamp
    ? new Date(lastTimestamp).toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const sinceReadable = new Date(since).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const instructions = `You are a newsroom researcher. Find the SINGLE most important new development about: "${storyTitle}"

CRITICAL: Only find developments that occurred AFTER ${sinceReadable}. Ignore anything published before this time.

Instructions:
1. Search for the most recent breaking news, official statements, and wire service reports
2. Prioritize PRIMARY SOURCES: government websites (.gov, .mil), official statements, press releases, wire services (AP, Reuters, AFP)
3. Identify the SINGLE most newsworthy new development — not a roundup, not a summary of multiple events
4. Extract the concrete facts: who, what, where, when, direct quotes
5. Write it up as ONE wire-service dispatch (2-4 paragraphs)
6. Do NOT include Wikipedia, general explainers, or background pieces
7. If there are no genuinely new developments since the given time, set hasNewDevelopments to false
8. IMPORTANT: Do NOT embed citations, URLs, or source references in the summary text. No inline links, no [Source](url) patterns, no bracketed references. The sources are provided separately in the sources field. The summary should read as clean prose.`;

  const task = await exa.research.create({
    instructions,
    model: "exa-research",
    outputSchema: OUTPUT_SCHEMA,
  });

  const result = await exa.research.pollUntilFinished(task.researchId, {
    pollInterval: 2000,
    timeoutMs: 120000,
  });

  if (result.status !== "completed" || !result.output) {
    return { storyId, updated: false, error: `Research ${result.status}` };
  }

  const parsed = result.output.parsed || JSON.parse(result.output.content);

  if (!parsed.hasNewDevelopments) {
    const entry: TimelineEntry = {
      id: Date.now().toString(36),
      timestamp: new Date().toISOString(),
      headline: "No new developments",
      summary: "No new developments found since the last check.",
      sources: [],
    };
    addTimelineEntry(storyId, entry);
    return { storyId, updated: false };
  }

  const entry: TimelineEntry = {
    id: Date.now().toString(36),
    timestamp: new Date().toISOString(),
    headline: parsed.headline,
    summary: parsed.summary,
    sources: parsed.sources,
  };
  addTimelineEntry(storyId, entry);

  return { storyId, updated: true, headline: parsed.headline };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stories = getStories();
  if (stories.length === 0) {
    return NextResponse.json({ message: "No stories to update" });
  }

  const now = Date.now();
  const due = stories.filter((s) => {
    const last = new Date(s.lastUpdated).getTime();
    const intervalMs = s.refreshInterval * 60 * 1000;
    return now - last >= intervalMs;
  });

  if (due.length === 0) {
    return NextResponse.json({ message: "No stories due for update" });
  }

  const results = [];
  for (const story of due) {
    try {
      const result = await updateStory(story.id, story.title);
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
