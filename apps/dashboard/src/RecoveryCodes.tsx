import type { LocaleDocument } from "./localization.js";

interface RecoveryCodesProps {
  codes: string[];
  copy: LocaleDocument;
}

export function RecoveryCodes({ codes, copy }: RecoveryCodesProps) {
  if (codes.length === 0) {
    return null;
  }
  return (
    <div className="recovery-codes">
      <strong>{copy.auth.recoveryCodesHeading}</strong>
      <p>{copy.auth.recoveryCodesWarning}</p>
      <ul>
        {codes.map((code) => (
          <li key={code}>
            <code dir="ltr">{code}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
