import fs from "fs";
import path from "path";
import { TrackedStory, TimelineEntry } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const STORIES_FILE = path.join(DATA_DIR, "stories.json");
const TIMELINES_DIR = path.join(DATA_DIR, "timelines");

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TIMELINES_DIR))
    fs.mkdirSync(TIMELINES_DIR, { recursive: true });
}

// --- Stories ---

export function getStories(): TrackedStory[] {
  ensureDirs();
  if (!fs.existsSync(STORIES_FILE)) return [];
  return JSON.parse(fs.readFileSync(STORIES_FILE, "utf-8"));
}

export function saveStories(stories: TrackedStory[]) {
  ensureDirs();
  fs.writeFileSync(STORIES_FILE, JSON.stringify(stories, null, 2));
}

export function getStory(id: string): TrackedStory | undefined {
  return getStories().find((s) => s.id === id);
}

export function upsertStory(story: TrackedStory) {
  const stories = getStories();
  const idx = stories.findIndex((s) => s.id === story.id);
  if (idx >= 0) {
    stories[idx] = story;
  } else {
    stories.unshift(story);
  }
  saveStories(stories);
}

export function deleteStory(id: string) {
  saveStories(getStories().filter((s) => s.id !== id));
  const tlFile = path.join(TIMELINES_DIR, `${id}.json`);
  if (fs.existsSync(tlFile)) fs.unlinkSync(tlFile);
}

// --- Timelines ---

export function getTimeline(storyId: string): TimelineEntry[] {
  ensureDirs();
  const file = path.join(TIMELINES_DIR, `${storyId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export function saveTimeline(storyId: string, entries: TimelineEntry[]) {
  ensureDirs();
  const file = path.join(TIMELINES_DIR, `${storyId}.json`);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

export function addTimelineEntry(storyId: string, entry: TimelineEntry) {
  const entries = getTimeline(storyId);
  entries.unshift(entry);
  saveTimeline(storyId, entries);
  return entries;
}

// --- Known URLs ---

export function getKnownUrls(storyId: string): Set<string> {
  const entries = getTimeline(storyId);
  const urls = new Set<string>();
  entries.forEach((e) => e.sources.forEach((s) => urls.add(s.url)));
  return urls;
}
