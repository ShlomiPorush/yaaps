import type {
  ApiKeySummary,
  CategorySummary,
  DraftSummary,
  DraftVersionSummary,
  PublicServiceMetadata,
} from "@yaaps/contracts";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { DashboardApi, type CreatedApiKey } from "./dashboard-api.js";
import { RecoveryCodes } from "./RecoveryCodes.js";
import { AdministrationPanel } from "./AdministrationPanel.js";
import {
  formatDate as formatLocaleDate,
  formatDeviceDate,
  formatRemainingDuration,
  type Locale,
  type LocaleDocument,
} from "./localization.js";

// The category select carries existing categories behind a prefix so that no
// category name can ever collide with the placeholder or the new-category row.
const existingCategoryPrefix = "existing:";
const newCategoryChoice = "new";
const noCategoryChoice = "";

type ResourcePolicy = "isolated" | "connected";

// The API contract adds this field alongside the dashboard work. Keeping the
// compatibility read here lets this commit remain isolated until both commits
// are integrated on the feature branch.
function resourcePolicyOf(
  summary: DraftSummary | DraftVersionSummary,
): ResourcePolicy {
  return (summary as unknown as { resourcePolicy: ResourcePolicy })
    .resourcePolicy;
}

function ResourcePolicyBadge({
  copy,
  policy,
}: {
  copy: LocaleDocument;
  policy: ResourcePolicy;
}) {
  return (
    <span className={`resource-policy-badge ${policy}`}>
      {policy === "isolated"
        ? copy.management.resourcePolicyIsolated
        : copy.management.resourcePolicyConnected}
    </span>
  );
}

function categoryChoiceOf(category: string): string {
  return `${existingCategoryPrefix}${category}`;
}

