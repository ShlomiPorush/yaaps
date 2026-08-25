import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  localeDirection,
  localeDocuments,
  preferredLocale,
  type Locale,
} from "./localization.js";
import {
  browserCsrfToken,
  DashboardRequestError,
  readJson,
} from "./dashboard-api.js";
import { CutYMark } from "./CutYMark.js";
import { DocumentationPage } from "./DocumentationPage.js";
import {
  AgentConnectionApprovalPanel,
  AgentConnectPanel,
} from "./AgentConnectPanel.js";
import { ManagementDashboard } from "./ManagementDashboard.js";

type Theme = "dark" | "light";

const PROJECT_GITHUB_URL = "https://github.com/ShlomiPorush/yaaps";

export interface AppProps {
  fetchImplementation?: typeof fetch;
  initialLocale?: Locale;
  initialTheme?: Theme;
  startAuthenticationImplementation?: typeof startAuthentication;
  startRegistrationImplementation?: typeof startRegistration;
}

interface SignedInUser {
  id: string;
  role: "admin" | "user";
}

type AuthenticationView =
  "bootstrap" | "loading" | "register" | "signed-in" | "sign-in";

const protectedDashboardPaths = new Set([
  "/dashboard",
  "/dashboard/admin",
  "/dashboard/connect/approve",
  "/dashboard/settings",
]);

