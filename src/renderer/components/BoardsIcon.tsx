import type { SVGProps } from 'react'

export default function BoardsIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="6.5" cy="6.5" r="3.5" />
      <path d="M17.5 3v7m-3.5-3.5h7" />
      <circle cx="6.5" cy="17.5" r="3.5" />
      <circle cx="17.5" cy="17.5" r="3.5" />
    </svg>
  )
}
