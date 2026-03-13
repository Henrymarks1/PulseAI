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
      description:
        "False if no genuinely new developments were found since the given time",
    },
  },
  required: ["headline", "summary", "sources", "hasNewDevelopments"],
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const story = getStory(id);
  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  try {
    const timeline = getTimeline(id);
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

    const instructions = `You are a newsroom researcher. Find the SINGLE most important new development about: "${story.title}"

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
      return NextResponse.json(
        { error: `Research ${result.status}` },
        { status: 500 }
      );
    }

    const parsed = result.output.parsed || JSON.parse(result.output.content);

    const entry: TimelineEntry = {
      id: Date.now().toString(36),
      timestamp: new Date().toISOString(),
      headline: parsed.hasNewDevelopments
        ? parsed.headline
        : "No new developments",
      summary: parsed.hasNewDevelopments
        ? parsed.summary
        : "No new developments found since the last check.",
      sources: parsed.hasNewDevelopments ? parsed.sources : [],
    };

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
