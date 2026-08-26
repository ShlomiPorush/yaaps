import { useState } from "react";

import {
  formatDate,
  type Locale,
  type LocaleDocument,
} from "./localization.js";
import { CutYMark } from "./CutYMark.js";

const PUBLISHING_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1000;
const YAAPS_SKILL_TAG = "$yaaps";

interface LandingPublishingIllustrationProps {
  copy: LocaleDocument;
  locale: Locale;
}

export function LandingPublishingIllustration({
  copy,
  locale,
}: LandingPublishingIllustrationProps) {
  const [expiresAt] = useState(
    () => new Date(Date.now() + PUBLISHING_WINDOW_MILLISECONDS),
  );

  return (
    <section
      className="publishing-illustration"
      aria-labelledby="publishing-flow-heading"
    >
      <ol className="publishing-chat">
        <li className="publishing-message publishing-message-user">
          <small>{copy.dashboard.terminalLabel}</small>
          <div className="publishing-bubble publishing-request-bubble">
            <p className="publishing-request">
              <span>{copy.dashboard.terminalPromptBeforeSkill}</span>{" "}
              <strong>
                <bdi dir="ltr">{YAAPS_SKILL_TAG}</bdi>
              </strong>{" "}
              <span>{copy.dashboard.terminalPromptAfterSkill}</span>
            </p>
          </div>
        </li>

        <li className="publishing-processing">
          <span className="publishing-processing-mark" aria-hidden="true">
            <CutYMark />
          </span>
          <strong>{copy.product.name}</strong>
          <span className="publishing-processing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </li>

        <li className="publishing-message publishing-message-agent">
          <small>{copy.dashboard.terminalResponseLabel}</small>
          <div className="publishing-bubble publishing-response-bubble">
            <p className="publishing-success">
              {copy.dashboard.terminalSuccess}
            </p>
            <div className="publishing-link-block">
              <strong>{copy.dashboard.terminalOpenReport}</strong>
              <bdi className="publishing-share-link" dir="ltr">
                {copy.dashboard.terminalResult}
              </bdi>
            </div>
            <p className="publishing-expiry">
              <span>{copy.dashboard.terminalExpiresAt} </span>
              <time dateTime={expiresAt.toISOString()}>
                {formatDate(locale, expiresAt.toISOString())}
              </time>
            </p>
          </div>
        </li>
      </ol>
    </section>
  );
}
