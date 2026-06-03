/**
 * Icon — inline SVG icon set.
 *
 * Emits:  cb-ico  (always, from handoff ui.css — flags for design-agent below)
 *
 * All paths use currentColor stroke + fill="none", 1.6px stroke, round
 * line-cap/join — matches the handoff Icon component conventions exactly.
 * Default size is 16px.
 *
 * Supported names (aliases listed after /):
 *   feed, radar, watch, gear, pulse
 *   bolt / priority
 *   ext / buy / external
 *   x / dismiss / close
 *   eye / seen
 *   plus / add
 *   search
 *   send
 *   check
 *   alert
 *   card
 *   layers
 *   chevron / chevron-right
 *   cart
 *   trash
 *
 * The `name` prop accepts both the canonical name and its aliases.
 * Unknown names render null (no error) so callers can pass dynamic names safely.
 */
import type { SVGAttributes } from 'react';

export type IconName =
  | 'feed'
  | 'radar'
  | 'watch'
  | 'gear'
  | 'pulse'
  | 'bolt'
  | 'priority'
  | 'ext'
  | 'buy'
  | 'external'
  | 'x'
  | 'dismiss'
  | 'close'
  | 'eye'
  | 'seen'
  | 'plus'
  | 'add'
  | 'search'
  | 'send'
  | 'check'
  | 'alert'
  | 'card'
  | 'layers'
  | 'chevron'
  | 'chevron-right'
  | 'cart'
  | 'trash';

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Pass through any SVG attribute (aria-hidden, aria-label, etc.). */
  svgProps?: SVGAttributes<SVGElement>;
}

// Canonical SVG path content for each icon.
// Paths are the exact handoff paths from components.jsx where available.
type PathFn = () => React.ReactNode;

const PATHS: Record<string, PathFn> = {
  feed:    () => <path d="M4 6h16M4 12h16M4 18h10" />,
  radar:   () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l6-4" />
    </>
  ),
  watch:   () => (
    <>
      <path d="M4 5h16v6c0 5-4 7-8 8-4-1-8-3-8-8V5z" />
      <path d="M9 11l2 2 4-4" />
    </>
  ),
  gear:    () => (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  pulse:   () => <path d="M3 12h4l2-6 4 12 2-6h6" />,
  bolt:    () => <path d="M13 3L5 13h6l-1 8 8-12h-6z" />,
  ext:     () => (
    <>
      <path d="M14 5h5v5M19 5l-8 8" />
      <path d="M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </>
  ),
  x:       () => <path d="M6 6l12 12M18 6L6 18" />,
  eye:     () => (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  plus:    () => <path d="M12 5v14M5 12h14" />,
  search:  () => (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4-4" />
    </>
  ),
  send:    () => (
    <>
      <path d="M21 3L3 11l7 2 2 7 9-17z" />
      <path d="M10 13l5-5" />
    </>
  ),
  check:   () => <path d="M4 12l5 5L20 6" />,
  alert:   () => (
    <>
      <path d="M12 4l9 16H3L12 4z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  card:    () => (
    <>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M8 7h6M8 11h8" />
    </>
  ),
  layers:  () => (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  chevron: () => <path d="M9 6l6 6-6 6" />,
  cart:    () => (
    <>
      <path d="M6 2H4a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h1l1.5 9h9l1.5-9H8" />
      <circle cx="9" cy="19" r="1.5" />
      <circle cx="16" cy="19" r="1.5" />
    </>
  ),
  trash:   () => (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
};

// Alias map: alternate name → canonical name
const ALIAS: Partial<Record<IconName, string>> = {
  priority:      'bolt',
  buy:           'ext',
  external:      'ext',
  dismiss:       'x',
  close:         'x',
  seen:          'eye',
  add:           'plus',
  'chevron-right': 'chevron',
};

export function Icon({ name, size = 16, className, svgProps }: IconProps) {
  const canonical = ALIAS[name] ?? name;
  const pathFn = PATHS[canonical];
  if (!pathFn) return null;

  const rootClass = ['cb-ico', className].filter(Boolean).join(' ');

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={rootClass}
      aria-hidden="true"
      {...svgProps}
    >
      {pathFn()}
    </svg>
  );
}
