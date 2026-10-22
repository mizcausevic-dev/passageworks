import type { Action, Role } from "../../../packages/domain/src/index.ts";
import { can, isRole } from "../../../packages/domain/src/index.ts";
import type { Ctx, SessionUser } from "./ctx.ts";
import { HttpError } from "./errors.ts";

export type ProjectAccess = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  role: Role;
};

export async function requireUser(user: SessionUser | null): Promise<SessionUser> {
  if (!user) throw new HttpError(401, "unauthenticated", "Sign in to continue");
  return user;
}

export async function requireProject(ctx: Ctx, userId: string, projectId: string, action: Action): Promise<ProjectAccess> {
  const rows = await ctx.db.query<{
    id: string;
    workspace_id: string;
    name: string;
    description: string;
    role: string;
  }>(
    `SELECT p.id, p.workspace_id, p.name, p.description, m.role
     FROM projects p
     JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
     WHERE p.id = $1 AND p.deleted_at IS NULL`,
    [projectId, userId],
  );
  const row = rows[0];
  if (!row || !isRole(row.role) || !can(row.role, action)) {
    if (!row || !isRole(row.role)) throw new HttpError(404, "not_found", "Project not found");
    throw new HttpError(403, "forbidden", "Your role does not allow that");
  }
  return { ...row, role: row.role };
}

export async function requireWorkspace(ctx: Ctx, userId: string, workspaceId: string, action: Action): Promise<Role> {
  const rows = await ctx.db.query<{ role: string }>(
    `SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new HttpError(404, "not_found", "Workspace not found");
  if (!can(role, action)) throw new HttpError(403, "forbidden", "Your role does not allow that");
  return role;
}

export async function ownerCount(ctx: Ctx, workspaceId: string): Promise<number> {
  const rows = await ctx.db.query<{ count: string | number }>(
    `SELECT count(*)::int AS count FROM memberships WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return Number(rows[0]?.count ?? 0);
}
