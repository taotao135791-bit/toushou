interface LogoProps {
  size?: number
  className?: string
}

/**
 * 投手 brand mark: three ascending bars — performance climbing with each
 * optimization pass. Pure geometry (no font, no enclosing square), so it
 * scales from the 14px sidebar row to the 1024px app icon without going mushy.
 */
export default function Logo({ size = 20, className }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="投手"
    >
      {/* three ascending bars — the growth curve of a well-run campaign */}
      <rect x="4.4" y="13.0" width="3.4" height="6.0" rx="1.3" fill="rgb(var(--accent))" />
      <rect x="10.3" y="9.2" width="3.4" height="9.8" rx="1.3" fill="rgb(var(--accent))" />
      <rect x="16.2" y="5.0" width="3.4" height="14.0" rx="1.3" fill="rgb(var(--accent-deep))" />
    </svg>
  )
}
