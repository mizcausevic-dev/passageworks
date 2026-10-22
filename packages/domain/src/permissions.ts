export const ROLES = ["owner", "editor", "commenter", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "members.manage",
  "workspace.delete",
  "project.create",
  "project.edit",
  "project.delete",
  "source.add",
  "source.delete",
  "source.purge",
  "source.file",
  "annotate",
  "annotation.moderate",
  "document.edit",
  "comment",
  "share.manage",
  "job.manage",
  "view",
] as const;

export type Action = (typeof ACTIONS)[number];

const MATRIX: Record<Action, readonly Role[]> = {
  "members.manage": ["owner"],
  "workspace.delete": ["owner"],
  "project.create": ["owner", "editor"],
  "project.edit": ["owner", "editor"],
  "project.delete": ["owner"],
  "source.add": ["owner", "editor"],
  "source.delete": ["owner", "editor"],
  "source.purge": ["owner"],
  "source.file": ["owner", "editor"],
  "annotate": ["owner", "editor", "commenter"],
  "annotation.moderate": ["owner", "editor"],
  "document.edit": ["owner", "editor"],
  "comment": ["owner", "editor", "commenter"],
  "share.manage": ["owner", "editor"],
  "job.manage": ["owner", "editor"],
  view: ["owner", "editor", "commenter", "viewer"],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}

export function permissionMatrix(): Record<Action, readonly Role[]> {
  return MATRIX;
}

export const COLLABORATION = {
  mode: "optimistic_concurrency",
  realtime: "unavailable",
  summary:
    "Saves carry a base revision. If that revision is no longer current, the save is rejected and the server copy is returned. Polling job status and autosave are not simultaneous real-time editing.",
} as const;

export const SHARE_RULES = {
  defaultVisibility: "private",
  linkDefault: "brief_only",
  citedPassages:
    "A share link includes cited passage text only when exposeCitedPassages was set at creation. Otherwise the brief is rewritten without passage identifiers. A link never grants search, file download, or access to the rest of a source.",
} as const;
