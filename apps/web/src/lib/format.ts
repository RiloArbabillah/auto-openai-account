import type { Job, Mailbox } from "../types";

export function jobTypeText(type?: string) {
  return type === "login"
    ? "Standard Login"
    : type === "codex_login"
      ? "Codex Auth Login"
      : type === "register_login"
        ? "Register + Standard Login"
        : type === "register_codex"
          ? "Register + Standard Login + Codex Auth Login"
          : "Register";
}

export function jobStatusText(status?: string) {
  return status === "running"
    ? "Running"
    : status === "finished"
      ? "Finished"
      : status === "stopped"
        ? "Stopped"
        : status === "failed"
          ? "Failed"
          : status || "-";
}

export function resultText(status?: string) {
  return status === "success"
    ? "Success"
    : status === "failed"
      ? "Failed"
      : status || "-";
}

export function formatDurationSeconds(durationMs: number) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function canExportJobTokens(job: Job) {
  return ["finished", "stopped"].includes(job.status);
}

export function formatFileDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function formatToken(token?: string) {
  if (!token) return "No token available";
  try {
    return JSON.stringify(JSON.parse(token), null, 2);
  } catch {
    return token;
  }
}

export function mailboxImportLine(m: Mailbox) {
  return `${m.email}----${m.password || ""}----${m.access_token || ""}----${m.client_id || ""}`;
}

export function isValidProxyURL(value: string) {
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}