export function safeDashboardReturnTarget(value: string | null): string {
  if (!value) {
    return "/dashboard";
  }

  try {
    const target = new URL(value, window.location.origin);
    if (
      target.origin !== window.location.origin ||
      !protectedDashboardPaths.has(target.pathname)
    ) {
      return "/dashboard";
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return "/dashboard";
  }
}

function loginPath(returnTarget: string): string {
  const parameters = new URLSearchParams({ returnTo: returnTarget });
  return `/login?${parameters.toString()}`;
}

type AuthenticationErrorKind = "conflict" | "generic" | "rateLimited";

function authenticationErrorKind(error: unknown): AuthenticationErrorKind {
  if (error instanceof DashboardRequestError) {
    if (error.code === "AUTH_CONFLICT") {
      return "conflict";
    }
    if (error.code === "RATE_LIMITED") {
      return "rateLimited";
    }
  }
  return "generic";
}

const SIGNED_IN_HINT_KEY = "yaaps-signed-in";
const SIGNED_IN_ROLE_KEY = "yaaps-signed-in-role";

function rememberSignedIn(role: "admin" | "user" | null): void {
  if (role === null) {
    window.localStorage.removeItem(SIGNED_IN_HINT_KEY);
    window.localStorage.removeItem(SIGNED_IN_ROLE_KEY);
    return;
  }
  window.localStorage.setItem(SIGNED_IN_HINT_KEY, "true");
  window.localStorage.setItem(SIGNED_IN_ROLE_KEY, role);
}

function preferredTheme(): Theme {
  const stored = window.localStorage.getItem("yaaps-theme");
  if (stored === "dark" || stored === "light") {
    return stored;
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function initialPreferredLocale(): Locale {
  const languages =
    navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return preferredLocale(
    languages,
    window.localStorage.getItem("yaaps-locale"),
  );
}

export function App({
  fetchImplementation = fetch,
  initialLocale,
  initialTheme,
  startAuthenticationImplementation = startAuthentication,
  startRegistrationImplementation = startRegistration,
}: AppProps) {
  const [locale, setLocale] = useState<Locale>(
    initialLocale ?? initialPreferredLocale,
  );
  const [theme, setTheme] = useState<Theme>(initialTheme ?? preferredTheme);
  const [authenticationView, setAuthenticationView] =
    useState<AuthenticationView>("loading");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [authenticationError, setAuthenticationError] =
    useState<AuthenticationErrorKind | null>(null);
  const [passkeyAdded, setPasskeyAdded] = useState(false);
  const [openRegistration, setOpenRegistration] = useState(false);
  // Presentation-only hint so a refresh renders the signed-in header
  // immediately instead of flashing the signed-out variant while /auth/session
  // is in flight; the server session check remains the source of truth.
  const [signedInHint] = useState(
    () => window.localStorage.getItem(SIGNED_IN_HINT_KEY) === "true",
  );
  const [signedInRoleHint] = useState(() =>
    window.localStorage.getItem(SIGNED_IN_ROLE_KEY),
  );
  const skipAuthenticationCheck = useRef(false);
  const [applicationLocation, setApplicationLocation] = useState(() => {
    const currentPath = `${window.location.pathname}${window.location.search}`;
    const parameters = new URLSearchParams(window.location.search);
    if (window.location.pathname === "/" && parameters.has("invite")) {
      const normalizedPath = `/login${window.location.search}`;
      window.history.replaceState(null, "", normalizedPath);
      return normalizedPath;
    }
    return currentPath;
  });
  const copy = localeDocuments[locale];
  const direction = localeDirection(locale);
  const currentUrl = new URL(applicationLocation, window.location.origin);
  const invitationToken = currentUrl.searchParams.get("invite");
  const pathname = currentUrl.pathname;
  const isDocumentationPage = pathname === "/docs";
  const isConnectPage = pathname === "/connect";
  const isConnectionApprovalPage = pathname === "/dashboard/connect/approve";
  const isLoginPage = pathname === "/login";
  const isProtectedDashboardPage = protectedDashboardPaths.has(pathname);
  const returnTarget = safeDashboardReturnTarget(
    isLoginPage ? currentUrl.searchParams.get("returnTo") : null,
  );
  const managementView =
    pathname === "/dashboard/settings"
      ? "settings"
      : pathname === "/dashboard/admin"
        ? "admin"
        : "reports";
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    const titles = copy.titles;
    document.title =
      pathname === "/login"
        ? titles.login
        : pathname === "/dashboard/settings"
          ? titles.settings
          : pathname === "/dashboard/admin"
            ? titles.admin
            : pathname === "/dashboard/connect/approve"
              ? titles.approve
              : pathname === "/connect"
                ? titles.connect
                : pathname === "/docs"
                  ? titles.docs
                  : pathname === "/dashboard"
                    ? titles.dashboard
                    : titles.landing;
  }, [copy, direction, locale, pathname]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("yaaps-theme", theme);
  }, [theme]);

  useEffect(() => {
    const synchronizeLocation = () => {
      setApplicationLocation(
        `${window.location.pathname}${window.location.search}`,
      );
    };
    window.addEventListener("popstate", synchronizeLocation);
    return () => window.removeEventListener("popstate", synchronizeLocation);
  }, []);

  useEffect(() => {
    if (skipAuthenticationCheck.current) {
      skipAuthenticationCheck.current = false;
      return;
    }
    let active = true;
    const redirectToLogin = () => {
      const protectedTarget = `${pathname}${currentUrl.search}`;
      const destination = loginPath(protectedTarget);
      skipAuthenticationCheck.current = true;
      window.history.replaceState(null, "", destination);
      setApplicationLocation(destination);
    };
    void (async () => {
      try {
        const sessionResponse = await fetchImplementation("/auth/session", {
          credentials: "same-origin",
        });
        if (sessionResponse.ok) {
          const session = await readJson<{ user: SignedInUser }>(
            sessionResponse,
          );
          if (active) {
            if (isLoginPage) {
              skipAuthenticationCheck.current = true;
              window.history.replaceState(null, "", returnTarget);
              setApplicationLocation(returnTarget);
            }
            setUser(session.user);
            rememberSignedIn(session.user.role);
            setAuthenticationView("signed-in");
          }
          return;
        }
        if (!isLoginPage && !isProtectedDashboardPage) {
          if (active) {
            setUser(null);
            rememberSignedIn(null);
            setAuthenticationView("sign-in");
          }
          return;
        }
        const stateResponse = await fetchImplementation("/auth/state", {
          credentials: "same-origin",
        });
        const state = await readJson<{
          initialized: boolean;
          openRegistration?: boolean;
        }>(stateResponse);
        if (active) {
          setOpenRegistration(state.openRegistration ?? false);
          rememberSignedIn(null);
          if (isProtectedDashboardPage) {
            redirectToLogin();
          }
          setAuthenticationView(
            invitationToken || !state.initialized ? "bootstrap" : "sign-in",
          );
        }
      } catch {
        if (active) {
          if (isProtectedDashboardPage) {
            redirectToLogin();
          }
          setAuthenticationView("sign-in");
          if (isLoginPage || isProtectedDashboardPage) {
            setAuthenticationError("generic");
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    currentUrl.search,
    fetchImplementation,
    invitationToken,
    isLoginPage,
    isProtectedDashboardPage,
    pathname,
    returnTarget,
  ]);

  function navigateWithinApplication(target: string) {
    skipAuthenticationCheck.current = true;
    window.history.replaceState(null, "", target);
    setApplicationLocation(target);
  }

  async function postJson<T>(
    url: string,
    body?: unknown,
    includeCsrf = false,
  ): Promise<T> {
    const csrf = includeCsrf ? browserCsrfToken() : undefined;
    const response = await fetchImplementation(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      method: "POST",
    });
    if (response.status === 204) {
      return undefined as T;
    }
    return readJson<T>(response);
  }

  async function registerPasskey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setAuthenticationError(null);
    try {
      const ceremony =
        authenticationView === "register"
          ? "register"
          : invitationToken
            ? "invitations"
            : "bootstrap";
      const requestBody =
        ceremony === "register"
          ? { displayName }
          : invitationToken
            ? { displayName, token: invitationToken }
            : { displayName, secret: bootstrapSecret };
      const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
        `/auth/${ceremony}/options`,
        requestBody,
      );
      const response = await startRegistrationImplementation({
        optionsJSON: options,
      });
      const completed = await postJson<{
        recoveryCodes?: string[];
        user: SignedInUser;
      }>(`/auth/${ceremony}/verify`, response);
      const issuedRecoveryCodes = completed.recoveryCodes ?? [];
      // Recovery codes are shown exactly once, and only the reports view and
      // the connection-approval page render them; never land on a destination
      // (settings/admin) that would silently drop them.
      const targetDropsRecoveryCodes =
        returnTarget.startsWith("/dashboard/settings") ||
        returnTarget.startsWith("/dashboard/admin");
      navigateWithinApplication(
        issuedRecoveryCodes.length > 0 && targetDropsRecoveryCodes
          ? "/dashboard"
          : returnTarget,
      );
      setUser(completed.user);
      rememberSignedIn(completed.user.role);
      setRecoveryCodes(issuedRecoveryCodes);
      setBootstrapSecret("");
      setAuthenticationView("signed-in");
    } catch (error) {
      setAuthenticationError(authenticationErrorKind(error));
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPasskey() {
    setBusy(true);
    setAuthenticationError(null);
    try {
      const options = await postJson<PublicKeyCredentialRequestOptionsJSON>(
        "/auth/sign-in/options",
      );
      const response = await startAuthenticationImplementation({
        optionsJSON: options,
      });
      const completed = await postJson<{ user: SignedInUser }>(
        "/auth/sign-in/verify",
        response,
      );
      navigateWithinApplication(returnTarget);
      setUser(completed.user);
      rememberSignedIn(completed.user.role);
      setAuthenticationView("signed-in");
    } catch (error) {
      setAuthenticationError(authenticationErrorKind(error));
    } finally {
      setBusy(false);
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setAuthenticationError(null);
    try {
      const completed = await postJson<{ user: SignedInUser }>(
        "/auth/recovery",
        { code: recoveryCode },
      );
      setRecoveryCode("");
      navigateWithinApplication(returnTarget);
      setUser(completed.user);
      rememberSignedIn(completed.user.role);
      setAuthenticationView("signed-in");
    } catch (error) {
      setAuthenticationError(authenticationErrorKind(error));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setBusy(true);
    setAuthenticationError(null);
    setPasskeyAdded(false);
    try {
      const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
        "/auth/passkeys/options",
        undefined,
        true,
      );
      const response = await startRegistrationImplementation({
        optionsJSON: options,
      });
      await postJson("/auth/passkeys/verify", response, true);
      setPasskeyAdded(true);
    } catch (error) {
      setAuthenticationError(authenticationErrorKind(error));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setAuthenticationError(null);
    try {
      await postJson("/auth/sign-out", undefined, true);
      navigateWithinApplication("/login");
      setUser(null);
      rememberSignedIn(null);
      setRecoveryCodes([]);
      setAuthenticationView("sign-in");
    } catch (error) {
      setAuthenticationError(authenticationErrorKind(error));
    } finally {
      setBusy(false);
    }
  }

  const showSignedInHeader =
    authenticationView === "signed-in" ||
    (authenticationView === "loading" && signedInHint);
  const showAdminNavigation =
    authenticationView === "signed-in"
      ? user?.role === "admin"
      : showSignedInHeader && signedInRoleHint === "admin";

  const authenticationPanel = (
    <section className="login-view" aria-live="polite">
      <div className="signal-card auth-card">
        {authenticationView === "loading" && (
          <p className="auth-message">{copy.auth.loading}</p>
        )}

        {authenticationView === "bootstrap" && (
          <form className="auth-stack" onSubmit={registerPasskey}>
            <p className="eyebrow">
              {invitationToken
                ? copy.auth.invitationEyebrow
                : copy.auth.bootstrapEyebrow}
            </p>
            <h1>
              {invitationToken
                ? copy.auth.invitationHeading
                : copy.auth.bootstrapHeading}
            </h1>
            <label>
              <span>{copy.auth.displayName}</span>
              <input
                required
                autoComplete="name"
                maxLength={100}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            {!invitationToken && (
              <label>
                <span>{copy.auth.bootstrapSecret}</span>
                <input
                  required
                  autoComplete="off"
                  type="password"
                  value={bootstrapSecret}
                  onChange={(event) => setBootstrapSecret(event.target.value)}
                />
              </label>
            )}
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? copy.auth.working : copy.auth.createPasskey}
            </button>
          </form>
        )}

        {authenticationView === "register" && (
          <form className="auth-stack" onSubmit={registerPasskey}>
            <p className="eyebrow">{copy.auth.registerEyebrow}</p>
            <h1>{copy.auth.registerHeading}</h1>
            <label>
              <span>{copy.auth.displayName}</span>
              <input
                required
                autoComplete="name"
                maxLength={100}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy} type="submit">
              {busy ? copy.auth.working : copy.auth.createPasskey}
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setAuthenticationError(null);
                setAuthenticationView("sign-in");
              }}
            >
              {copy.auth.backToSignIn}
            </button>
          </form>
        )}

        {authenticationView === "sign-in" && (
          <div className="auth-stack">
            <p className="eyebrow">{copy.auth.signInEyebrow}</p>
            <h1>{copy.auth.signInHeading}</h1>
            <button
              className="primary-button"
              disabled={busy}
              type="button"
              onClick={() => void signInWithPasskey()}
            >
              {busy ? copy.auth.working : copy.auth.signInWithPasskey}
            </button>
            <div className="auth-divider">
              <span>{copy.auth.orRecovery}</span>
            </div>
            <form className="auth-stack compact" onSubmit={recover}>
              <label>
                <span>{copy.auth.recoveryCode}</span>
                <input
                  required
                  autoComplete="one-time-code"
                  className="recovery-code-input"
                  dir="ltr"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                disabled={busy}
                type="submit"
              >
                {copy.auth.useRecoveryCode}
              </button>
            </form>
          </div>
        )}

        {authenticationError && (
          <p className="error-message" role="alert">
            {authenticationError === "conflict"
              ? copy.auth.errorConflict
              : authenticationError === "rateLimited"
                ? copy.auth.errorRateLimited
                : copy.auth.error}
          </p>
        )}
      </div>

      {authenticationView === "sign-in" && openRegistration && (
        <div className="signal-card auth-card register-card">
          <p className="eyebrow">{copy.auth.registerEyebrow}</p>
          <h2>{copy.auth.createAccountHeading}</h2>
          <p>{copy.auth.createAccountText}</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              setAuthenticationError(null);
              setAuthenticationView("register");
            }}
          >
            {copy.auth.createAccount}
          </button>
        </div>
      )}
    </section>
  );

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label={copy.product.name}>
          <span className="brand-mark" aria-hidden="true">
            <CutYMark />
          </span>
          <span>
            <strong>{copy.product.name}</strong>
            <small>{copy.product.tagline}</small>
          </span>
        </a>

        <nav className="site-nav" aria-label={copy.navigation.ariaLabel}>
          <a
            className="connect-nav-link"
            aria-current={
              isConnectPage || isConnectionApprovalPage ? "page" : undefined
            }
            href="/connect"
          >
            {copy.navigation.connect}
          </a>
          <a
            aria-current={isDocumentationPage ? "page" : undefined}
            href="/docs"
          >
            {copy.navigation.docs}
          </a>
          <a
            aria-current={pathname === "/dashboard" ? "page" : undefined}
            href="/dashboard"
          >
            {copy.navigation.dashboard}
          </a>
          {showSignedInHeader && (
            <a
              aria-current={
                pathname === "/dashboard/settings" ? "page" : undefined
              }
              href="/dashboard/settings"
            >
              {copy.navigation.settings}
            </a>
          )}
          {showAdminNavigation && (
            <a
              aria-current={
                pathname === "/dashboard/admin" ? "page" : undefined
              }
              href="/dashboard/admin"
            >
              {copy.navigation.administration}
            </a>
          )}
        </nav>

        <div className="header-actions">
          {showSignedInHeader && (
            <button
              className="utility-button"
              disabled={busy}
              type="button"
              onClick={() => void signOut()}
            >
              {copy.auth.signOut}
            </button>
          )}
          <button
            className="utility-button"
            type="button"
            aria-label={copy.actions.switchLanguage}
            onClick={() => {
              const nextLocale = locale === "en" ? "he" : "en";
              window.localStorage.setItem("yaaps-locale", nextLocale);
              setLocale(nextLocale);
            }}
          >
            {locale === "en" ? "HE" : "EN"}
          </button>
          <button
            className="utility-button theme-button"
            type="button"
            aria-label={copy.actions.switchTheme}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            <span className="theme-dot" aria-hidden="true" />
            {theme === "light" ? copy.theme.dark : copy.theme.light}
          </button>
        </div>
      </header>

      <main
        className={
          isDocumentationPage
            ? "documentation-main"
            : isConnectPage
              ? "management-main"
              : isLoginPage ||
                  isConnectionApprovalPage ||
                  (isProtectedDashboardPage &&
                    authenticationView !== "signed-in")
                ? "login-main"
                : isProtectedDashboardPage && authenticationView === "signed-in"
                  ? "management-main"
                  : "landing-main"
        }
      >
        {isDocumentationPage ? (
          <DocumentationPage copy={copy} />
        ) : isConnectPage ? (
          <AgentConnectPanel copy={copy} />
        ) : isLoginPage ||
          (isProtectedDashboardPage && authenticationView !== "signed-in") ? (
          authenticationPanel
        ) : isConnectionApprovalPage && authenticationView === "signed-in" ? (
          <AgentConnectionApprovalPanel
            copy={copy}
            fetchImplementation={fetchImplementation}
            locale={locale}
            recoveryCodes={recoveryCodes}
          />
        ) : isProtectedDashboardPage &&
          authenticationView === "signed-in" &&
          user ? (
          <ManagementDashboard
            actionError={authenticationError !== null}
            busy={busy}
            copy={copy}
            fetchImplementation={fetchImplementation}
            locale={locale}
            onAddPasskey={() => void addPasskey()}
            passkeyAdded={passkeyAdded}
            recoveryCodes={recoveryCodes}
            role={user.role}
            userId={user.id}
            view={managementView}
          />
        ) : (
          <>
            <section
              className="landing-lead"
              aria-labelledby="foundation-heading"
            >
              <p className="dateline">
                <span className="dateline-flag">{copy.status.label}</span>
                <span>{copy.dashboard.eyebrow}</span>
                <span className="dateline-issue">
                  <bdi dir="ltr">YAAPS</bdi>: {copy.product.tagline}
                </span>
              </p>
              <h1 id="foundation-heading">{copy.dashboard.heading}</h1>
              <div className="landing-lede">
                <div>
                  <p className="intro">{copy.dashboard.intro}</p>
                  <div className="hero-actions">
                    <a className="primary-link" href="/connect">
                      {copy.dashboard.primaryAction}
                    </a>
                    <a className="secondary-link" href="/dashboard">
                      {copy.dashboard.secondaryAction}
                    </a>
                  </div>
                  {authenticationView !== "signed-in" && (
                    <p className="availability-note">
                      {copy.dashboard.unavailable}
                    </p>
                  )}
                  <ol className="landing-steps">
                    {copy.dashboard.statusItems.map((item, index) => (
                      <li key={item}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        {item}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>

            <div className="terminal-strip">
              <small>{copy.dashboard.terminalLabel}</small>
              <code>
                <bdi dir="ltr">
                  <span>&gt;</span>
                </bdi>{" "}
                {copy.dashboard.terminalPrompt}
              </code>
              <code className="terminal-strip-result">
                <span>{copy.dashboard.terminalResponseLabel}</span>{" "}
                <bdi dir="ltr">{copy.dashboard.terminalResult}</bdi>
              </code>
            </div>

            <section
              className="feature-index"
              aria-label={copy.dashboard.statusHeading}
            >
              {copy.dashboard.featureTitles.map((title, index) => (
                <article key={title}>
                  <span className="feature-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h2>{title}</h2>
                  <p>{copy.dashboard.featureTexts[index]}</p>
                </article>
              ))}
            </section>

            <section
              className="security-banner"
              aria-labelledby="security-heading"
            >
              <span className="security-glyph" aria-hidden="true">
                Y/
              </span>
              <div>
                <p className="eyebrow">{copy.dashboard.securityEyebrow}</p>
                <h2 id="security-heading">{copy.dashboard.securityHeading}</h2>
                <p>{copy.dashboard.securityText}</p>
              </div>
              <div className="retention-note">
                <strong>{copy.dashboard.nextHeading}</strong>
                <span>{copy.dashboard.nextText}</span>
              </div>
            </section>
          </>
        )}
      </main>

      <footer>
        <span>{copy.product.footer}</span>
        <span className="footer-links">
          <a className="footer-github-link" href={PROJECT_GITHUB_URL}>
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.2.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.2 1.2A11 11 0 0 1 12 6.3c1 0 2 .1 2.9.4C17.1 5.2 18.1 5.5 18.1 5.5c.6 1.6.2 2.9.1 3.2.8.8 1.2 1.8 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v2.8c0 .4.2.7.8.6A11.5 11.5 0 0 0 12 .7Z" />
            </svg>
            <span>GitHub</span>
          </a>
        </span>
      </footer>
    </div>
  );
}
