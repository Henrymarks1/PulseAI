import { Redis } from "@upstash/redis";
import { TrackedStory, TimelineEntry } from "./types";

const redis = Redis.fromEnv();

const STORIES_KEY = "pulse:stories";
function timelineKey(storyId: string) {
  return `pulse:timeline:${storyId}`;
}

// --- Stories ---

export async function getStories(): Promise<TrackedStory[]> {
  const data = await redis.get<TrackedStory[]>(STORIES_KEY);
  return data || [];
}

export async function saveStories(stories: TrackedStory[]) {
  await redis.set(STORIES_KEY, stories);
}

export async function getStory(id: string): Promise<TrackedStory | undefined> {
  const stories = await getStories();
  return stories.find((s) => s.id === id);
}

export async function upsertStory(story: TrackedStory) {
  const stories = await getStories();
  const idx = stories.findIndex((s) => s.id === story.id);
  if (idx >= 0) {
    stories[idx] = story;
  } else {
    stories.unshift(story);
  }
  await saveStories(stories);
}

export async function deleteStory(id: string) {
  await saveStories((await getStories()).filter((s) => s.id !== id));
  await redis.del(timelineKey(id));
}

// --- Timelines ---

export async function getTimeline(storyId: string): Promise<TimelineEntry[]> {
  const data = await redis.get<TimelineEntry[]>(timelineKey(storyId));
  return data || [];
}

export async function saveTimeline(storyId: string, entries: TimelineEntry[]) {
  await redis.set(timelineKey(storyId), entries);
}

export async function addTimelineEntry(
  storyId: string,
  entry: TimelineEntry
): Promise<TimelineEntry[]> {
  const entries = await getTimeline(storyId);
  entries.unshift(entry);
  await saveTimeline(storyId, entries);
  return entries;
}

// --- Locks ---

function lockKey(storyId: string) {
  return `pulse:lock:${storyId}`;
}

/** Try to acquire an update lock. Returns true if acquired, false if already held. */
export async function acquireUpdateLock(storyId: string, ttlSeconds = 300): Promise<boolean> {
  const result = await redis.set(lockKey(storyId), Date.now(), { nx: true, ex: ttlSeconds });
  return result === "OK";
}

export async function releaseUpdateLock(storyId: string): Promise<void> {
  await redis.del(lockKey(storyId));
}

// --- Known URLs ---

export async function getKnownUrls(storyId: string): Promise<Set<string>> {
  const entries = await getTimeline(storyId);
  const urls = new Set<string>();
  entries.forEach((e) => e.sources.forEach((s) => urls.add(s.url)));
  return urls;
}
