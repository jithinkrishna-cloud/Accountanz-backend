import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { notifyTaskReviewed } from "../notifications/notification.service.js";
import { canReviewTask } from "../tasks/task.service.js";
import * as repo from "./review.repository.js";
import type { ReviewDecisionInput } from "./review.validation.js";

export async function getReviewOverview() {
  const [queue, quality] = await Promise.all([repo.listReviewQueue(), repo.listAccountantQuality()]);
  return { queue, quality };
}

/** Accountant portal: the queue for clients where I review, excluding my own work. */
export const getStaffReviewQueue = (actor: AuthUser) => repo.listReviewQueue(actor.id);

/**
 * Approves or returns a submitted task. Only submitted work can be reviewed, only by an admin or
 * someone with a reviewer-type assignment on the client, and never by the person who did it.
 * The task row is locked so two reviewers can't decide it at once.
 */
export async function decideReview(actor: AuthUser, taskId: number, input: ReviewDecisionInput) {
  const submissionNumber = await withTransaction(async (conn) => {
    const task = await repo.findTaskForUpdate(taskId, conn);
    if (!task) throw AppError.notFound("Task");
    if (task.assignee_id === actor.id) throw AppError.forbidden("You can't review work you did yourself");
    if (!(await canReviewTask(actor, task))) throw AppError.forbidden("You aren't a reviewer on this client");
    if (task.status !== "submitted") throw AppError.conflict("This task is no longer waiting for review");

    const submissionNumber = await repo.nextSubmissionNumber(taskId, conn);
    await repo.insertReview({ taskId, reviewerId: actor.id, decision: input.decision, comments: input.comments, submissionNumber }, conn);
    await repo.setTaskDecision(taskId, input.decision, actor.id, conn);

    await recordAudit(
      actor,
      {
        action: input.decision === "approved" ? "Task approved" : "Task returned",
        entityType: "Task",
        entityId: taskId,
        clientId: task.client_id,
        details: input.decision === "approved" ? `${task.title} (${task.period})` : `${task.title} returned for correction${input.comments ? `: ${input.comments}` : ""}`,
      },
      conn,
    );
    return submissionNumber;
  });
  void notifyTaskReviewed(taskId, { decision: input.decision, comments: input.comments, submissionNumber, reviewerName: actor.fullName });
}
