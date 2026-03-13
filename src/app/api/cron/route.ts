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

const UPDATE_SCHEMA = {
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
        "Brief 2-3 paragraph update, each paragraph 2-3 sentences. Concise wire-service style. Separate paragraphs with double newlines.",
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
      description:
        "False if no genuinely new developments were found beyond what is already known",
    },
  },
  required: ["headline", "summary", "sources", "hasNewDevelopments"],
};

function isAuthorized(req: NextRequest): boolean {
  const secret = req.nextUrl.searchParams.get("secret");
  return secret === process.env.CRON_SECRET;
}

function buildPriorContext(timeline: TimelineEntry[]): string {
  if (timeline.length === 0) return "";
  const recent = timeline
    .filter((e) => e.headline !== "No new developments")
    .slice(0, 10);
  if (recent.length === 0) return "";
  const context = recent
    .map((e) => `- ${e.headline}: ${e.summary.split("\n\n")[0]}`)
    .join("\n");
  return `\n\nHere is what we already know and have reported. Do NOT repeat any of this information:\n${context}`;
}

async function updateStory(storyId: string, storyTitle: string) {
  const timeline = getTimeline(storyId);
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const sinceReadable = new Date(threeHoursAgo).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const priorContext = buildPriorContext(timeline);

  const instructions = `You are a newsroom researcher. Find the SINGLE most important new development about: "${storyTitle}"

Only consider articles published after ${sinceReadable}. Ignore anything older.
${priorContext}

Instructions:
1. Search credible news sources for the most recent development NOT already listed above
2. Write a SHORT 2-3 paragraph dispatch (each paragraph 2-3 sentences max). Be concise — this is a brief wire-service update, not a feature article
3. Include key facts: who, what, where, when. One direct quote if available
4. Do NOT include Wikipedia, explainers, or background pieces
5. If there are no new developments beyond what is listed above, set hasNewDevelopments to false
6. Do NOT embed URLs or source references in the summary text. Sources go in the sources field only.`;

  const task = await exa.research.create({
    instructions,
    model: "exa-research-fast",
    outputSchema: UPDATE_SCHEMA,
  });

  const result = await exa.research.pollUntilFinished(task.researchId, {
    pollInterval: 2000,
    timeoutMs: 300000,
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
