export const RECURRENCES = ["monthly", "quarterly", "annual"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export interface TaskTemplateRow {
  id: number;
  service_id: number;
  service_name: string;
  name: string;
  recurrence: Recurrence;
  due_day_of_period: number;
}

export interface TaskTemplateItemRow {
  id: number;
  template_id: number;
  title: string;
  checklist: string[];
  client_visible: boolean;
  sort_order: number;
}

export interface TaskTemplateWithItems extends TaskTemplateRow {
  items: TaskTemplateItemRow[];
}
