import { apiGet, apiPost } from './client';

export interface TimelineEntry {
  startTime: string;
  endTime: string;
  application: string;
  category: string;
  description: string;
}

export interface TimelineResponse {
  date: string;
  entries: TimelineEntry[];
  summary: Record<string, string>;
  tracking: boolean;
}

export interface TimelineDatesResponse {
  dates: string[];
}

export interface TimelineToggleResponse {
  enabled: boolean;
  jobId: string;
}

export async function fetchTimeline(date?: string): Promise<TimelineResponse> {
  const params = date ? { date } : undefined;
  return apiGet<TimelineResponse>('/api/timeline', params);
}

export async function fetchTimelineDates(): Promise<TimelineDatesResponse> {
  return apiGet<TimelineDatesResponse>('/api/timeline/dates');
}

export async function toggleTracking(): Promise<TimelineToggleResponse> {
  return apiPost<TimelineToggleResponse>('/api/timeline/toggle');
}
