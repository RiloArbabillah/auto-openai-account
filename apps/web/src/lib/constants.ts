import type { Stats } from "../types";

export const emptyStats: Stats = { mailboxes: {}, jobs: {} };
export const appName = "Auto OpenAI Account";
export const defaultPassword = "Mima1234567890.";
export const nav: Array<{ path: string; label: string; end?: boolean }> = [
  { path: "/", label: "Overview", end: true },
  { path: "/mailboxes", label: "Mailboxes" },
  { path: "/jobs", label: "Jobs" },
  { path: "/proxies", label: "Proxies" },
  { path: "/email", label: "Email Settings" },
  { path: "/sms", label: "SMS Settings" },
  { path: "/plugins", label: "Plugins" },
];
export const routeTitles: Record<string, string> = {
  "/": "Overview",
  "/mailboxes": "Mailboxes",
  "/jobs": "Jobs",
  "/proxies": "Proxies",
  "/email": "Email Settings",
  "/sms": "SMS Settings",
  "/plugins": "Plugins",
};
