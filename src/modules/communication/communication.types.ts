export const THREAD_VISIBILITIES = ["client", "internal"] as const;
export type ThreadVisibility = (typeof THREAD_VISIBILITIES)[number];

export interface ThreadRow {
  id: number;
  client_id: number;
  client_name: string;
  subject: string | null;
  visibility: ThreadVisibility;
  created_at: string;
  messages: number;
  last_at: string | null;
  last_body: string | null;
  last_author: string | null;
  last_from_client: 0 | 1 | null;
}

export interface MessageRow {
  id: number;
  body: string;
  created_at: string;
  author: string | null;
  author_id: number | null;
  from_client: 0 | 1;
}

export interface MeetingRow {
  id: number;
  client_id: number;
  client_name: string;
  title: string;
  starts_at: string;
  ends_at: string;
  meeting_link: string | null;
  organiser_id: number | null;
  organiser: string | null;
  attendees: string | null;
}
