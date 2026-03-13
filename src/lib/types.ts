export interface TrackedStory {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  lastUpdated: string;
  refreshInterval: number; // minutes
}

export interface Source {
  title: string;
  url: string;
  publishedDate?: string;
  isPrimary?: boolean;
}

export interface ResearchUpdate {
  headline: string;
  summary: string;
  sources: Source[];
}

export interface TimelineEntry {
  id: string;
  timestamp: string;
  headline: string;
  summary: string;
  sources: Source[];
}
