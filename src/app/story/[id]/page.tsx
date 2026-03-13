"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TrackedStory, SearchResult, TimelineEntry } from "@/lib/types";

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

export default function StoryDashboard() {
  const params = useParams();
  const id = params.id as string;

  const [story, setStory] = useState<TrackedStory | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [knownUrls, setKnownUrls] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load story + timeline from server
  const loadData = useCallback(async () => {
    const res = await fetch(`/api/stories?id=${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setStory(data.story);
    setTimeline(data.timeline || []);
    setRefreshInterval(data.story.refreshInterval);
    setKnownUrls(new Set(data.knownUrls || []));
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const checkForUpdates = useCallback(async () => {
    if (!story) return;
    setLoading(true);

    try {
      const lastTimestamp =
        timeline.length > 0 ? timeline[0].timestamp : undefined;

      const searchRes = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: story.title,
          numResults: 15,
          startPublishedDate: lastTimestamp,
        }),
      });
      const searchData = await searchRes.json();
      if (searchData.error) {
        console.error("Search error:", searchData.error);
        setLoading(false);
        return;
      }

      const allResults: SearchResult[] = searchData.results || [];
      const newSources = allResults.filter((r) => !knownUrls.has(r.url));

      if (newSources.length === 0 && timeline.length > 0) {
        const entry: TimelineEntry = {
          id: Date.now().toString(36),
          timestamp: new Date().toISOString(),
          summary: "No new developments found since the last check.",
          newSources: [],
          totalSourceCount: knownUrls.size,
        };
        // Save to server
        await fetch("/api/stories/timeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storyId: id, entry }),
        });
        await loadData();
        setLoading(false);
        return;
      }

      // Get AI summary
      const sumRes = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyTitle: story.title,
          articles: newSources.length > 0 ? newSources : allResults,
        }),
      });
      const sumData = await sumRes.json();

      const updatedKnownCount = knownUrls.size + newSources.length;

      const entry: TimelineEntry = {
        id: Date.now().toString(36),
        timestamp: new Date().toISOString(),
        summary: sumData.summary || "",
        newSources,
        totalSourceCount: updatedKnownCount,
      };

      // Save to server
      await fetch("/api/stories/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: id, entry }),
      });

      // Update story metadata
      await fetch("/api/stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...story,
          lastUpdated: new Date().toISOString(),
          description: `${updatedKnownCount} sources · ${timeline.length + 1} updates`,
        }),
      });

      await loadData();
    } catch (err) {
      console.error("Fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [story, timeline, knownUrls, id, loadData]);

  // Initial fetch if no timeline yet
  useEffect(() => {
    if (story && timeline.length === 0 && !loading) {
      checkForUpdates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story]);

  // Auto-refresh interval (still runs client-side when tab is open)
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
              {knownUrls.size} total sources
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
          className="px-5 py-2.5 bg-pulse-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Checking..." : "Check for Updates"}
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
            Searching for initial coverage...
          </div>
        )}

        <div className="relative">
          {/* Vertical timeline line */}
          {timeline.length > 0 && (
            <div className="absolute left-[7px] top-2 bottom-0 w-px bg-pulse-border" />
          )}

          {timeline.map((entry) => (
            <div key={entry.id} className="relative pl-8 pb-10">
              {/* Timeline dot */}
              <div
                className={`absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 ${
                  entry.newSources.length > 0
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
                {entry.newSources.length > 0 && (
                  <span className="text-xs font-medium text-pulse-blue">
                    {entry.newSources.length} new source
                    {entry.newSources.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* AI Summary — rendered as multi-paragraph dispatch */}
              <div className="bg-white border border-pulse-border rounded-lg p-5 mb-4">
                {entry.summary.split("\n\n").map((para, pi) => (
                  <p
                    key={pi}
                    className="text-lg leading-relaxed text-pulse-black mb-3 last:mb-0"
                    style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
                  >
                    {para}
                  </p>
                ))}
              </div>

              {/* New sources found in this update */}
              {entry.newSources.length > 0 && (
                <div className="space-y-3 ml-1">
                  {entry.newSources.map((source, i) => (
                    <div
                      key={`${source.url}-${i}`}
                      className={`border-l-2 pl-4 py-1 ${
                        source.isPrimary
                          ? "border-pulse-accent"
                          : "border-pulse-border"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {source.isPrimary && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-pulse-accent text-white px-1.5 py-0.5 rounded">
                            Primary Source
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
                      <h4 className="text-base font-semibold leading-snug">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-pulse-blue transition-colors"
                        >
                          {source.title}
                        </a>
                      </h4>
                      {source.text && (
                        <p className="text-sm text-pulse-gray leading-relaxed mt-1">
                          {source.text.slice(0, 200)}
                          {source.text.length > 200 ? "..." : ""}
                        </p>
                      )}
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-pulse-gray hover:text-pulse-blue mt-1 inline-block break-all"
                      >
                        {source.url}
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
