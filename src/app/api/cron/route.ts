import { NextRequest, NextResponse } from "next/server";
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { webSearch } from "@exalabs/ai-sdk";
import {
  getStories,
  upsertStory,
  getTimeline,
  addTimelineEntry,
} from "@/lib/store";
import { TimelineEntry } from "@/lib/types";
import { z } from "zod";

const updateResponseSchema = z.object({
  hasNewDevelopments: z.boolean(),
  headline: z.string(),
  summary: z.string(),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      publishedDate: z.string().optional(),
      isPrimary: z.boolean().optional(),
    })
  ),
});

function isAuthorized(req: NextRequest): boolean {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) return true;
  // Also allow ?secret= for manual invocations
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
  return `\nHere is what we already know and have reported. Do NOT repeat any of this information:\n${context}`;
}

async function updateStory(storyId: string, storyTitle: string) {
  const timeline = await getTimeline(storyId);
  const threeHoursAgo = new Date(
    Date.now() - 3 * 60 * 60 * 1000
  ).toISOString();
  const priorContext = buildPriorContext(timeline);

  const systemPrompt = `You are a breaking news researcher for a newsroom. Your job is to find the SINGLE most important NEW development about a story.

RULES:
- Search for recent news using the web search tool. Search multiple times with different queries to be thorough.
- Only report developments from the last 3 hours (after ${threeHoursAgo}).
- Focus on ONE specific new event or development, not a roundup.
- If you find nothing new beyond what's already known, say so.
${priorContext}

OUTPUT FORMAT:
Respond with valid JSON only, no other text. The JSON must have these fields:
- "hasNewDevelopments": boolean — false if nothing new was found
- "headline": string — specific, concrete headline
- "summary": string — 2-3 short paragraphs (2-3 sentences each), separated by \\n\\n. Wire-service style. No URLs or citations in the text.
- "sources": array of objects with "title", "url", and optionally "publishedDate" and "isPrimary"`;

  const { text, steps } = await generateText({
    model: openai("gpt-5.4"),
    system: systemPrompt,
    prompt: `Find the latest development about: "${storyTitle}"`,
    tools: {
      webSearch: webSearch({
        numResults: 5,
        startPublishedDate: threeHoursAgo,
        category: "news",
      }),
    },
    stopWhen: stepCountIs(5),
    onStepFinish(event) {
      const step = event as Record<string, unknown>;
      console.log(`[Pulse Cron] Step ${step.stepNumber} for "${storyTitle}"`);
      const toolCalls = step.toolCalls as
        | { toolName: string; input?: Record<string, unknown> }[]
        | undefined;
      if (toolCalls?.length) {
        for (const call of toolCalls) {
          console.log(
            `[Pulse Cron]   Tool: ${call.toolName}`,
            (call.input as Record<string, string>)?.query || ""
          );
        }
      }
      if (step.text) {
        console.log(
          `[Pulse Cron]   Response: ${(step.text as string).slice(0, 200)}...`
        );
      }
    },
  });

  console.log(`[Pulse Cron] "${storyTitle}" completed in ${steps.length} steps`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { storyId, updated: false, error: "Agent did not return valid JSON" };
  }

  const parsed = updateResponseSchema.parse(JSON.parse(jsonMatch[0]));

  if (!parsed.hasNewDevelopments) {
    const entry: TimelineEntry = {
      id: Date.now().toString(36),
      timestamp: new Date().toISOString(),
      headline: "No new developments",
      summary: "No new developments found since the last check.",
      sources: [],
    };
    await addTimelineEntry(storyId, entry);
    return { storyId, updated: false };
  }

  const entry: TimelineEntry = {
    id: Date.now().toString(36),
    timestamp: new Date().toISOString(),
    headline: parsed.headline,
    summary: parsed.summary,
    sources: parsed.sources,
  };
  await addTimelineEntry(storyId, entry);

  return { storyId, updated: true, headline: parsed.headline };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stories = await getStories();
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
      await upsertStory({ ...story, lastUpdated: new Date().toISOString() });
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
