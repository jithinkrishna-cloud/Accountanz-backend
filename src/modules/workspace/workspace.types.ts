export interface WorkspaceTask {
  id: number;
  title: string;
  client_id: number;
  client_name: string;
  period: string;
  status: string;
  due_date: string | null;
  overdue: 0 | 1;
}

export interface MyClientRow {
  id: number;
  name: string;
  legal_name: string;
  status: string;
  roles: string;
  package_name: string | null;
  open_tasks: number;
  overdue_tasks: number;
  open_requests: number;
  awaiting_reply: number;
  closing_status: "open" | "ready" | "closed";
}

