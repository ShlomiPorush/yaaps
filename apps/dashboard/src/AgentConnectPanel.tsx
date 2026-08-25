import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { RecoveryCodes } from "./RecoveryCodes.js";

import {
  DashboardApi,
  DashboardRequestError,
  type PendingDeviceConnection,
} from "./dashboard-api.js";
import {
  formatDate as formatLocaleDate,
  type Locale,
  type LocaleDocument,
} from "./localization.js";

interface AgentConnectPanelProps {
  copy: LocaleDocument;
}

interface AgentConnectionApprovalPanelProps {
  copy: LocaleDocument;
  fetchImplementation: typeof fetch;
  locale: Locale;
  recoveryCodes?: string[];
}

type AgentClient = "claude" | "codex" | "generic";
type InstallMethod = "macos" | "manual" | "windows";
type ConnectStep = 1 | 2 | 3;
type ConnectionState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "pending"; request: PendingDeviceConnection }
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; message: "decided" | "invalid" | "requestError" };

function codeFromLocation(): string {
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

// Store a copy key, not a resolved string: the state survives a locale switch,
// so the message must be resolved at render time.
function decisionError(error: unknown): ConnectionState {
  if (
    error instanceof DashboardRequestError &&
    error.code === "DEVICE_CONNECTION_EXPIRED"
  ) {
    return { kind: "expired" };
  }
  if (
    error instanceof DashboardRequestError &&
    error.code === "DEVICE_CONNECTION_DECIDED"
  ) {
    return { kind: "error", message: "decided" };
  }
  if (
    error instanceof DashboardRequestError &&
    (error.code === "DEVICE_CONNECTION_NOT_FOUND" ||
      error.code === "INVALID_REQUEST")
  ) {
    return { kind: "error", message: "invalid" };
  }
  return { kind: "error", message: "requestError" };
}

function clearCodeFromLocation() {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function navigateWithinDashboard(href: string) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function AgentConnectPanel({ copy }: AgentConnectPanelProps) {
  const [agentClient, setAgentClient] = useState<AgentClient>("codex");
  const [installMethod, setInstallMethod] = useState<InstallMethod>("windows");
  const [installCopied, setInstallCopied] = useState(false);
  const [manualInstalled, setManualInstalled] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [copyError, setCopyError] = useState<"install" | "prompt" | null>(null);
  const [activeStep, setActiveStep] = useState<ConnectStep>(1);
  const [userCode, setUserCode] = useState("");
  const stepOneRef = useRef<HTMLElement>(null);
  const stepTwoRef = useRef<HTMLElement>(null);
  const stepThreeRef = useRef<HTMLElement>(null);

  function focusStep(step: ConnectStep) {
    setActiveStep(step);
    const target =
      step === 1 ? stepOneRef : step === 2 ? stepTwoRef : stepThreeRef;
    queueMicrotask(() => {
      const element = target.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? "auto"
          : "smooth",
        block: "nearest",
        inline: "nearest",
      });
    });
  }

  function stepState(step: ConnectStep): "active" | "complete" | "next" {
    if (step === activeStep) return "active";
    return step < activeStep ? "complete" : "next";
  }

  function stepStatus(step: ConnectStep) {
    const state = stepState(step);
    if (state === "active") return copy.connect.stepActive;
    if (state === "complete") {
      if (step === 1) {
        if (manualInstalled) return copy.connect.stepInstalled;
        if (installCopied) return copy.connect.stepCommandCopied;
        return copy.connect.stepComplete;
      }
      if (step === 2) {
        return promptCopied
          ? copy.connect.stepPromptCopied
          : copy.connect.stepComplete;
      }
      return copy.connect.stepComplete;
    }
    return copy.connect.stepNext;
  }

  function resetInstallProgress() {
    setInstallCopied(false);
    setManualInstalled(false);
    setPromptCopied(false);
    setCopyError(null);
    setActiveStep(1);
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActiveStep(3);
    const parameters = new URLSearchParams({ code: userCode.trim() });
    navigateWithinDashboard(`/dashboard/connect/approve?${parameters}`);
  }

  const clientOptions: Array<{
    detail: string;
    destination: string;
    id: AgentClient;
    name: string;
  }> = [
    {
      detail: copy.connect.codexDetail,
      destination: "$HOME/.agents/skills/yaaps",
      id: "codex",
      name: copy.connect.codexName,
    },
    {
      detail: copy.connect.claudeDetail,
      destination: "$HOME/.claude/skills/yaaps",
      id: "claude",
      name: copy.connect.claudeName,
    },
    {
      detail: copy.connect.genericDetail,
      destination: copy.connect.genericDestination,
      id: "generic",
      name: copy.connect.genericName,
    },
  ];
  const selectedClient =
    clientOptions.find((client) => client.id === agentClient) ??
    clientOptions[0]!;
  const windowsScriptUrl = new URL(
    "/downloads/install-skill.ps1",
    window.location.origin,
  ).toString();
  const macosScriptUrl = new URL(
    "/downloads/install-skill.sh",
    window.location.origin,
  ).toString();
  const installCommand =
    installMethod === "windows"
      ? `irm '${windowsScriptUrl}' | iex`
      : `curl -fsSL '${macosScriptUrl}' | sh`;
  const scriptUrl =
    installMethod === "windows" ? windowsScriptUrl : macosScriptUrl;

  async function copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      setInstallCopied(true);
      setManualInstalled(false);
      setCopyError(null);
      focusStep(2);
    } catch {
      setInstallCopied(false);
      setCopyError("install");
    }
  }

  async function copyConnectionPrompt() {
    try {
      await navigator.clipboard.writeText(copy.connect.askPrompt);
      setPromptCopied(true);
      setCopyError(null);
      focusStep(3);
    } catch {
      setPromptCopied(false);
      setCopyError("prompt");
    }
  }

  return (
    <div className="dashboard-view connect-view">
      <section className="dashboard-heading" aria-labelledby="connect-heading">
        <div>
          <p className="eyebrow">{copy.connect.skillName}</p>
          <h1 id="connect-heading">{copy.connect.heading}</h1>
          <p className="intro">{copy.connect.intro}</p>
        </div>
      </section>

      <div
        className="connect-guided-layout"
        aria-label={copy.connect.stepsLabel}
        role="group"
      >
        <section
          aria-current={stepState(1) === "active" ? "step" : undefined}
          aria-labelledby="installation-heading"
          className={`management-panel connect-step-card connect-install-panel is-${stepState(1)}`}
          data-step-state={stepState(1)}
          ref={stepOneRef}
          tabIndex={-1}
        >
          <div className="connect-step-heading">
            <span className="connect-step-number" aria-hidden="true">
              {stepState(1) === "complete" ? "✓" : "1"}
            </span>
            <div>
              <span className="connect-step-status">{stepStatus(1)}</span>
              <p className="eyebrow">{copy.connect.stepInstall}</p>
              <h2 id="installation-heading">{copy.connect.installHeading}</h2>
            </div>
          </div>
          <fieldset className="install-methods">
            <legend>{copy.connect.methodHeading}</legend>
            {(["windows", "macos", "manual"] as const).map((method) => (
              <label
                className={
                  installMethod === method
                    ? "install-method selected"
                    : "install-method"
                }
                key={method}
              >
                <input
                  checked={installMethod === method}
                  name="install-method"
                  type="radio"
                  value={method}
                  onChange={() => {
                    setInstallMethod(method);
                    resetInstallProgress();
                  }}
                />
                {copy.connect.methodNames[method]}
              </label>
            ))}
          </fieldset>

          {installMethod === "manual" && (
            <fieldset className="client-options manual-client-options">
              <legend>{copy.connect.platformHeading}</legend>
              {clientOptions.map((client) => (
                <label
                  className={
                    agentClient === client.id
                      ? "client-option selected"
                      : "client-option"
                  }
                  key={client.id}
                >
                  <input
                    checked={agentClient === client.id}
                    name="agent-client"
                    type="radio"
                    value={client.id}
                    onChange={() => {
                      setAgentClient(client.id);
                      resetInstallProgress();
                    }}
                  />
                  <span>
                    <strong>{client.name}</strong>
                    <small>{client.detail}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {installMethod !== "manual" ? (
            <div className="install-command-card" aria-live="polite">
              <p className="automatic-targets">
                {copy.connect.automaticTargets}
              </p>
              <p>{copy.connect.commandIntro}</p>
              <div className="install-command-row">
                <code dir="ltr">{installCommand}</code>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void copyInstallCommand()}
                >
                  {installCopied
                    ? copy.connect.copied
                    : copy.connect.copyCommand}
                </button>
              </div>
              <p className="script-safety">{copy.connect.scriptSafety}</p>
              <a href={scriptUrl} rel="noreferrer" target="_blank">
                {copy.connect.reviewScript}
              </a>
              {copyError === "install" && (
                <p className="copy-error" role="alert">
                  {copy.connect.copyFailed}
                </p>
              )}
            </div>
          ) : (
            <div className="manual-install-card" aria-live="polite">
              <a
                className="primary-link"
                download
                href="/downloads/yaaps-skill.zip"
              >
                {copy.connect.downloadSkill}
              </a>
              <ol>
                <li>{copy.connect.manualExtract}</li>
                <li>
                  {copy.connect.manualCopy}{" "}
                  <code>{selectedClient.destination}</code>
                </li>
              </ol>
              <button
                className="secondary-button manual-install-continue"
                type="button"
                onClick={() => {
                  setManualInstalled(true);
                  focusStep(2);
                }}
              >
                {copy.connect.manualContinue}
              </button>
            </div>
          )}
        </section>

        <section
          aria-current={stepState(2) === "active" ? "step" : undefined}
          aria-labelledby="ask-heading"
          className={`management-panel connect-step-card connect-ask-panel is-${stepState(2)}`}
          data-step-state={stepState(2)}
          ref={stepTwoRef}
          tabIndex={-1}
        >
          <div className="connect-step-heading">
            <span className="connect-step-number" aria-hidden="true">
              {stepState(2) === "complete" ? "✓" : "2"}
            </span>
            <div>
              <span className="connect-step-status">{stepStatus(2)}</span>
              <p className="eyebrow">{copy.connect.stepAsk}</p>
              <h2 id="ask-heading">{copy.connect.askHeading}</h2>
            </div>
          </div>
          <div className="connect-ask-content">
            <p>{copy.connect.askText}</p>
            <div className="connect-prompt-row">
              <blockquote>{copy.connect.askPrompt}</blockquote>
              <button
                className="primary-button"
                type="button"
                onClick={() => void copyConnectionPrompt()}
              >
                {promptCopied ? copy.connect.copied : copy.connect.copyPrompt}
              </button>
              {copyError === "prompt" && (
                <p className="copy-error" role="alert">
                  {copy.connect.copyFailed}
                </p>
              )}
            </div>
          </div>
        </section>

        <section
          aria-current={stepState(3) === "active" ? "step" : undefined}
          aria-labelledby="connection-review-heading"
          className={`management-panel connect-step-card connection-review-panel is-${stepState(3)}`}
          data-step-state={stepState(3)}
          ref={stepThreeRef}
          tabIndex={-1}
        >
          <div className="connect-step-heading">
            <span className="connect-step-number" aria-hidden="true">
              {stepState(3) === "complete" ? "✓" : "3"}
            </span>
            <div>
              <span className="connect-step-status">{stepStatus(3)}</span>
              <p className="eyebrow">{copy.connect.stepApprove}</p>
              <h2 id="connection-review-heading">
                {copy.connect.pendingHeading}
              </h2>
            </div>
          </div>

          <form className="connection-code-form" onSubmit={submitCode}>
            <label htmlFor="connection-code">{copy.connect.codeLabel}</label>
            <div>
              <input
                aria-describedby="connection-code-help"
                autoComplete="one-time-code"
                id="connection-code"
                inputMode="text"
                maxLength={16}
                placeholder={copy.connect.codePlaceholder}
                required
                spellCheck={false}
                value={userCode}
                onChange={(event) => setUserCode(event.target.value)}
                onFocus={() => setActiveStep(3)}
              />
              <button className="secondary-button" type="submit">
                {copy.connect.continueToApproval}
              </button>
            </div>
            <small id="connection-code-help">{copy.connect.codeHelp}</small>
          </form>

          <aside className="connect-security">
            <strong>{copy.connect.securityHeading}</strong>
            <p>{copy.connect.securityText}</p>
          </aside>
        </section>
      </div>
    </div>
  );
}

export function AgentConnectionApprovalPanel({
  copy,
  fetchImplementation,
  locale,
  recoveryCodes = [],
}: AgentConnectionApprovalPanelProps) {
  const api = useMemo(
    () => new DashboardApi(fetchImplementation),
    [fetchImplementation],
  );
  const initialCode = useMemo(codeFromLocation, []);
  const [userCode, setUserCode] = useState(initialCode);
  const [connection, setConnection] = useState<ConnectionState>({
    kind: "idle",
  });
  const [decisionBusy, setDecisionBusy] = useState(false);
  const decisionInFlight = useRef(false);
  const initialLookupStarted = useRef(false);

  const formatDate = (value: string) => formatLocaleDate(locale, value);

  async function lookup(code: string) {
    decisionInFlight.current = false;
    setConnection({ kind: "loading" });
    try {
      const request = await api.getDeviceConnection(code);
      setUserCode(request.userCode);
      setConnection({ kind: "pending", request });
    } catch (error) {
      setConnection(decisionError(error));
    }
  }

  useEffect(() => {
    if (!initialCode || initialLookupStarted.current) return;
    initialLookupStarted.current = true;
    void lookup(initialCode);
  }, [api, initialCode]);

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void lookup(userCode);
  }

  async function decide(decision: "approve" | "deny") {
    if (connection.kind !== "pending" || decisionInFlight.current) return;
    decisionInFlight.current = true;
    setDecisionBusy(true);
    try {
      if (decision === "approve") {
        await api.approveDeviceConnection(
          connection.request.id,
          connection.request.userCode,
        );
        setConnection({ kind: "approved" });
      } else {
        await api.denyDeviceConnection(
          connection.request.id,
          connection.request.userCode,
        );
        setConnection({ kind: "denied" });
      }
      clearCodeFromLocation();
    } catch (error) {
      decisionInFlight.current = false;
      setConnection(decisionError(error));
    } finally {
      setDecisionBusy(false);
    }
  }

  return (
    <section className="login-view connection-approval-view" aria-live="polite">
      <div className="signal-card auth-card connection-approval-card">
        <div>
          <p className="eyebrow">{copy.connect.stepApprove}</p>
          <h1>{copy.connect.pendingHeading}</h1>
          <p>{copy.connect.pendingText}</p>
        </div>

        <RecoveryCodes codes={recoveryCodes} copy={copy} />

        <form className="connection-code-form" onSubmit={submitCode}>
          <label htmlFor="connection-approval-code">
            {copy.connect.codeLabel}
          </label>
          <div>
            <input
              aria-describedby="connection-approval-code-help"
              autoComplete="one-time-code"
              id="connection-approval-code"
              inputMode="text"
              maxLength={16}
              placeholder={copy.connect.codePlaceholder}
              required
              spellCheck={false}
              value={userCode}
              onChange={(event) => setUserCode(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={connection.kind === "loading" || decisionBusy}
              type="submit"
            >
              {copy.connect.lookup}
            </button>
          </div>
          <small id="connection-approval-code-help">
            {copy.connect.codeHelp}
          </small>
        </form>

        <div className="connection-state" aria-live="polite">
          {connection.kind === "loading" && (
            <p className="quiet-status">{copy.management.loading}</p>
          )}
          {connection.kind === "pending" && (
            <div className="pending-connection">
              <dl>
                <div>
                  <dt>{copy.connect.clientLabel}</dt>
                  <dd>{connection.request.label}</dd>
                </div>
                <div>
                  <dt>{copy.connect.codeLabel}</dt>
                  <dd dir="ltr">{connection.request.userCode}</dd>
                </div>
                <div>
                  <dt>{copy.connect.expires}</dt>
                  <dd>{formatDate(connection.request.expiresAt)}</dd>
                </div>
              </dl>
              <p className="quiet-status">{copy.connect.approveWarning}</p>
              <div className="connection-actions">
                <button
                  className="primary-button"
                  disabled={decisionBusy}
                  type="button"
                  onClick={() => void decide("approve")}
                >
                  {copy.connect.approve}
                </button>
                <button
                  className="danger-button"
                  disabled={decisionBusy}
                  type="button"
                  onClick={() => void decide("deny")}
                >
                  {copy.connect.deny}
                </button>
              </div>
            </div>
          )}
          {connection.kind === "approved" && (
            <div className="connection-result success-message" role="status">
              <strong>{copy.connect.approvedHeading}</strong>
              <p>{copy.connect.approvedText}</p>
            </div>
          )}
          {connection.kind === "denied" && (
            <div className="connection-result" role="status">
              <strong>{copy.connect.deniedHeading}</strong>
              <p>{copy.connect.deniedText}</p>
            </div>
          )}
          {connection.kind === "expired" && (
            <p className="error-banner" role="alert">
              {copy.connect.expired}
            </p>
          )}
          {connection.kind === "error" && (
            <p className="error-banner" role="alert">
              {copy.connect[connection.message]}
            </p>
          )}
        </div>

        <aside className="connect-security">
          <strong>{copy.connect.securityHeading}</strong>
          <p>{copy.connect.securityText}</p>
        </aside>
      </div>
    </section>
  );
}