function categoryOfChoice(choice: string, typedName: string): string {
  if (choice === newCategoryChoice) {
    return typedName.trim();
  }
  return choice.startsWith(existingCategoryPrefix)
    ? choice.slice(existingCategoryPrefix.length)
    : "";
}

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
  const [listedTotal, setListedTotal] = useState(0);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [categoryChoice, setCategoryChoice] = useState(noCategoryChoice);
  const [categoryValue, setCategoryValue] = useState("");
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
  const [extendingDraft, setExtendingDraft] = useState<string | null>(null);
  const [retentionLimits, setRetentionLimits] = useState<
    PublicServiceMetadata["limits"] | null
  >(null);
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
          // Retention limits only trim the extend options, so a metadata
          // failure must not take down the report list with it.
          void api
            .serviceMetadata()
            .then((metadata) => {
              if (active) {
                setRetentionLimits(metadata.limits);
              }
            })
            .catch(() => undefined);
          const [draftResponse, keyResponse, categoryResponse] =
            await Promise.all([
              api.listDrafts(),
              api.listApiKeys(),
              api.listCategories(),
            ]);
          if (active) {
            setDrafts(draftResponse.items);
            setDraftsTotal(draftResponse.total);
            setListedTotal(draftResponse.total);
            setApiKeys(keyResponse.items);
            setCategories(categoryResponse.items);
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

  const formatExpiry = (value: string) => {
    const remaining = formatRemainingDuration(locale, value);
    const note = remaining
      ? copy.management.remaining.replace("{duration}", remaining)
      : copy.management.expired;
    return `${formatDeviceDate(value)} (${note})`;
  };

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

  function replaceDraft(updated: DraftSummary) {
    setDrafts((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  async function loadDrafts(category: string | null) {
    const response = await api.listDrafts(category ?? undefined);
    setDrafts(response.items);
    setListedTotal(response.total);
    if (category === null) {
      setDraftsTotal(response.total);
    }
  }

  // The set of categories is derived from the live drafts, so every mutation
  // that can add or remove the last draft of a category reloads it. Reports
  // true when the active filter lost its last draft and was dropped.
  async function reloadCategories(): Promise<boolean> {
    const response = await api.listCategories();
    setCategories(response.items);
    if (
      categoryFilter === null ||
      response.items.some((item) => item.category === categoryFilter)
    ) {
      return false;
    }
    setCategoryFilter(null);
    return true;
  }

  async function toggleDraft(draft: DraftSummary) {
    await withRequest(async () => {
      replaceDraft(
        await api.updateDraft(draft.id, {
          status: draft.status === "enabled" ? "disabled" : "enabled",
        }),
      );
    });
  }

  async function selectCategory(category: string | null) {
    if (category === categoryFilter) {
      return;
    }
    setCategoryFilter(category);
    await withRequest(() => loadDrafts(category));
  }

  async function applyCategory(draftId: string, category: string | null) {
    await withRequest(async () => {
      replaceDraft(await api.updateDraft(draftId, { category }));
      setEditingCategory(null);
      const filterDropped = await reloadCategories();
      // A filtered list can no longer hold a draft that moved to another
      // category, so the server decides again which reports belong here.
      if (categoryFilter !== null) {
        await loadDrafts(filterDropped ? null : categoryFilter);
      }
    });
  }

  function startCategoryEdit(draft: DraftSummary) {
    const current = draft.category;
    const listed = categories.some((item) => item.category === current);
    setEditingCategory(draft.id);
    if (current !== null && listed) {
      setCategoryChoice(categoryChoiceOf(current));
      setCategoryValue("");
      return;
    }
    // Nothing to pick from, or a category the list does not know yet, opens
    // the editor straight on the text input.
    setCategoryChoice(
      current === null && categories.length > 0
        ? noCategoryChoice
        : newCategoryChoice,
    );
    setCategoryValue(current ?? "");
  }

  async function saveCategory(
    event: FormEvent<HTMLFormElement>,
    draftId: string,
  ) {
    event.preventDefault();
    const category = categoryOfChoice(categoryChoice, categoryValue);
    if (category === "") {
      return;
    }
    await applyCategory(draftId, category);
  }

  const extendChoices = [
    { label: copy.management.extendDay, seconds: 24 * 60 * 60 },
    { label: copy.management.extendWeek, seconds: 7 * 24 * 60 * 60 },
    { label: copy.management.extendMonth, seconds: 30 * 24 * 60 * 60 },
  ].filter(
    (choice) =>
      !retentionLimits ||
      (choice.seconds >= retentionLimits.minimumTtlSeconds &&
        choice.seconds <= retentionLimits.maximumTtlSeconds),
  );

  async function extendDraft(draftId: string, ttlSeconds: number) {
    await withRequest(async () => {
      replaceDraft(await api.updateDraft(draftId, { ttlSeconds }));
      setExtendingDraft(null);
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
      setListedTotal((current) => Math.max(0, current - 1));
      setConfirmDelete(null);
      setExpandedDraft((current) => (current === draftId ? null : current));
      if (await reloadCategories()) {
        await loadDrafts(null);
      }
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

      {categories.length > 0 && (
        <div
          className="category-filter"
          role="group"
          aria-label={copy.management.categoryFilterLabel}
        >
          <button
            aria-pressed={categoryFilter === null}
            className="category-filter-option"
            disabled={requestBusy}
            type="button"
            onClick={() => void selectCategory(null)}
          >
            {copy.management.categoryFilterAll}
          </button>
          {categories.map((item) => (
            <button
              aria-label={copy.management.categoryFilterOption
                .replace("{category}", item.category)
                .replace("{count}", String(item.draftCount))}
              aria-pressed={categoryFilter === item.category}
              className="category-filter-option"
              disabled={requestBusy}
              key={item.category}
              type="button"
              onClick={() => void selectCategory(item.category)}
            >
              <span className="category-name">{item.category}</span>
              <span className="category-filter-count" aria-hidden="true">
                {item.draftCount}
              </span>
            </button>
          ))}
        </div>
      )}

      {!loading && drafts.length === 0 && categoryFilter === null && (
        <div className="empty-state">
          <strong>{copy.management.emptyReportsHeading}</strong>
          <p>{copy.management.emptyReportsText}</p>
        </div>
      )}

      {!loading && drafts.length === 0 && categoryFilter !== null && (
        <div className="empty-state">
          <strong>{copy.management.emptyCategoryHeading}</strong>
          <p>
            {copy.management.emptyCategoryText.replace(
              "{category}",
              categoryFilter,
            )}
          </p>
        </div>
      )}

      <div className="draft-list">
        {drafts.map((draft) => (
          <article className="draft-item" key={draft.id}>
            <div className="draft-primary">
              <div>
                <div className="draft-title-line">
                  <h3>
                    <a href={draft.publicUrl} target="_blank" rel="noreferrer">
                      {draft.title ?? copy.management.untitled}
                    </a>
                  </h3>
                  <span className="draft-title-badges">
                    <span className={`state-badge ${draft.status}`}>
                      {draft.status === "enabled"
                        ? copy.management.enabled
                        : copy.management.reportDisabled}
                    </span>
                    <ResourcePolicyBadge
                      copy={copy}
                      policy={resourcePolicyOf(draft)}
                    />
                  </span>
                </div>
                <p className="draft-meta">
                  {draft.category !== null && (
                    <>
                      <span className="category-chip">{draft.category}</span>
                      <span aria-hidden="true"> · </span>
                    </>
                  )}
                  {copy.management.version} {draft.latestVersionNumber}
                  <span aria-hidden="true"> · </span>
                  {copy.management.expires} {formatExpiry(draft.expiresAt)}
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
              {editingCategory === draft.id ? (
                <form
                  className="category-form"
                  onSubmit={(event) => void saveCategory(event, draft.id)}
                >
                  {categories.length > 0 && (
                    <select
                      aria-label={copy.management.categoryLabel}
                      value={categoryChoice}
                      onChange={(event) =>
                        setCategoryChoice(event.target.value)
                      }
                    >
                      {categoryChoice === noCategoryChoice && (
                        <option disabled value={noCategoryChoice}>
                          {copy.management.categoryChoose}
                        </option>
                      )}
                      {categories.map((item) => (
                        <option
                          key={item.category}
                          value={categoryChoiceOf(item.category)}
                        >
                          {item.category}
                        </option>
                      ))}
                      <option value={newCategoryChoice}>
                        {copy.management.categoryNew}
                      </option>
                    </select>
                  )}
                  {categoryChoice === newCategoryChoice && (
                    <input
                      autoFocus
                      required
                      aria-label={copy.management.categoryNewLabel}
                      maxLength={100}
                      placeholder={copy.management.categoryPlaceholder}
                      value={categoryValue}
                      onChange={(event) => setCategoryValue(event.target.value)}
                    />
                  )}
                  <button
                    className="text-button"
                    disabled={
                      requestBusy ||
                      categoryOfChoice(categoryChoice, categoryValue) === ""
                    }
                    type="submit"
                  >
                    {copy.management.categorySave}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setEditingCategory(null)}
                  >
                    {copy.management.cancel}
                  </button>
                </form>
              ) : (
                <>
                  <button
                    className="text-button"
                    disabled={requestBusy}
                    type="button"
                    onClick={() => startCategoryEdit(draft)}
                  >
                    {draft.category === null
                      ? copy.management.categorySet
                      : copy.management.categoryEdit}
                  </button>
                  {draft.category !== null && (
                    <button
                      className="text-button"
                      disabled={requestBusy}
                      type="button"
                      onClick={() => void applyCategory(draft.id, null)}
                    >
                      {copy.management.categoryClear}
                    </button>
                  )}
                </>
              )}
              {extendingDraft === draft.id ? (
                <span className="confirm-actions">
                  {extendChoices.map((choice) => (
                    <button
                      className="text-button"
                      disabled={requestBusy}
                      key={choice.seconds}
                      type="button"
                      onClick={() => void extendDraft(draft.id, choice.seconds)}
                    >
                      {choice.label}
                    </button>
                  ))}
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setExtendingDraft(null)}
                  >
                    {copy.management.cancel}
                  </button>
                </span>
              ) : (
                <button
                  className="text-button"
                  disabled={requestBusy}
                  type="button"
                  onClick={() => setExtendingDraft(draft.id)}
                >
                  {copy.management.extend}
                </button>
              )}
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
                    <span className="version-identity">
                      <span>
                        {copy.management.version} {version.versionNumber}
                      </span>
                      <ResourcePolicyBadge
                        copy={copy}
                        policy={resourcePolicyOf(version)}
                      />
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
      {listedTotal > drafts.length && (
        <p className="quiet-status">
          {copy.management.showingLimited
            .replace("{shown}", String(drafts.length))
            .replace("{total}", String(listedTotal))}
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
