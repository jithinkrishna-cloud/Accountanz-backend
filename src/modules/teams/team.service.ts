import { withTransaction } from "../../database/connection.js";
import type { AuthUser } from "../../types/auth.types.js";
import { AppError } from "../../utils/app-error.js";
import { recordAudit } from "../audit/audit.service.js";
import { findClientById } from "../clients/client.repository.js";
import * as repo from "./team.repository.js";
import type { CreateTeamInput, TeamListQuery } from "./team.validation.js";

/**
 * A team is created explicitly, one per client. Its members are not stored: they are whoever holds
 * an assignment on the client that is active today.
 */
export const listTeams = (q: TeamListQuery) => repo.listTeams(q);
export const listClientsWithoutTeam = () => repo.listClientsWithoutTeam();

export async function createTeam(actor: AuthUser, input: CreateTeamInput) {
  const client = await findClientById(input.client_id);
  if (!client) throw AppError.notFound("Client");
  if (client.status === "exited") throw new AppError("VALIDATION_ERROR", "Exited clients can't get a team");
  if (await repo.findTeamByClient(input.client_id)) throw AppError.conflict("This client already has a team");

  const name = input.name ?? `${client.trade_name ?? client.legal_name} Team`.slice(0, 150);
  const id = await withTransaction(async (conn) => {
    const teamId = await repo.insertTeam(input.client_id, name, conn);
    await recordAudit(actor, { action: "Team created", entityType: "Team", entityId: teamId, clientId: input.client_id, details: name }, conn);
    return teamId;
  });
  return { team_id: id, client_id: input.client_id, team_name: name };
}

export async function renameTeam(actor: AuthUser, clientId: number, name: string) {
  const team = await repo.findTeamByClient(clientId);
  if (!team) throw AppError.notFound("Team");
  if (team.name !== name) {
    await withTransaction(async (conn) => {
      await repo.renameTeam(clientId, name, conn);
      await recordAudit(actor, { action: "Team renamed", entityType: "Team", entityId: team.id, clientId, details: `${team.name} → ${name}` }, conn);
    });
  }
  return { client_id: clientId, team_name: name };
}
