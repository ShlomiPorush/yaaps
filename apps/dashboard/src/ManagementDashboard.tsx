import type {
  ApiKeySummary,
  DraftSummary,
  DraftVersionSummary,
} from "@yaaps/contracts";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { DashboardApi, type CreatedApiKey } from "./dashboard-api.js";
import { RecoveryCodes } from "./RecoveryCodes.js";
import { AdministrationPanel } from "./AdministrationPanel.js";
import {
  formatDate as formatLocaleDate,
  type Locale,
  type LocaleDocument,
} from "./localization.js";

interface ManagementDashboardProps {
  actionError: boolean;
  busy: boolean;
  copy: LocaleDocument;
  fetchImplementation: typeof fetch;
  locale: Locale;
  onAddPasskey: () => void;
  passkeyAdded: boolean;
  recoveryCodes: string[];
  role: "admin" | "user";
  userId: string;
  view: "admin" | "reports" | "settings";
}

export function ManagementDashboard({
  actionError,
  busy,
  copy,
  fetchImplementation,
  locale,
  onAddPasskey,
  passkeyAdded,
  recoveryCodes,
  role,
  userId,
  view,
}: ManagementDashboardProps) {
  const api = useMemo(
    () => new DashboardApi(fetchImplementation),
    [fetchImplementation],
  );
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draftsTotal, setDraftsTotal] = useState(0);
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [expandedDraft, setExpandedDraft] = useState<string | null>(null);
  const [versions, setVersions] = useState<
    Record<string, DraftVersionSummary[]>
  >({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [confirmRegenerateCodes, setConfirmRegenerateCodes] = useState(false);
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[]>([]);

  const effectiveView = view === "admin" && role !== "admin" ? "reports" : view;

  useEffect(() => {
    if (effectiveView === "admin") {
      setLoading(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        if (effectiveView === "reports") {
          const [draftResponse, keyResponse] = await Promise.all([
            api.listDrafts(),
            api.listApiKeys(),
          ]);
          if (active) {
            setDrafts(draftResponse.items);
            setDraftsTotal(draftResponse.total);
            setApiKeys(keyResponse.items);
            setRequestError(false);
          }
        } else {
          const keyResponse = await api.listApiKeys();
          if (active) {
            setApiKeys(keyResponse.items);
            setRequestError(false);
          }
        }
      } catch {
        if (active) {
          setRequestError(true);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [api, effectiveView]);

  const formatDate = (value: string) => formatLocaleDate(locale, value);

  async function withRequest(operation: () => Promise<void>) {
    setRequestBusy(true);
    setRequestError(false);
    try {
      await operation();
    } catch {
      setRequestError(true);
    } finally {
      setRequestBusy(false);
    }
  }

  async function toggleDraft(draft: DraftSummary) {
    await withRequest(async () => {
      const updated = await api.updateDraft(draft.id, {
        status: draft.status === "enabled" ? "disabled" : "enabled",
      });
      setDrafts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    });
  }

  async function toggleVersions(draftId: string) {
    if (expandedDraft === draftId) {
      setExpandedDraft(null);
      return;
    }
    setExpandedDraft(draftId);
    // Always refetch on expand: a cached list goes stale as soon as the agent
    // publishes a new version, and nothing else invalidates it.
    await withRequest(async () => {
      const response = await api.listVersions(draftId);
      setVersions((current) => ({
        ...current,
        [draftId]: response.items,
      }));
    });
  }

  async function deleteDraft(draftId: string) {
    await withRequest(async () => {
      await api.deleteDraft(draftId);
      setDrafts((current) => current.filter((draft) => draft.id !== draftId));
      setDraftsTotal((current) => Math.max(0, current - 1));
      setConfirmDelete(null);
      setExpandedDraft((current) => (current === draftId ? null : current));
    });
  }

  async function createApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await withRequest(async () => {
      const created = await api.createApiKey(keyLabel);
      setCreatedKey(created);
      setCopiedKey(false);
      setKeyLabel("");
      const response = await api.listApiKeys();
      setApiKeys(response.items);
    });
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopiedKey(true);
    } catch {
      setRequestError(true);
    }
  }

  async function regenerateRecoveryCodes() {
    await withRequest(async () => {
      const response = await api.regenerateRecoveryCodes();
      setRegeneratedCodes(response.recoveryCodes);
      setConfirmRegenerateCodes(false);
    });
  }

  async function renameApiKey(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    await withRequest(async () => {
      const updated = await api.renameApiKey(id, renameLabel);
      setApiKeys((current) =>
        current.map((key) => (key.id === updated.id ? updated : key)),
      );
      setRenamingKey(null);
    });
  }

  async function revokeApiKey(id: string) {
    await withRequest(async () => {
      await api.revokeApiKey(id);
      setApiKeys((current) => current.filter((key) => key.id !== id));
      setConfirmRevoke(null);
    });
  }

  const errorBanner = requestError ? (
    <p className="error-banner" role="alert">
      {copy.management.error}
    </p>
  ) : null;

  const reportsPanel = (
    <section
      className="management-panel reports-panel"
      aria-labelledby="drafts-heading"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{copy.management.reportsEyebrow}</p>
          <h2 id="drafts-heading">{copy.management.reportsHeading}</h2>
        </div>
        {loading && (
          <span className="quiet-status">{copy.management.loading}</span>
        )}
      </div>

      {!loading && drafts.length === 0 && (
        <div className="empty-state">
          <strong>{copy.management.emptyReportsHeading}</strong>
          <p>{copy.management.emptyReportsText}</p>
        </div>
      )}

      <div className="draft-list">
        {drafts.map((draft) => (
          <article className="draft-item" key={draft.id}>
            <div className="draft-primary">
              <div>
                <div className="draft-title-line">
                  <h3>{draft.title ?? copy.management.untitled}</h3>
                  <span className={`state-badge ${draft.status}`}>
                    {draft.status === "enabled"
                      ? copy.management.enabled
                      : copy.management.reportDisabled}
                  </span>
                </div>
                <p className="draft-meta">
                  {copy.management.version} {draft.latestVersionNumber}
                  <span aria-hidden="true"> · </span>
                  {copy.management.expires} {formatDate(draft.expiresAt)}
                </p>
              </div>
              <a
                className="public-link"
                href={draft.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                {copy.management.openReport}
              </a>
            </div>

            <div className="row-actions">
              <button
                className="text-button"
                disabled={requestBusy}
                type="button"
                onClick={() => void toggleVersions(draft.id)}
              >
                {expandedDraft === draft.id
                  ? copy.management.hideVersions
                  : copy.management.showVersions}
              </button>
              <button
                className="text-button"
                disabled={requestBusy}
                type="button"
                onClick={() => void toggleDraft(draft)}
              >
                {draft.status === "enabled"
                  ? copy.management.disable
                  : copy.management.enable}
              </button>
              {confirmDelete === draft.id ? (
                <span className="confirm-actions">
                  <button
                    autoFocus
                    className="danger-button"
                    disabled={requestBusy}
                    type="button"
                    onClick={() => void deleteDraft(draft.id)}
                  >
                    {copy.management.confirmDelete}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                  >
                    {copy.management.cancel}
                  </button>
                </span>
              ) : (
                <button
                  className="text-button danger-text"
                  type="button"
                  onClick={() => setConfirmDelete(draft.id)}
                >
                  {copy.management.delete}
                </button>
              )}
            </div>

            {expandedDraft === draft.id && (
              <div className="version-list">
                <strong>{copy.management.versionsHeading}</strong>
                {versions[draft.id] === undefined && (
                  <span className="quiet-status">
                    {copy.management.loading}
                  </span>
                )}
                {(versions[draft.id] ?? []).map((version) => (
                  <a
                    href={version.publicUrl}
                    key={version.versionNumber}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>
                      {copy.management.version} {version.versionNumber}
                    </span>
                    <small>
                      {formatDate(version.createdAt)} ·{" "}
                      {Math.ceil(version.byteLength / 1024)} KB
                    </small>
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );

  const keysPanel = (
    <section className="management-panel" aria-labelledby="keys-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{copy.management.keysEyebrow}</p>
          <h2 id="keys-heading">{copy.management.keysHeading}</h2>
        </div>
      </div>
      <form className="key-form" onSubmit={createApiKey}>
        <label>
          <span>{copy.management.keyLabel}</span>
          <input
            required
            maxLength={100}
            value={keyLabel}
            placeholder={copy.management.keyPlaceholder}
            onChange={(event) => setKeyLabel(event.target.value)}
          />
        </label>
        <button className="primary-button" disabled={requestBusy} type="submit">
          {copy.management.createKey}
        </button>
      </form>

      {createdKey && (
        <div className="one-time-key" role="status">
          <strong>{copy.management.keyReady}</strong>
          <p>{copy.management.keyWarning}</p>
          <code dir="ltr">{createdKey.key}</code>
          <div className="row-actions">
            <button
              className="text-button"
              type="button"
              onClick={() => void copyKey()}
            >
              {copiedKey ? copy.management.copied : copy.management.copyKey}
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => setCreatedKey(null)}
            >
              {copy.management.savedKey}
            </button>
          </div>
        </div>
      )}

      <div className="key-list">
        {apiKeys.map((key) => (
          <div className="key-item" key={key.id}>
            <div>
              {renamingKey === key.id ? (
                <form
                  className="key-rename-form"
                  onSubmit={(event) => void renameApiKey(event, key.id)}
                >
                  <input
                    autoFocus
                    required
                    aria-label={copy.management.keyLabel}
                    maxLength={100}
                    value={renameLabel}
                    onChange={(event) => setRenameLabel(event.target.value)}
                  />
                  <button
                    className="text-button"
                    disabled={requestBusy}
                    type="submit"
                  >
                    {copy.management.renameSave}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setRenamingKey(null)}
                  >
                    {copy.management.cancel}
                  </button>
                </form>
              ) : (
                <strong>{key.label}</strong>
              )}
              <code dir="ltr">{key.prefix}…</code>
              <small>
                {key.lastUsedAt
                  ? `${copy.management.lastUsed} ${formatDate(key.lastUsedAt)}`
                  : copy.management.neverUsed}
              </small>
            </div>
            {confirmRevoke === key.id ? (
              <span className="confirm-actions vertical">
                <button
                  autoFocus
                  className="danger-button"
                  disabled={requestBusy}
                  type="button"
                  onClick={() => void revokeApiKey(key.id)}
                >
                  {copy.management.confirmRevoke}
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setConfirmRevoke(null)}
                >
                  {copy.management.cancel}
                </button>
              </span>
            ) : (
              <span className="confirm-actions vertical">
                {renamingKey !== key.id && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setRenamingKey(key.id);
                      setRenameLabel(key.label);
                    }}
                  >
                    {copy.management.rename}
                  </button>
                )}
                <button
                  className="text-button danger-text"
                  type="button"
                  onClick={() => setConfirmRevoke(key.id)}
                >
                  {copy.management.revoke}
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );

  const accountPanel = (
    <section
      className="management-panel account-panel"
      aria-labelledby="account-heading"
    >
      <p className="eyebrow">{copy.auth.signedInEyebrow}</p>
      <h2 id="account-heading">{copy.management.accountHeading}</h2>
      <p>{role === "admin" ? copy.auth.roleAdmin : copy.auth.roleUser}</p>
      {passkeyAdded && (
        <p className="success-message">{copy.auth.passkeyAdded}</p>
      )}
      {actionError && (
        <p className="error-banner" role="alert">
          {copy.auth.error}
        </p>
      )}
      <div className="auth-actions">
        <button
          className="secondary-button"
          disabled={busy}
          type="button"
          onClick={onAddPasskey}
        >
          {copy.auth.addPasskey}
        </button>
        {confirmRegenerateCodes ? (
          <span className="confirm-actions">
            <button
              autoFocus
              className="danger-button"
              disabled={requestBusy}
              type="button"
              onClick={() => void regenerateRecoveryCodes()}
            >
              {copy.auth.regenerateRecoveryCodesConfirm}
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => setConfirmRegenerateCodes(false)}
            >
              {copy.management.cancel}
            </button>
          </span>
        ) : (
          <button
            className="secondary-button"
            disabled={requestBusy}
            type="button"
            onClick={() => setConfirmRegenerateCodes(true)}
          >
            {copy.auth.regenerateRecoveryCodes}
          </button>
        )}
      </div>
      {confirmRegenerateCodes && (
        <p className="quiet-status">
          {copy.auth.regenerateRecoveryCodesWarning}
        </p>
      )}
      {regeneratedCodes.length > 0 && (
        <>
          <RecoveryCodes codes={regeneratedCodes} copy={copy} />
          <button
            className="text-button"
            type="button"
            onClick={() => setRegeneratedCodes([])}
          >
            {copy.auth.savedRecoveryCodes}
          </button>
        </>
      )}
    </section>
  );

  const connectCard = (
    <section
      className="management-panel connect-entry-card"
      aria-labelledby="connect-entry-heading"
    >
      <div>
        <p className="eyebrow">{copy.connect.skillName}</p>
        <h2 id="connect-entry-heading">{copy.connect.heading}</h2>
        <p>{copy.connect.intro}</p>
      </div>
      <a className="primary-link" href="/connect">
        {copy.navigation.connect}
      </a>
    </section>
  );

  if (effectiveView === "admin") {
    return (
      <AdministrationPanel
        copy={copy}
        currentUserId={userId}
        fetchImplementation={fetchImplementation}
        locale={locale}
      />
    );
  }

  if (effectiveView === "settings") {
    return (
      <div className="dashboard-view">
        <section
          className="dashboard-heading"
          aria-labelledby="dashboard-heading"
        >
          <div>
            <p className="eyebrow">{copy.management.settingsEyebrow}</p>
            <h1 id="dashboard-heading">{copy.management.settingsHeading}</h1>
            <p className="intro">{copy.management.settingsIntro}</p>
          </div>
        </section>
        {errorBanner}
        {connectCard}
        <div className="management-grid">
          {keysPanel}
          {accountPanel}
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-view">
      <section
        className="dashboard-heading"
        aria-labelledby="dashboard-heading"
      >
        <div>
          <p className="eyebrow">{copy.management.eyebrow}</p>
          <h1 id="dashboard-heading">{copy.management.heading}</h1>
          <p className="intro">{copy.management.intro}</p>
        </div>
        {!loading && (
          <div
            className="dashboard-counts"
            aria-label={copy.management.summary}
          >
            <span>
              <strong>{draftsTotal}</strong>{" "}
              {draftsTotal === 1
                ? copy.management.draftCount
                : copy.management.draftsCount}
            </span>
            <span>
              <strong>{apiKeys.length}</strong>{" "}
              {apiKeys.length === 1
                ? copy.management.keyCount
                : copy.management.keysCount}
            </span>
          </div>
        )}
      </section>
      <div className="dashboard-primary-action">
        <a className="primary-link" href="/connect">
          {copy.connect.heading}
        </a>
      </div>
      {errorBanner}
      {actionError && (
        <p className="error-banner" role="alert">
          {copy.auth.error}
        </p>
      )}
      {draftsTotal > drafts.length && (
        <p className="quiet-status">
          {copy.management.showingLimited
            .replace("{shown}", String(drafts.length))
            .replace("{total}", String(draftsTotal))}
        </p>
      )}
      {recoveryCodes.length > 0 && (
        <section className="management-panel">
          <RecoveryCodes codes={recoveryCodes} copy={copy} />
        </section>
      )}
      {reportsPanel}
    </div>
  );
}
