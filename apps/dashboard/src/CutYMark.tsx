import { useId } from "react";

export interface CutYMarkProps {
  className?: string;
}

export function CutYMark({ className }: CutYMarkProps) {
  const instanceId = useId().replaceAll(":", "");
  const maskId = `cut-y-mask-${instanceId}`;

  return (
    <svg
      aria-hidden={true}
      className={className}
      focusable="false"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="64"
        height="64"
      >
        <rect width="64" height="64" fill="white" />
        <path d="M14 25 30 9h10L21 34 14 25Z" fill="black" />
      </mask>
      <path
        d="M2 6h17l13 19L45 6h17L40 36v22H24V36L2 6Z"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
