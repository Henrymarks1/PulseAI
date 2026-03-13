import { NextRequest, NextResponse } from "next/server";
import {
  getStories,
  upsertStory,
  deleteStory,
  getTimeline,
  getKnownUrls,
} from "@/lib/store";
import { TrackedStory } from "@/lib/types";

// GET all stories, or a single story + timeline via ?id=xxx
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");

  if (id) {
    const stories = getStories();
    const story = stories.find((s) => s.id === id);
    if (!story) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }
    const timeline = getTimeline(id);
    const knownUrls = Array.from(getKnownUrls(id));
    return NextResponse.json({ story, timeline, knownUrls });
  }

  return NextResponse.json({ stories: getStories() });
}

// POST — create or update a story
export async function POST(req: NextRequest) {
  const body = await req.json();
  const story: TrackedStory = {
    id: body.id || Date.now().toString(36),
    title: body.title,
    description: body.description || "Tracking this story...",
    createdAt: body.createdAt || new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    refreshInterval: body.refreshInterval || 30,
  };
  upsertStory(story);
  return NextResponse.json({ story });
}

// DELETE — remove a story
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  deleteStory(id);
  return NextResponse.json({ ok: true });
}
