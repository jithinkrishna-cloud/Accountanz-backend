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
  /** Times the viewer is @mentioned in this thread (lists only). */
  mentions_me?: number;
}

export interface MessageRow {
  id: number;
  body: string;
  created_at: string;
  author: string | null;
  author_id: number | null;
  from_client: 0 | 1;
  mentions: { user_id: number; full_name: string }[] | null;
}

export const MEETING_REQUEST_STATUSES = ["pending", "scheduled", "declined", "withdrawn"] as const;
export type MeetingRequestStatus = (typeof MEETING_REQUEST_STATUSES)[number];

/** preferred_times: UTC ISO strings proposed by the client. */
export interface MeetingRequestRow {
  id: number;
  client_id: number;
  client_name: string;
  requested_by: number | null;
  requester: string | null;
  topic: string;
  notes: string | null;
  preferred_times: string[];
  duration_minutes: number;
  status: MeetingRequestStatus;
  meeting_id: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decline_reason: string | null;
  created_at: string;
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
