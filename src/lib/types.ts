export interface TrackedStory {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  lastUpdated: string;
  refreshInterval: number; // minutes
}

export interface SearchResult {
  title: string;
  url: string;
  publishedDate: string | null;
  author: string | null;
  text: string;
  isPrimary?: boolean;
}

export interface TimelineEntry {
  id: string;
  timestamp: string;
  summary: string;
  newSources: SearchResult[];
  totalSourceCount: number;
}
