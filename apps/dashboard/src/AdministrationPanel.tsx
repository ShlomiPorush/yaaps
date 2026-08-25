import type {
  AdminDraftSummary,
  AdminUserSummary,
  InvitationSummary,
  UserRole,
} from "@yaaps/contracts";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { DashboardApi, type CreatedInvitation } from "./dashboard-api.js";
import {
  formatDate as formatLocaleDate,
  type Locale,
  type LocaleDocument,
} from "./localization.js";

interface AdministrationPanelProps {
  copy: LocaleDocument;
  currentUserId: string;
  fetchImplementation: typeof fetch;
  locale: Locale;
}

export function AdministrationPanel({
  copy,
  currentUserId,
  fetchImplementation,
  locale,
}: AdministrationPanelProps) {
  const api = useMemo(
    () => new DashboardApi(fetchImplementation),
    [fetchImplementation],
  );
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [drafts, setDrafts] = useState<AdminDraftSummary[]>([]);
  const [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [role, setRole] = useState<UserRole>("user");
  const [createdInvitation, setCreatedInvitation] =
    useState<CreatedInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState<string | null>(null);
  const [confirmDeleteDraft, setConfirmDeleteDraft] = useState<string | null>(
    null,
  );

  const formatDate = (value: string) => formatLocaleDate(locale, value);

  async function refresh() {
    const [userResponse, invitationResponse, draftResponse] = await Promise.all(
      [api.listUsers(), api.listInvitations(), api.listAdminDrafts()],
    );
    setUsers(userResponse.items);
    setInvitations(invitationResponse.items);
    setDrafts(draftResponse.items);
  }

  useEffect(() => {
    let active = true;
    void refresh().catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [api]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError(false);
    try {
      await operation();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const invitation = await api.createInvitation(role, 24 * 60 * 60);
      setCreatedInvitation(invitation);
      await refresh();
    });
  }

  async function revokeInvitation(id: string) {
    await run(async () => {
      await api.revokeInvitation(id);
      await refresh();
    });
  }

  async function disableUser(id: string) {
    await run(async () => {
      await api.disableUser(id);
      setConfirmDisable(null);
      await refresh();
    });
  }

  async function enableUser(id: string) {
    await run(async () => {
      await api.enableUser(id);
      await refresh();
    });
  }

  async function toggleDraft(draft: AdminDraftSummary) {
    await run(async () => {
      const updated = await api.updateAdminDraft(
        draft.id,
        draft.status === "enabled" ? "disabled" : "enabled",
      );
      setDrafts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    });
  }

  async function deleteDraft(id: string) {
    await run(async () => {
      await api.deleteAdminDraft(id);
      setDrafts((current) => current.filter((draft) => draft.id !== id));
      setConfirmDeleteDraft(null);
    });
  }

  const invitationLink = createdInvitation
    ? `${window.location.origin}/login?invite=${encodeURIComponent(createdInvitation.token)}`
    : null;

  return (
    <section
      className="dashboard-view administration-section"
      aria-labelledby="administration-heading"
    >
      <section
        className="dashboard-heading"
        aria-labelledby="administration-heading"
      >
        <div>
          <p className="eyebrow">{copy.management.adminEyebrow}</p>
          <h1 id="administration-heading">{copy.management.adminHeading}</h1>
          <p className="intro">{copy.management.adminIntro}</p>
        </div>
      </section>
      {error && (
        <p className="error-banner" role="alert">
          {copy.management.adminError}
        </p>
      )}
      <div className="admin-grid">
        <article className="management-panel">
          <h2>{copy.management.inviteHeading}</h2>
          <form className="invite-form" onSubmit={createInvitation}>
            <label>
              <span>{copy.management.inviteRole}</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                <option value="user">{copy.management.roleUser}</option>
                <option value="admin">{copy.management.roleAdmin}</option>
              </select>
            </label>
            <button className="primary-button" disabled={busy} type="submit">
              {copy.management.createInvitation}
            </button>
          </form>
          {invitationLink && (
            <div className="one-time-key" role="status">
              <strong>{copy.management.invitationReady}</strong>
              <p>{copy.management.invitationWarning}</p>
              <code dir="ltr">{invitationLink}</code>
              <button
                className="text-button"
                type="button"
                onClick={() => setCreatedInvitation(null)}
              >
                {copy.management.savedInvitation}
              </button>
            </div>
          )}
          <div className="invitation-list">
            {invitations.map((invitation) => (
              <div className="admin-row" key={invitation.id}>
                <div>
                  <strong>
                    {invitation.role === "admin"
                      ? copy.management.roleAdmin
                      : copy.management.roleUser}
                  </strong>
                  <small>
                    {copy.management.expires} {formatDate(invitation.expiresAt)}
                  </small>
                </div>
                <span className={`state-badge ${invitation.status}`}>
                  {copy.management[invitation.status]}
                </span>
                {invitation.status === "pending" && (
                  <button
                    className="text-button danger-text"
                    disabled={busy}
                    type="button"
                    onClick={() => void revokeInvitation(invitation.id)}
                  >
                    {copy.management.revokeInvitation}
                  </button>
                )}
              </div>
            ))}
          </div>
        </article>

        <article className="management-panel">
          <h2>{copy.management.usersHeading}</h2>
          <div className="user-list">
            {users.map((user) => (
              <div className="admin-row user-row" key={user.id}>
                <div>
                  <strong>{user.displayName}</strong>
                  <small>
                    {user.role === "admin"
                      ? copy.management.roleAdmin
                      : copy.management.roleUser}
                    <span aria-hidden="true"> · </span>
                    {user.draftCount}{" "}
                    {user.draftCount === 1
                      ? copy.management.draftCount
                      : copy.management.draftsCount}
                  </small>
                </div>
                <span className={`state-badge ${user.status}`}>
                  {user.status === "active"
                    ? copy.management.active
                    : copy.management.userDisabled}
                </span>
                {user.id !== currentUserId &&
                  (user.status === "active" ? (
                    confirmDisable === user.id ? (
                      <span className="confirm-actions">
                        <button
                          autoFocus
                          className="danger-button"
                          disabled={busy}
                          type="button"
                          onClick={() => void disableUser(user.id)}
                        >
                          {copy.management.confirmDisableUser}
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setConfirmDisable(null)}
                        >
                          {copy.management.cancel}
                        </button>
                      </span>
                    ) : (
                      <button
                        className="text-button danger-text"
                        type="button"
                        onClick={() => setConfirmDisable(user.id)}
                      >
                        {copy.management.disableUser}
                      </button>
                    )
                  ) : (
                    <button
                      className="text-button"
                      disabled={busy}
                      type="button"
                      onClick={() => void enableUser(user.id)}
                    >
                      {copy.management.enableUser}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </article>
      </div>
      <article className="management-panel admin-content-panel">
        <h2>{copy.management.allReportsHeading}</h2>
        <div className="admin-report-list">
          {drafts.map((draft) => (
            <div className="admin-row" key={draft.id}>
              <div>
                <strong>{draft.title ?? copy.management.untitled}</strong>
                <small>
                  {copy.management.owner} {draft.ownerDisplayName}
                  <span aria-hidden="true"> · </span>
                  {copy.management.version} {draft.latestVersionNumber}
                </small>
              </div>
              <span className={`state-badge ${draft.status}`}>
                {draft.status === "enabled"
                  ? copy.management.enabled
                  : copy.management.reportDisabled}
              </span>
              <span className="confirm-actions">
                <button
                  className="text-button"
                  disabled={busy}
                  type="button"
                  onClick={() => void toggleDraft(draft)}
                >
                  {draft.status === "enabled"
                    ? copy.management.disable
                    : copy.management.enable}
                </button>
                {confirmDeleteDraft === draft.id ? (
                  <>
                    <button
                      autoFocus
                      className="danger-button"
                      disabled={busy}
                      type="button"
                      onClick={() => void deleteDraft(draft.id)}
                    >
                      {copy.management.confirmDelete}
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setConfirmDeleteDraft(null)}
                    >
                      {copy.management.cancel}
                    </button>
                  </>
                ) : (
                  <button
                    className="text-button danger-text"
                    type="button"
                    onClick={() => setConfirmDeleteDraft(draft.id)}
                  >
                    {copy.management.delete}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
