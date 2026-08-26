import type { Generated } from "kysely";

import type { ReportResourcePolicy } from "@yaaps/contracts";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type DraftStatus = "disabled" | "enabled";

export interface UsersTable {
  created_at: string;
  disabled_at: string | null;
  display_name: string;
  id: string;
  role: UserRole;
  status: UserStatus;
  webauthn_user_id: Uint8Array | null;
}

export interface WebauthnCredentialsTable {
  backed_up: number;
  counter: number;
  created_at: string;
  credential_id: Uint8Array;
  device_type: string;
  id: string;
  last_used_at: string | null;
  public_key: Uint8Array;
  transports_json: string;
  user_id: string;
}

export interface InvitationsTable {
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  code_hash: string;
  created_at: string;
  expires_at: string;
  id: string;
  invited_by_user_id: string;
  revoked_at: string | null;
  role: UserRole;
}

export interface SessionsTable {
  created_at: string;
  csrf_token_hash: string;
  expires_at: string;
  id_hash: string;
  last_seen_at: string;
  revoked_at: string | null;
  user_id: string;
}

export type WebauthnCeremony =
  "add_credential" | "authenticate" | "bootstrap" | "invitation";

export interface WebauthnChallengesTable {
  ceremony: WebauthnCeremony;
  challenge_hash: string;
  consumed_at: string | null;
  created_at: string;
  expires_at: string;
  id: string;
  invitation_id: string | null;
  pending_display_name: string | null;
  pending_webauthn_user_id: Uint8Array | null;
  user_id: string | null;
}

export interface RecoveryCodesTable {
  code_hash: string;
  created_at: string;
  id: string;
  used_at: string | null;
  user_id: string;
}

export interface ApiKeysTable {
  created_at: string;
  id: string;
  key_hash: string;
  key_prefix: string;
  label: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: string;
}

export type DeviceConnectionStatus = "approved" | "denied" | "pending";

export interface DeviceConnectionsTable {
  api_key_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
  device_secret_hash: string;
  expires_at: string;
  id: string;
  key_hash: string;
  key_prefix: string;
  label: string;
  status: DeviceConnectionStatus;
  user_code_hash: string;
}

export interface DraftsTable {
  category: string | null;
  created_at: string;
  expires_at: string;
  id: string;
  latest_version_number: number;
  owner_id: string;
  status: DraftStatus;
  title: string | null;
  updated_at: string;
}

export interface VersionsTable {
  blob_key: string;
  byte_length: number;
  created_at: string;
  draft_id: string;
  id: string;
  resource_policy: ReportResourcePolicy;
  sha256: string;
  uploaded_by_api_key_id: string | null;
  version_number: number;
}

export interface AuditEventsTable {
  action: string;
  actor_api_key_id: string | null;
  actor_user_id: string | null;
  created_at: string;
  id: Generated<number>;
  metadata_json: string;
  target_id: string | null;
  target_type: string;
}

export interface DatabaseSchema {
  api_keys: ApiKeysTable;
  audit_events: AuditEventsTable;
  device_connections: DeviceConnectionsTable;
  drafts: DraftsTable;
  invitations: InvitationsTable;
  recovery_codes: RecoveryCodesTable;
  sessions: SessionsTable;
  users: UsersTable;
  versions: VersionsTable;
  webauthn_credentials: WebauthnCredentialsTable;
  webauthn_challenges: WebauthnChallengesTable;
}
