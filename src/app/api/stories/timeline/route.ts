import { NextRequest, NextResponse } from "next/server";
import { addTimelineEntry } from "@/lib/store";
import { TimelineEntry } from "@/lib/types";

export async function POST(req: NextRequest) {
  const { storyId, entry }: { storyId: string; entry: TimelineEntry } =
    await req.json();

  if (!storyId || !entry) {
    return NextResponse.json(
      { error: "storyId and entry are required" },
      { status: 400 }
    );
  }

  const timeline = addTimelineEntry(storyId, entry);
  return NextResponse.json({ ok: true, count: timeline.length });
}
