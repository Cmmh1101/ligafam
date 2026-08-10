// Stable exception codes raised by the SECURITY DEFINER functions in
// supabase/migrations/0003_team_join_functions.sql and
// 0005_admin_invites.sql. Postgres surfaces these as the `message` on a
// PostgrestError; map them to i18n keys so a raw exception string never
// reaches the UI.
const RPC_ERROR_KEYS: Record<string, string> = {
  NOT_AUTHENTICATED: "errors.notAuthenticated",
  NOT_AUTHORIZED: "errors.notAuthorized",
  ADMIN_NOT_ALLOWED_VIA_JOIN: "errors.adminNotAllowedViaJoin",
  INVALID_INVITE_CODE: "errors.invalidInviteCode",
  ALREADY_MEMBER: "errors.alreadyMember",
  REQUEST_ALREADY_PENDING: "errors.requestAlreadyPending",
  FAMILY_REQUIRES_PLAYER_SELECTION: "errors.familyRequiresPlayerSelection",
  INVALID_PLAYER_SELECTION: "errors.invalidPlayerSelection",
  REQUEST_NOT_FOUND: "errors.requestNotFound",
  REQUEST_NOT_PENDING: "errors.requestNotPending",
  GAME_NOT_FOUND: "errors.gameNotFound",
  TEAM_ADMIN_LIMIT_REACHED: "errors.teamAdminLimitReached",
  INVITE_NOT_FOUND: "errors.inviteNotFound",
  INVITE_NOT_PENDING: "errors.inviteNotPending",
  INVITE_EMAIL_MISMATCH: "errors.inviteEmailMismatch"
};

export function rpcErrorKey(message: string | undefined | null): string {
  if (!message) return "errors.generic";
  const code = Object.keys(RPC_ERROR_KEYS).find((c) => message.includes(c));
  return code ? RPC_ERROR_KEYS[code] : "errors.generic";
}
