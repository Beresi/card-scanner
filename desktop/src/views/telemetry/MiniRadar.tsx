/**
 * MiniRadar — pure presentational mini radar widget.
 *
 * Emits the .mradar markup with rings, crosshair, sweep cone, and blip dots.
 * All animation (sweep rotation, blip pulse) is owned by effects.css — zero JS
 * timers or motion here.
 *
 * The .is-live modifier on .mradar triggers a faster sweep animation defined in
 * effects.css whenever a scan is in progress.
 *
 * Blips are rendered at static positions matching the handoff reference; their
 * fade-in/out animation is pure CSS.
 *
 * Props:
 *   active    — when true, adds .is-live to speed up the sweep
 *   className — passed to the root element
 */

export interface MiniRadarProps {
  active?: boolean;
  className?: string;
}

export function MiniRadar({ active = false, className }: MiniRadarProps) {
  const rootClass = ['mradar', active ? 'is-live' : undefined, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} aria-hidden="true">
      {/* Two concentric ring borders */}
      <span className="mradar-ring" />
      <span className="mradar-ring" />

      {/* Crosshair hairlines */}
      <span className="mradar-cross-h" />
      <span className="mradar-cross-v" />

      {/* Rotating conic-gradient sweep cone — CSS animates this */}
      <span className="mradar-sweep" />

      {/* Ambient contact blips — staggered CSS animation */}
      <span
        className="mradar-blip"
        style={{ left: '68%', top: '38%', animationDelay: '0s' }}
      />
      <span
        className="mradar-blip"
        style={{ left: '34%', top: '62%', animationDelay: '1.3s' }}
      />
      <span
        className="mradar-blip"
        style={{ left: '58%', top: '70%', animationDelay: '2.4s' }}
      />
    </div>
  );
}
