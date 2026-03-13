import { NextRequest, NextResponse } from "next/server";
import Exa from "exa-js";
import {
  getStory,
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
      description:
        "False if no genuinely new developments were found beyond what is already known",
    },
  },
  required: ["headline", "summary", "sources", "hasNewDevelopments"],
};

const INITIAL_SCHEMA = {
  type: "object",
  properties: {
    headline: {
      type: "string",
      description: "A headline summarizing the current state of this story",
    },
    summary: {
      type: "string",
      description:
        "A single paragraph of about 6 sentences summarizing the story so far. Cover the key events, major players, and current status concisely.",
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
  },
  required: ["headline", "summary", "sources"],
};

function buildPriorContext(timeline: TimelineEntry[]): string {
  if (timeline.length === 0) return "";

  const recent = timeline.slice(0, 10);
  const context = recent
    .map((e) => `- ${e.headline}: ${e.summary.split("\n\n")[0]}`)
    .join("\n");

  return `\n\nHere is what we already know and have reported. Do NOT repeat any of this information:\n${context}`;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const story = getStory(id);
  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  try {
    const timeline = getTimeline(id);
    const isInitial = timeline.length === 0;

    let instructions: string;
    let schema: Record<string, unknown>;

    if (isInitial) {
      instructions = `You are a newsroom researcher. Research the current state of this story: "${story.title}"

Write a concise single-paragraph summary (about 6 sentences) of where this story stands right now. Cover what happened, the key developments, major players, and current status.

Use a wide range of sources: major newspapers (NYT, WSJ, Washington Post), wire services (AP, Reuters, AFP), broadcasters (CNN, BBC, Al Jazeera), government/official sources, and any other credible news outlets. Do not limit yourself to only government or military sources.
Do NOT embed citations, URLs, or source references in the summary text. No inline links, no [Source](url) patterns. The sources field is separate. The summary should read as clean prose.`;
      schema = INITIAL_SCHEMA;
    } else {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const sinceReadable = new Date(thirtyMinsAgo).toLocaleString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });

      const priorContext = buildPriorContext(timeline);

      instructions = `You are a newsroom researcher. Find the SINGLE most important new development about: "${story.title}"

CRITICAL: Only consider articles and events FIRST PUBLISHED within the last 30 minutes (after ${sinceReadable}). Nothing older. If an article was published more than 30 minutes ago, ignore it completely — even if you haven't seen it before.
${priorContext}

Instructions:
1. Search ALL credible news sources published in the LAST 30 MINUTES ONLY — major newspapers (NYT, WSJ, Washington Post, Guardian), wire services (AP, Reuters, AFP), broadcasters (CNN, BBC, Al Jazeera, Fox News), government/official sources, and any other credible outlets
2. Identify the SINGLE most newsworthy NEW development that is NOT already covered above
3. Extract the concrete facts: who, what, where, when, direct quotes
4. Write it up as ONE wire-service dispatch (2-4 paragraphs)
5. Do NOT include Wikipedia, general explainers, or background pieces
6. If there are no genuinely new developments published in the last 30 minutes, set hasNewDevelopments to false
7. IMPORTANT: Do NOT embed citations, URLs, or source references in the summary text. No inline links, no [Source](url) patterns, no bracketed references. The sources are provided separately in the sources field. The summary should read as clean prose.`;
      schema = UPDATE_SCHEMA;
    }

    // Try fast model first for updates, fall back to standard if it fails
    let result;
    const models = ["exa-research" as const];

    for (const model of models) {
      try {
        console.log(`[Pulse] Starting research with model: ${model}`);
        const task = await exa.research.create({
          instructions,
          model,
          outputSchema: schema,
        });
        result = await exa.research.pollUntilFinished(task.researchId, {
          pollInterval: 2000,
          timeoutMs: 300000,
        });
        if (result.status === "completed") break;
      } catch (err) {
        console.error(`[Pulse] Model ${model} failed:`, err);
        if (model === models[models.length - 1]) throw err;
        console.log(`[Pulse] Falling back to next model...`);
      }
    }

    if (!result || result.status !== "completed" || !result.output) {
      return NextResponse.json({ error: `Research failed` }, { status: 500 });
    }

    const parsed = result.output.parsed || JSON.parse(result.output.content);

    let entry: TimelineEntry;

    if (isInitial) {
      entry = {
        id: Date.now().toString(36),
        timestamp: new Date().toISOString(),
        headline: parsed.headline,
        summary: parsed.summary,
        sources: parsed.sources,
      };
    } else if (!parsed.hasNewDevelopments) {
      entry = {
        id: Date.now().toString(36),
        timestamp: new Date().toISOString(),
        headline: "No new developments",
        summary: "No new developments found since the last check.",
        sources: [],
      };
    } else {
      entry = {
        id: Date.now().toString(36),
        timestamp: new Date().toISOString(),
        headline: parsed.headline,
        summary: parsed.summary,
        sources: parsed.sources,
      };
    }

    addTimelineEntry(id, entry);
    upsertStory({
      ...story,
      lastUpdated: new Date().toISOString(),
      description: `${timeline.length + 1} updates`,
    });

    return NextResponse.json({ entry });
  } catch (error: unknown) {
    console.error("Update error:", error);
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
