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
  hasNewDevelopments: z
    .boolean()
    .describe("False if no genuinely new developments were found"),
  headline: z
    .string()
    .describe("A specific, concrete headline for the new development"),
  summary: z
    .string()
    .describe(
      "Fact-rich bullet points for journalists. Each bullet starts with '• ' and states one specific new fact (who, what, where, when, numbers). 3-6 bullets. No narrative prose — just the verifiable facts. Separate bullets with newlines.",
    ),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      publishedDate: z.string().optional(),
      isPrimary: z.boolean().optional(),
    }),
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

  const systemPrompt = `You are a tenacious breaking news researcher for a newsroom. Your job is to find NEW developments about a story that journalists haven't reported yet.

SEARCH STRATEGY — you MUST be thorough:
1. Start with a broad news search for the story topic
2. Search with different phrasings and angles (e.g. specific people involved, locations, organizations)
3. Search the general web for social media posts, X/Twitter reactions, Reddit threads — use queries like the topic + "site:x.com" or "site:reddit.com"
4. Search for official statements, press releases, government responses
5. Search for analysis, expert commentary, and opinion pieces that contain new facts
6. If early searches return nothing, try broader terms, related subtopics, or different angles

You MUST perform at LEAST 4-5 different searches before concluding there's nothing new. Be creative with your queries — vary phrasing, try names of key people, organizations, locations.

RULES:
- Search for developments from the last 3 hours (after ${threeHoursAgo}).
- Almost ALWAYS find something to report. Even smaller developments matter — new quotes, reactions, policy shifts, social media discourse, international responses, expert analysis with new data points.
- Only set hasNewDevelopments to false as an absolute last resort after exhaustive searching across news, web, and social media. A journalist would rather have a minor update than no update.
- Focus on what's NEW compared to what we already reported.
${priorContext}

OUTPUT FORMAT:
Respond with valid JSON only, no other text. The JSON must have these fields:
- "hasNewDevelopments": boolean — almost always true. Only false after 5+ searches across news AND general web turned up absolutely nothing new.
- "headline": string — specific, concrete headline (e.g. "Pentagon confirms second wave of strikes on Iranian air defenses")
- "summary": string — fact-rich bullet points for journalists. Each bullet starts with "• " and states one specific new fact (who, what, where, when, numbers/figures). 3-6 bullets separated by newlines. No narrative prose, no URLs or citations — just verifiable facts.
- "sources": array of objects with "title", "url", and optionally "publishedDate" and "isPrimary" (true for government/military/wire service sources)`;

  const { text, steps } = await generateText({
    model: openai("gpt-5.4"),
    system: systemPrompt,
    prompt: `Find the latest development about: "${storyTitle}". Search broadly — news sites, X/Twitter, government sources, press releases, expert analysis. Try at least 5 different search queries with different phrasings before giving up.`,
    tools: {
      newsSearch: webSearch({
        numResults: 10,
        startPublishedDate: threeHoursAgo,
        category: "news",
      }),
      webSearch: webSearch({
        numResults: 10,
        startPublishedDate: threeHoursAgo,
      }),
    },
    stopWhen: stepCountIs(10),
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
      const content = step.content as
        | { type: string; toolName?: string; result?: unknown }[]
        | undefined;
      if (content) {
        for (const part of content) {
          if (part.type === "tool-result") {
            if ((part as Record<string, unknown>).isError) {
              console.error(
                `[Pulse Cron]   Tool ERROR:`,
                JSON.stringify(part.result, null, 2),
              );
            } else if (part.result) {
              const r = part.result as {
                results?: { title: string; url: string }[];
              };
              if (r?.results) {
                console.log(
                  `[Pulse Cron]   Found ${r.results.length} results:`,
                );
                r.results.forEach((s) =>
                  console.log(`[Pulse Cron]     - ${s.title}`),
                );
              }
            }
          }
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
      const timeline = await getTimeline(story.id);
      await upsertStory({ ...story, lastUpdated: new Date().toISOString(), description: `${timeline.length} updates` });
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
