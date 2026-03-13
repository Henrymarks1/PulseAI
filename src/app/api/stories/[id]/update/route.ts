import { NextRequest, NextResponse } from "next/server";
import Exa from "exa-js";
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { webSearch } from "@exalabs/ai-sdk";
import {
  getStory,
  upsertStory,
  getTimeline,
  addTimelineEntry,
} from "@/lib/store";
import { TimelineEntry } from "@/lib/types";
import { z } from "zod";

const exa = new Exa(process.env.EXA_API_KEY);

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
        "A fact-rich bullet-point briefing for journalists. Each bullet starts with '• ' and states one specific, verifiable fact (who, what, where, when, numbers/figures). Include 6-10 bullets covering key events, major players, and current status. Separate bullets with newlines. No narrative prose — just the facts.",
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

  const recent = timeline
    .filter((e) => e.headline !== "No new developments")
    .slice(0, 10);
  if (recent.length === 0) return "";
  const context = recent
    .map((e) => `- ${e.headline}: ${e.summary.split("\n\n")[0]}`)
    .join("\n");

  return `\nHere is what we already know and have reported. Do NOT repeat any of this information:\n${context}`;
}

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
      "Fact-rich bullet points for journalists. Each bullet starts with '• ' and states one specific new fact (who, what, where, when, numbers). 3-6 bullets. No narrative prose — just the verifiable facts. Separate bullets with newlines."
    ),
  sources: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      publishedDate: z.string().optional(),
      isPrimary: z.boolean().optional(),
    })
  ),
});

async function runAgentUpdate(
  storyTitle: string,
  timeline: TimelineEntry[]
): Promise<z.infer<typeof updateResponseSchema>> {
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
- "headline": string — specific, concrete headline (e.g. "Pentagon confirms second wave of strikes on Iranian air defenses")
- "summary": string — fact-rich bullet points for journalists. Each bullet starts with "• " and states one specific new fact (who, what, where, when, numbers/figures). 3-6 bullets separated by newlines. No narrative prose, no URLs or citations — just verifiable facts.
- "sources": array of objects with "title", "url", and optionally "publishedDate" and "isPrimary" (true for government/military/wire service sources)`;

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
      console.log(`[Pulse Agent] Step ${step.stepNumber}`);
      const toolCalls = step.toolCalls as
        | { toolName: string; input?: Record<string, unknown> }[]
        | undefined;
      if (toolCalls?.length) {
        for (const call of toolCalls) {
          console.log(
            `[Pulse Agent]   Tool: ${call.toolName}`,
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
                `[Pulse Agent]   Tool ERROR:`,
                JSON.stringify(part.result, null, 2)
              );
            } else if (part.result) {
              const r = part.result as {
                results?: { title: string; url: string }[];
              };
              if (r?.results) {
                console.log(
                  `[Pulse Agent]   Found ${r.results.length} results:`
                );
                r.results.forEach((s) =>
                  console.log(`[Pulse Agent]     - ${s.title}`)
                );
              }
            }
          }
        }
      }
      if (step.text) {
        console.log(
          `[Pulse Agent]   Response: ${(step.text as string).slice(0, 200)}...`
        );
      }
      if (!toolCalls?.length && !step.text) {
        console.log(`[Pulse Agent]   Raw step:`, JSON.stringify(step, null, 2).slice(0, 500));
      }
    },
  });

  console.log(`[Pulse Agent] Completed in ${steps.length} steps`);

  // Parse the JSON response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Agent did not return valid JSON");
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return updateResponseSchema.parse(parsed);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const story = await getStory(id);
  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  try {
    const timeline = await getTimeline(id);
    const isInitial = timeline.length === 0;

    let entry: TimelineEntry;

    if (isInitial) {
      // Use Exa Research agent for the initial summary
      const instructions = `You are a newsroom researcher briefing journalists. Research the current state of this story: "${story.title}"

Write a fact-rich bullet-point briefing. Each bullet starts with "• " and states one specific, verifiable fact — who did what, where, when, with what numbers or figures. Include 6-10 bullets covering key events, major players, and current status.

No narrative prose. No analysis or opinion. Just the facts a journalist needs to write their own story.

Use a wide range of sources: major newspapers (NYT, WSJ, Washington Post), wire services (AP, Reuters, AFP), broadcasters (CNN, BBC, Al Jazeera), government/official sources, and any other credible news outlets.
Do NOT embed citations, URLs, or source references in the summary text. The sources field is separate.`;

      console.log("[Pulse] Running Exa Research for initial summary");
      const task = await exa.research.create({
        instructions,
        model: "exa-research",
        outputSchema: INITIAL_SCHEMA,
      });
      const result = await exa.research.pollUntilFinished(task.researchId, {
        pollInterval: 2000,
        timeoutMs: 300000,
      });

      if (!result || result.status !== "completed" || !result.output) {
        return NextResponse.json(
          { error: "Research failed" },
          { status: 500 }
        );
      }

      const parsed =
        result.output.parsed || JSON.parse(result.output.content);

      entry = {
        id: Date.now().toString(36),
        timestamp: new Date().toISOString(),
        headline: parsed.headline,
        summary: parsed.summary,
        sources: parsed.sources,
      };
    } else {
      // Use custom GPT-5.4 agent with Exa web search for updates
      console.log("[Pulse] Running GPT-5.4 agent for update");
      const parsed = await runAgentUpdate(story.title, timeline);

      if (!parsed.hasNewDevelopments) {
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
    }

    await addTimelineEntry(id, entry);
    await upsertStory({
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
