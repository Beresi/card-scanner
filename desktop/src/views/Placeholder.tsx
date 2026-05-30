/**
 * Placeholder — stub view for nav entries not yet implemented.
 * Renders a centered "coming soon" message using the feed-empty class.
 */

import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';

export interface PlaceholderProps {
  title: string;
  icon?: IconName;
}

export function Placeholder({ title, icon = 'radar' }: PlaceholderProps) {
  return (
    <div style={{ padding: 'var(--pad)', maxWidth: 1480, margin: '0 auto', height: '100%' }}>
      <div className="feed-list">
        <div className="feed-empty">
          <Icon name={icon} size={32} />
          <p className="cb-eyebrow">{title}</p>
          <p>Coming soon.</p>
        </div>
      </div>
    </div>
  );
}
