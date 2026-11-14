import { withTransaction } from "../../database/connection.js";
import { AppError } from "../../utils/app-error.js";
import { requireScrum, requireSpaceAdmin } from "../projects/project-access.js";
import type { SpaceContext } from "../projects/project.types.js";
import * as repo from "./sprint.repository.js";
import type { UpdateSprintInput } from "./sprint.validation.js";

export const listSprints = (space: SpaceContext, includeCompleted: boolean) => repo.listSprints(space.id, includeCompleted);

/** A blank name becomes "<KEY> Sprint <n>". */
export async function createSprint(space: SpaceContext, input: UpdateSprintInput) {
  requireScrum(space);
  requireSpaceAdmin(space);
  const name = input.name || `${space.key} Sprint ${(await repo.countSprints(space.id)) + 1}`;
  const id = await repo.insertSprint(space.id, { name, goal: input.goal ?? null, start_date: input.start_date ?? null, end_date: input.end_date ?? null });
  return (await repo.findSprint(space.id, id))!;
}

export async function updateSprint(space: SpaceContext, id: number, input: UpdateSprintInput) {
  requireScrum(space);
  requireSpaceAdmin(space);
  const sprint = await repo.findSprint(space.id, id);
  if (!sprint) throw AppError.notFound("Sprint");
  if (sprint.status === "completed") throw AppError.conflict("A completed sprint cannot be changed");
  await repo.updateSprint(space.id, id, input);
  return (await repo.findSprint(space.id, id))!;
}

export async function startSprint(space: SpaceContext, id: number) {
  requireScrum(space);
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const sprint = await repo.lockSprint(space.id, id, conn);
    if (!sprint) throw AppError.notFound("Sprint");
    if (sprint.status !== "planned") throw AppError.conflict("Only a planned sprint can be started");
    if (!sprint.start_date || !sprint.end_date) throw AppError.conflict("Set the sprint's start and end dates before starting it");
    const active = await repo.activeSprintId(space.id, conn);
    if (active) throw AppError.conflict("Complete the active sprint before starting another");
    await repo.startSprint(id, conn);
  });
  return (await repo.findSprint(space.id, id))!;
}

export async function completeSprint(space: SpaceContext, id: number, moveTo: number | null) {
  requireScrum(space);
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const sprint = await repo.lockSprint(space.id, id, conn);
    if (!sprint) throw AppError.notFound("Sprint");
    if (sprint.status !== "active") throw AppError.conflict("Only the active sprint can be completed");
    if (moveTo !== null) {
      const target = await repo.lockSprint(space.id, moveTo, conn);
      if (!target || target.status !== "planned") throw AppError.conflict("Unfinished items can only move to the backlog or a planned sprint");
    }
    await repo.completeSprint(space.id, id, moveTo, conn);
  });
  return (await repo.findSprint(space.id, id))!;
}

export async function deleteSprint(space: SpaceContext, id: number) {
  requireScrum(space);
  requireSpaceAdmin(space);
  await withTransaction(async (conn) => {
    const sprint = await repo.lockSprint(space.id, id, conn);
    if (!sprint) throw AppError.notFound("Sprint");
    if (sprint.status !== "planned") throw AppError.conflict("Only a planned sprint can be deleted; its items return to the backlog");
    await repo.deleteSprint(space.id, id, conn);
  });
}
