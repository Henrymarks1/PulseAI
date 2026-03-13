"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { TrackedStory } from "@/lib/types";

export default function Home() {
  const [stories, setStories] = useState<TrackedStory[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("pulse-stories");
    if (saved) setStories(JSON.parse(saved));
  }, []);

  const saveStories = (updated: TrackedStory[]) => {
    setStories(updated);
    localStorage.setItem("pulse-stories", JSON.stringify(updated));
  };

  const addStory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const story: TrackedStory = {
      id: Date.now().toString(36),
      title: input.trim(),
      description: "Tracking this story...",
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      refreshInterval: 30,
    };

    saveStories([story, ...stories]);
    setInput("");
  };

  const removeStory = (id: string) => {
    saveStories(stories.filter((s) => s.id !== id));
    localStorage.removeItem(`pulse-results-${id}`);
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
            className="px-6 py-3 bg-pulse-black text-white rounded-lg font-medium hover:bg-gray-800 transition-colors"
          >
            Track
          </button>
        </div>
      </form>

      {stories.length === 0 ? (
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
                  className="text-pulse-gray hover:text-pulse-accent text-sm shrink-0 mt-1"
                  title="Stop tracking"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
