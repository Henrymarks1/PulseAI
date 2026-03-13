"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TrackedStory, TimelineEntry } from "@/lib/types";

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Strip inline citations that the research agent sometimes embeds
function cleanSummary(text: string): string {
  return text
    // [Source](url) markdown links
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, "$1")
    // [Source] (url) with space
    .replace(/\[([^\]]*)\]\s*\(https?:\/\/[^)]+\)/g, "$1")
    // Bare [Source](url) where source is a name
    .replace(/\[([A-Z][^\]]*)\]/g, "$1")
    // Remaining bare URLs in parentheses
    .replace(/\(https?:\/\/[^)]+\)/g, "")
    // Bare URLs left in text
    .replace(/https?:\/\/\S+/g, "")
    // Clean up double spaces and trailing punctuation issues
    .replace(/\s{2,}/g, " ")
    .trim();
}

export default function StoryDashboard() {
  const params = useParams();
  const id = params.id as string;

  const [story, setStory] = useState<TrackedStory | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasFetchedInitial = useRef(false);

  const loadData = useCallback(async () => {
    const res = await fetch(`/api/stories?id=${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setStory(data.story);
    setTimeline(data.timeline || []);
    setRefreshInterval(data.story.refreshInterval);
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const checkForUpdates = useCallback(async () => {
    if (!story || loading) return;
    setLoading(true);

    try {
      await fetch(`/api/stories/${id}/update`, { method: "POST" });
      await loadData();
    } catch (err) {
      console.error("Fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [story, id, loadData, loading]);

  // Initial fetch — runs exactly once
  useEffect(() => {
    if (story && timeline.length === 0 && !hasFetchedInitial.current) {
      hasFetchedInitial.current = true;
      checkForUpdates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story]);

  // Auto-refresh when tab is open
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (story && refreshInterval > 0) {
      intervalRef.current = setInterval(
        () => checkForUpdates(),
        refreshInterval * 60 * 1000
      );
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshInterval, story, checkForUpdates]);

  const handleIntervalChange = async (mins: number) => {
    setRefreshInterval(mins);
    if (story) {
      await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...story, refreshInterval: mins }),
      });
    }
  };

  if (!story) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-pulse-gray">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Header */}
      <header className="mb-8">
        <Link
          href="/"
          className="text-sm text-pulse-gray hover:text-pulse-blue transition-colors"
        >
          &larr; Back to Pulse
        </Link>
        <div className="flex items-start justify-between gap-4 mt-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">{story.title}</h1>
            <p className="text-sm text-pulse-gray mt-1">
              Tracking since {formatDateTime(story.createdAt)} &middot;{" "}
              {timeline.length} updates
            </p>
          </div>
          <div className="shrink-0">
            <label className="text-xs text-pulse-gray block mb-1">
              Auto-refresh
            </label>
            <select
              value={refreshInterval}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              className="text-sm border border-pulse-border rounded px-2 py-1 bg-white"
            >
              <option value={15}>Every 15 min</option>
              <option value={30}>Every 30 min</option>
              <option value={60}>Every 1 hour</option>
            </select>
          </div>
        </div>
      </header>

      {/* Check for Updates */}
      <div className="mb-8">
        <button
          onClick={checkForUpdates}
          disabled={loading}
          className="px-5 py-2.5 bg-pulse-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading && (
            <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          )}
          {loading ? "Searching..." : "Check for Updates"}
        </button>
      </div>

      {/* Timeline */}
      <section>
        {timeline.length === 0 && !loading && (
          <p className="text-pulse-gray text-sm py-8 text-center">
            No updates yet. Click &quot;Check for Updates&quot; to start tracking.
          </p>
        )}

        {loading && timeline.length === 0 && (
          <div className="py-8 text-center text-pulse-gray text-sm">
            AI researcher is finding initial coverage...
          </div>
        )}

        <div className="relative">
          {timeline.length > 0 && (
            <div className="absolute left-[7px] top-2 bottom-0 w-px bg-pulse-border" />
          )}

          {timeline.map((entry) => (
            <div key={entry.id} className="relative pl-8 pb-10">
              {/* Timeline dot */}
              <div
                className={`absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 ${
                  entry.sources.length > 0
                    ? "bg-pulse-accent border-pulse-accent"
                    : "bg-white border-pulse-border"
                }`}
              />

              {/* Timestamp */}
              <div className="flex items-center gap-3 mb-2">
                <time className="text-sm font-bold text-pulse-accent">
                  {timeAgo(entry.timestamp)}
                </time>
                <span className="text-xs text-pulse-gray">
                  {formatTime(entry.timestamp)}
                </span>
              </div>

              {/* Headline */}
              <h3
                className="text-2xl font-bold leading-tight mb-3"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                {entry.headline}
              </h3>

              {/* Summary — multi-paragraph dispatch */}
              <div className="mb-4">
                {cleanSummary(entry.summary).split("\n\n").map((para, pi) => (
                  <p
                    key={pi}
                    className="text-lg leading-relaxed text-pulse-black mb-3 last:mb-0"
                    style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
                  >
                    {para}
                  </p>
                ))}
              </div>

              {/* Sources */}
              {entry.sources.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-pulse-gray uppercase tracking-wider">
                    Sources
                  </p>
                  {entry.sources.map((source, i) => (
                    <div
                      key={`${source.url}-${i}`}
                      className={`border-l-2 pl-3 py-0.5 ${
                        source.isPrimary
                          ? "border-pulse-accent"
                          : "border-pulse-border"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {source.isPrimary && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-pulse-accent text-white px-1.5 py-0.5 rounded">
                            Primary
                          </span>
                        )}
                        <span className="text-xs font-medium text-pulse-blue uppercase tracking-wide">
                          {extractDomain(source.url)}
                        </span>
                        {source.publishedDate && (
                          <span className="text-xs text-pulse-gray">
                            {formatDateTime(source.publishedDate)}
                          </span>
                        )}
                      </div>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:text-pulse-blue transition-colors"
                      >
                        {source.title}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
