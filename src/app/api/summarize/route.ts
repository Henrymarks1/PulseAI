import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const { storyTitle, articles } = await req.json();

    if (!articles || articles.length === 0) {
      return NextResponse.json({ summary: "No articles found to summarize." });
    }

    // Sort primary sources first so the model prioritizes them
    const sorted = [...articles].sort(
      (a: { isPrimary?: boolean }, b: { isPrimary?: boolean }) =>
        (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)
    );

    const articleSummaries = sorted
      .slice(0, 8)
      .map(
        (a: { title: string; text: string; url: string; isPrimary?: boolean }, i: number) =>
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
- Lead with the most concrete, specific new fact (e.g. "A U.S. KC-135 refueling aircraft crashed in Iraq" not "The conflict has escalated")
- Write 2-4 short paragraphs, like a wire service dispatch
- Include specific details: names, places, numbers, direct quotes when available
- Attribute information to its original source (e.g. "Central Command said", "the White House stated", "according to a Pentagon spokesperson")
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

    return NextResponse.json({ summary });
  } catch (error: unknown) {
    console.error("OpenAI summarize error:", error);
    const message =
      error instanceof Error ? error.message : "Summarization failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
