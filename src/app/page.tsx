"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { TrackedStory } from "@/lib/types";

export default function Home() {
  const [stories, setStories] = useState<TrackedStory[]>([]);
  const [input, setInput] = useState("");
  const [storiesLoaded, setStoriesLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchStories = async () => {
    const res = await fetch("/api/stories");
    const data = await res.json();
    setStories(data.stories || []);
    setStoriesLoaded(true);
  };

  useEffect(() => {
    fetchStories();
  }, []);

  const addStory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setAdding(true);

    try {
      await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: input.trim() }),
      });

      setInput("");
      await fetchStories();
    } finally {
      setAdding(false);
    }
  };

  const removeStory = async (id: string) => {
    setRemovingId(id);
    try {
      await fetch(`/api/stories?id=${id}`, { method: "DELETE" });
      await fetchStories();
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <header className="mb-12 text-center">
        <h1 className="text-5xl font-bold tracking-tight text-pulse-black mb-2">
          Pulse
        </h1>
        <p className="text-pulse-gray text-lg">
          Track fast-moving stories in real time
        </p>
      </header>

      <form onSubmit={addStory} className="mb-12">
        <div className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter a story or topic to track..."
            className="flex-1 px-4 py-3 border border-pulse-border rounded-lg bg-white text-pulse-black placeholder-pulse-gray focus:outline-none focus:border-pulse-blue focus:ring-1 focus:ring-pulse-blue text-base"
          />
          <button
            type="submit"
            disabled={adding}
            className="px-6 py-3 bg-pulse-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {adding && (
              <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
            {adding ? "Tracking..." : "Track"}
          </button>
        </div>
      </form>

      {!storiesLoaded ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-pulse-border rounded-lg p-5"
            >
              <div className="h-6 w-64 bg-pulse-border/60 rounded animate-pulse mb-2" />
              <div className="h-4 w-32 bg-pulse-border/40 rounded animate-pulse mb-2" />
              <div className="h-3 w-44 bg-pulse-border/30 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : stories.length === 0 ? (
        <div className="text-center py-16 text-pulse-gray">
          <p className="text-lg mb-1">No stories tracked yet</p>
          <p className="text-sm">
            Enter a topic above to start monitoring coverage
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {stories.map((story) => (
            <div
              key={story.id}
              className="bg-white border border-pulse-border rounded-lg p-5 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between gap-4">
                <Link href={`/story/${story.id}`} className="flex-1 group">
                  <h2 className="text-xl font-semibold group-hover:text-pulse-blue transition-colors">
                    {story.title}
                  </h2>
                  <p className="text-pulse-gray text-sm mt-1">
                    {story.description}
                  </p>
                  <p className="text-xs text-pulse-gray mt-2">
                    Last updated{" "}
                    {new Date(story.lastUpdated).toLocaleString()}
                  </p>
                </Link>
                <button
                  onClick={() => removeStory(story.id)}
                  disabled={removingId === story.id}
                  className="text-pulse-gray hover:text-pulse-accent text-sm shrink-0 mt-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Stop tracking"
                >
                  {removingId === story.id ? "Removing..." : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
