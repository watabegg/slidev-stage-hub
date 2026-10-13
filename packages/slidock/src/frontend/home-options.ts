export interface HubHomeLink {
  label: string;
  href: string;
}

export interface HubHomeOptions {
  title?: string;
  /** Opt in to a separate title/description banner below the navbar. */
  hero?: boolean;
  description?: string;
  /** Set false to omit the logo, or provide your own image URL. */
  logo?: string | false;
  links?: HubHomeLink[];
  footer?: string;
  categoryLabels?: Record<string, string>;
}
