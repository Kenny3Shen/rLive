import { cn } from "@/lib/utils";

type SiteLogoProps = {
  siteId: string;
  className?: string;
};

/**
 * Small, local platform marks for the site switcher. Keeping them inline makes
 * the navigation dependable when the desktop client is offline and avoids
 * treating a remote favicon as product UI.
 */
export function SiteLogo({ siteId, className }: SiteLogoProps) {
  const svgClassName = cn("size-5 shrink-0", className);

  switch (siteId) {
    case "bilibili":
      return (
        <svg
          viewBox="0 0 48 48"
          className={svgClassName}
          aria-hidden="true"
        >
          <path
            d="m16 11-4-5m20 5 4-5M10 14h28a6 6 0 0 1 6 6v14a8 8 0 0 1-8 8H12a8 8 0 0 1-8-8V20a6 6 0 0 1 6-6Z"
            fill="#FB7299"
            stroke="#FB7299"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
          />
          <path
            d="M17 25v6m14-6v6m-14 0 4-2m10 2-4-2"
            fill="none"
            stroke="white"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
        </svg>
      );
    case "douyu":
      return (
        <svg
          viewBox="0 0 48 48"
          className={svgClassName}
          aria-hidden="true"
        >
          <path
            d="M7 25c4-9 12-14 22-14 6 0 10 2 14 6l-6 2 5 5-7 2c-4 8-12 12-22 10l4-5-10-1Z"
            fill="#FF5D23"
            stroke="#FF5D23"
            strokeLinejoin="round"
            strokeWidth="2"
          />
          <path d="m12 22-5-4 1 8" fill="#FF5D23" />
          <circle cx="30" cy="19" r="2.5" fill="white" />
          <path d="M23 29c3 2 7 2 10 0" fill="none" stroke="white" strokeLinecap="round" strokeWidth="2.5" />
        </svg>
      );
    case "huya":
      return (
        <svg
          viewBox="0 0 48 48"
          className={svgClassName}
          aria-hidden="true"
        >
          <path
            d="m12 12 8 3 4-7 4 7 8-3-1 10c4 5 3 13-2 18-5 5-13 5-18 0-5-5-6-13-2-18l-1-10Z"
            fill="#FF9A00"
            stroke="#FF9A00"
            strokeLinejoin="round"
            strokeWidth="2"
          />
          <path d="m18 24 4 2m8-2-4 2m-8 6 6 3 6-3" fill="none" stroke="white" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
          <path d="M15 18 20 21m13-3-5 3" fill="none" stroke="white" strokeLinecap="round" strokeWidth="2" />
        </svg>
      );
    case "douyin":
      return (
        <svg
          viewBox="0 0 48 48"
          className={svgClassName}
          aria-hidden="true"
        >
          <path d="M28 7v20.5a8 8 0 1 1-5-7.4V14c3.5 4.1 7.8 6.2 13 6.2v7c-3.1 0-5.8-.8-8-2.2V31a12 12 0 1 1-9-11.6V7h9Z" fill="#25F4EE" transform="translate(-2 1)" />
          <path d="M28 7v20.5a8 8 0 1 1-5-7.4V14c3.5 4.1 7.8 6.2 13 6.2v7c-3.1 0-5.8-.8-8-2.2V31a12 12 0 1 1-9-11.6V7h9Z" fill="#FE2C55" transform="translate(2 -1)" />
          <path d="M28 7v20.5a8 8 0 1 1-5-7.4V14c3.5 4.1 7.8 6.2 13 6.2v7c-3.1 0-5.8-.8-8-2.2V31a12 12 0 1 1-9-11.6V7h9Z" fill="currentColor" />
        </svg>
      );
    case "kuaishou":
      return (
        <svg
          viewBox="0 0 48 48"
          className={svgClassName}
          aria-hidden="true"
        >
          <rect x="5" y="8" width="38" height="32" rx="10" fill="#FF4906" />
          <circle cx="18" cy="20" r="4" fill="white" />
          <circle cx="30" cy="20" r="4" fill="white" />
          <circle cx="18" cy="31" r="4" fill="white" />
          <circle cx="30" cy="31" r="4" fill="white" />
        </svg>
      );
    default:
      return (
        <svg
          viewBox="0 0 48 48"
          className={svgClassName}
          aria-hidden="true"
        >
          <rect x="8" y="8" width="32" height="32" rx="10" fill="currentColor" opacity="0.75" />
          <path d="M17 24h14M24 17v14" fill="none" stroke="white" strokeLinecap="round" strokeWidth="3" />
        </svg>
      );
  }
}
