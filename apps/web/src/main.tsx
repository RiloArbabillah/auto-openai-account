import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { CreateTaskModal } from "./components/CreateTaskModal/CreateTaskModal";
import { MailboxDetailModal } from "./components/MailboxDetailModal/MailboxDetailModal";
import { Toast } from "./components/Toast/Toast";
import { TokenExportConfirmModal } from "./components/TokenExportConfirmModal/TokenExportConfirmModal";
import { api, normalizeSettingsPayload } from "./lib/api";
import { appName, emptyStats, nav, routeTitles } from "./lib/constants";
import { canExportJobTokens, downloadJsonFile, formatFileDate } from "./lib/format";
import { JobsPage } from "./pages/JobsPage/JobsPage";
import { MailboxesPage } from "./pages/MailboxesPage/MailboxesPage";
import { Overview } from "./pages/Overview/Overview";
import { PluginsPage } from "./pages/PluginsPage/PluginsPage";
import { ProxyPoolPage } from "./pages/ProxyPoolPage/ProxyPoolPage";
import { SmsSettingsPage } from "./pages/SmsSettingsPage/SmsSettingsPage";
import type { Job, JobTokenExportItem, Mailbox, MailboxUpdate, RuntimeLog, SettingsPayload, Stats, ToastState, TokenExportConfirm } from "./types";
import "./styles.css";
import styles from "./App.module.css";

type ThemePreference = "system" | "light" | "dark";

const themeOptions: Array<{
  value: ThemePreference;
  label: string;
  icon: string;
  title: string;
}> = [
  { value: "system", label: "System", icon: "A", title: "Switch to light mode" },
  { value: "light", label: "Light", icon: "L", title: "Switch to dark mode" },
  { value: "dark", label: "Dark", icon: "D", title: "Switch to system mode" },
];

function readThemePreference(): ThemePreference {
  const saved = window.localStorage.getItem("theme-preference");
  return saved === "light" || saved === "dark" || saved === "system"
    ? saved
    : "system";
}

function resolveTheme(preference: ThemePreference) {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function App() {
  const location = useLocation();
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [latestJob, setLatestJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [latestLogs, setLatestLogs] = useState<RuntimeLog[]>([]);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsPayload | null>(
    null,
  );
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [mailboxDetail, setMailboxDetail] = useState<Mailbox | null>(null);
  const [mailboxDetailDraft, setMailboxDetailDraft] =
    useState<MailboxUpdate | null>(null);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [tokenExportConfirm, setTokenExportConfirm] =
    useState<TokenExportConfirm>(null);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(readThemePreference()),
  );

  const themeOption =
    themeOptions.find((option) => option.value === themePreference) ||
    themeOptions[0];

  function showToast(
    message: string,
    type: "success" | "error" | "info" = "info",
  ) {
    setToast({ message, type });
  }

  function toggleThemePreference() {
    const currentIndex = themeOptions.findIndex(
      (option) => option.value === themePreference,
    );
    const next = themeOptions[(currentIndex + 1) % themeOptions.length].value;
    setThemePreference(next);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function fetchJobSnapshot(id: number) {
    const detail = await api<Job>(`/api/register-jobs/${id}`);
    const logData = await api<{ items: RuntimeLog[] }>(
      `/api/register-jobs/${id}/logs`,
    );
    return { detail, logs: logData.items || [] };
  }

  async function loadJob(id: number) {
    const snapshot = await fetchJobSnapshot(id);
    setActiveJob(snapshot.detail);
    setLogs(snapshot.logs);
  }

  async function loadLatestJob(id: number) {
    const snapshot = await fetchJobSnapshot(id);
    setLatestJob(snapshot.detail);
    setLatestLogs(snapshot.logs);
    return snapshot;
  }

  async function refresh(preferredJobId?: number) {
    const [statsData, mailboxData, jobData, settingsData] = await Promise.all([
      api<Stats>("/api/stats"),
      api<{ total: number; items: Mailbox[] }>("/api/mailboxes?page_size=200"),
      api<{ total: number; items: Job[] }>("/api/register-jobs?page_size=20"),
      api<SettingsPayload>("/api/settings"),
    ]);
    setStats(statsData);
    setMailboxes(mailboxData.items || []);
    setJobs(jobData.items || []);
    const normalizedSettings = normalizeSettingsPayload(settingsData);
    setSettings(normalizedSettings);
    setSettingsDraft(normalizedSettings);
    const latest = jobData.items?.[0] || null;
    const latestSnapshot = latest ? await loadLatestJob(latest.id) : null;
    const targetId = preferredJobId || activeJob?.id;
    const selected = targetId
      ? jobData.items?.find((job) => job.id === targetId)
      : null;
    if (selected) {
      if (latestSnapshot && selected.id === latestSnapshot.detail.id) {
        setActiveJob(latestSnapshot.detail);
        setLogs(latestSnapshot.logs);
      } else {
        await loadJob(selected.id);
      }
    } else {
      setActiveJob(null);
      setLogs([]);
    }
    if (!latest) {
      setLatestJob(null);
      setLatestLogs([]);
    }
  }

  useEffect(() => {
    refresh().catch(console.error);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme() {
      const nextTheme = resolveTheme(themePreference);
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
      setResolvedTheme(nextTheme);
    }

    window.localStorage.setItem("theme-preference", themePreference);
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  useEffect(() => {
    const title = routeTitles[location.pathname] || "Overview";
    document.title = `${title} - ${appName}`;
  }, [location.pathname]);

  useEffect(() => {
    if (location.pathname !== "/jobs" || activeJob || jobs.length === 0) return;
    loadJob(jobs[0].id).catch(console.error);
  }, [location.pathname, activeJob, jobs]);

  useEffect(() => {
    if (!activeJob?.id || activeJob.status !== "running") return;
    if (activeJob.id === latestJob?.id) return;
    const source = new EventSource(`/api/register-jobs/${activeJob.id}/events`);
    source.addEventListener("log", (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as RuntimeLog;
      setLogs((prev) => [...prev.slice(-80), entry]);
      refresh(activeJob.id).catch(console.error);
    });
    return () => source.close();
  }, [activeJob?.id, activeJob?.status, latestJob?.id]);

  useEffect(() => {
    if (!latestJob?.id || latestJob.status !== "running") return;
    const source = new EventSource(`/api/register-jobs/${latestJob.id}/events`);
    source.addEventListener("log", (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as RuntimeLog;
      setLatestLogs((prev) => [...prev.slice(-80), entry]);
      if (activeJob?.id === latestJob.id) {
        setLogs((prev) => [...prev.slice(-80), entry]);
      }
      refresh(activeJob?.id).catch(console.error);
    });
    return () => source.close();
  }, [latestJob?.id, latestJob?.status, activeJob?.id]);

  async function saveSettings(next: SettingsPayload) {
    const saved = await api<{ settings: SettingsPayload }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(normalizeSettingsPayload(next)),
    });
    const normalizedSettings = normalizeSettingsPayload(saved.settings);
    setSettings(normalizedSettings);
    setSettingsDraft(normalizedSettings);
    return normalizedSettings;
  }

  async function importMailboxes() {
    setBusy(true);
    try {
      const result = await api<{
        imported: number;
        skipped: number;
        failed: number;
      }>("/api/mailboxes/import", {
        method: "POST",
        body: JSON.stringify({ text: importText }),
      });
      showToast(
        `Import complete: added ${result.imported}, skipped ${result.skipped}, failed ${result.failed}`,
        "success",
      );
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Import failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createRegisterTask(
    config: SettingsPayload,
    count: number,
    flow = "register_login",
    smsConfigName = "",
  ) {
    setBusy(true);
    try {
      await saveSettings(config);
      const job = await api<Job>("/api/register-jobs", {
        method: "POST",
        body: JSON.stringify({ count, flow, sms_config_name: smsConfigName }),
      });
      setActiveJob(job);
      setTaskOpen(false);
      showToast(`Registration job #${job.id} started`, "success");
      await refresh(job.id);
    } catch (error) {
      showToast(
          error instanceof Error ? error.message : "Failed to start registration job",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createLoginTask(
    config: SettingsPayload,
    ids: number[],
    flow = "login",
    smsConfigName = "",
  ) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await saveSettings(config);
      const job = await api<Job>("/api/login-jobs", {
        method: "POST",
        body: JSON.stringify({ mailbox_ids: ids, flow, sms_config_name: smsConfigName }),
      });
      setActiveJob(job);
      setTaskOpen(false);
      showToast(`Login job #${job.id} started`, "success");
      await refresh(job.id);
    } catch (error) {
      showToast(
          error instanceof Error ? error.message : "Failed to start login job",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteMailboxes(ids: number[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        ids.map((id) => api(`/api/mailboxes/${id}`, { method: "DELETE" })),
      );
      showToast(`Deleted ${ids.length} mailboxes`, "success");
      await refresh();
    } catch (error) {
      showToast(
          error instanceof Error ? error.message : "Failed to delete mailboxes",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resetMailboxes(ids: number[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        ids.map((id) =>
          api(`/api/mailboxes/${id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "new" }),
          }),
        ),
      );
      showToast(`Reset ${ids.length} mailboxes to unused`, "success");
      await refresh();
    } catch (error) {
      showToast(
          error instanceof Error ? error.message : "Failed to reset mailboxes",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateMailbox(id: number, updates: MailboxUpdate) {
    setBusy(true);
    try {
      const result = await api<{ item: Mailbox }>(`/api/mailboxes/${id}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
      setMailboxes((items) =>
        items.map((item) => (item.id === id ? result.item : item)),
      );
      showToast("Mailbox details saved", "success");
      await refresh();
      return result.item;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to save mailbox", "error");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function openMailboxDetail(mailbox: Mailbox) {
    setMailboxDetail(mailbox);
    setMailboxDetailDraft({
      email: mailbox.email || "",
      password: mailbox.password || "",
      client_id: mailbox.client_id || "",
      access_token: mailbox.access_token || "",
      register_password: mailbox.register_password || "",
    });
    setCredentialsOpen(false);
  }

  function closeMailboxDetail() {
    setMailboxDetail(null);
    setMailboxDetailDraft(null);
  }

  function updateMailboxDetailDraft(key: keyof MailboxUpdate, value: string) {
    setMailboxDetailDraft((draft) =>
      draft ? { ...draft, [key]: value } : draft,
    );
  }

  function updateCredentialLine(value: string) {
    const [email = "", password = "", clientId = "", ...tokenParts] =
      value.split("----");
    setMailboxDetailDraft((draft) =>
      draft
        ? {
            ...draft,
            email,
            password,
            client_id: clientId,
            access_token: tokenParts.join("----"),
          }
        : draft,
    );
  }

  async function saveMailboxDetail() {
    if (!mailboxDetail || !mailboxDetailDraft) return;
    const saved = await updateMailbox(mailboxDetail.id, mailboxDetailDraft);
    setMailboxDetail(saved);
    setMailboxDetailDraft({
      email: saved.email || "",
      password: saved.password || "",
      client_id: saved.client_id || "",
      access_token: saved.access_token || "",
      register_password: saved.register_password || "",
    });
  }

  async function stopTask(id: number) {
    if (!window.confirm(`Stop job #${id}?`)) return;
    setBusy(true);
    try {
      const result = await api<{ job: Job }>(`/api/register-jobs/${id}/stop`, {
        method: "POST",
      });
      setActiveJob(result.job);
      showToast(`Job #${id} stopped`, "success");
      await refresh();
    } catch (error) {
      showToast(
          error instanceof Error ? error.message : "Failed to stop job",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportJobTokens(job: Job) {
    if (!canExportJobTokens(job)) return;
    setBusy(true);
    try {
      const result = await api<{ count: number; items: JobTokenExportItem[] }>(
        `/api/register-jobs/${job.id}/tokens`,
      );
      setTokenExportConfirm({
        jobId: job.id,
        count: result.count,
        items: result.items || [],
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Failed to export tokens", "error");
    } finally {
      setBusy(false);
    }
  }

  function confirmExportJobTokens() {
    if (!tokenExportConfirm) return;
    const filename = `${formatFileDate(new Date())}_task-${tokenExportConfirm.jobId}_${tokenExportConfirm.count}.json`;
    downloadJsonFile(filename, tokenExportConfirm.items);
    showToast(`Exported ${tokenExportConfirm.count} tokens`, "success");
    setTokenExportConfirm(null);
  }

  const registered = stats.mailboxes.registered || 0;
  const abnormal = stats.mailboxes.abnormal || 0;
  const newCount = stats.mailboxes.new || 0;
  const runningCount = stats.mailboxes.registering || 0;
  const loginingCount = stats.mailboxes.logining || 0;

  return (
    <div className="theme-shell min-h-screen text-slate-950">
      <div className="mx-auto max-w-[92rem] px-4 py-4 sm:px-5">
        <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <NavLink
            to="/"
            className="flex items-center gap-2 font-extrabold"
          >
            <img
              src="/logo.svg"
              alt=""
              aria-hidden="true"
              draggable={false}
              className="h-8 w-8"
            />
            {appName}
          </NavLink>
          <nav className="flex w-full gap-1 overflow-x-auto rounded-xl border border-slate-200/70 bg-white/70 p-1 shadow-sm backdrop-blur sm:w-auto">
            {nav.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                className={({ isActive }) =>
                  isActive
                    ? "shrink-0 rounded-lg bg-white px-3 py-1.5 font-semibold shadow-sm"
                    : "shrink-0 px-3 py-1.5 text-slate-500 transition hover:text-slate-950"
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <Toast toast={toast} onClose={() => setToast(null)} />
        {taskOpen && settingsDraft && (
          <CreateTaskModal
            settings={settingsDraft}
            mailboxes={mailboxes}
            busy={busy}
            onClose={() => setTaskOpen(false)}
            onCreateRegister={createRegisterTask}
            onCreateLogin={createLoginTask}
          />
        )}
        {mailboxDetail && mailboxDetailDraft && (
          <MailboxDetailModal
            detail={mailboxDetail}
            detailDraft={mailboxDetailDraft}
            credentialsOpen={credentialsOpen}
            busy={busy}
            onClose={closeMailboxDetail}
            onToggleCredentials={() => setCredentialsOpen((open) => !open)}
            onUpdateDraft={updateMailboxDetailDraft}
            onUpdateCredentialLine={updateCredentialLine}
            onSave={saveMailboxDetail}
          />
        )}
        {tokenExportConfirm && (
          <TokenExportConfirmModal
            exportInfo={tokenExportConfirm}
            onClose={() => setTokenExportConfirm(null)}
            onConfirm={confirmExportJobTokens}
          />
        )}
        <Routes>
          <Route
            path="/"
            element={
              <Overview
                stats={{
                  newCount,
                  runningCount,
                  loginingCount,
                  registered,
                  abnormal,
                  proxyCount: settings?.proxies?.length || 0,
                }}
                mailboxes={mailboxes}
                logs={latestLogs}
                activeJob={latestJob}
                busy={busy}
                openTask={() => setTaskOpen(true)}
                openMailboxDetail={openMailboxDetail}
                refresh={refresh}
              />
            }
          />
          <Route
            path="/mailboxes"
            element={
              <MailboxesPage
                mailboxes={mailboxes}
                importText={importText}
                setImportText={setImportText}
                importMailboxes={importMailboxes}
                openMailboxDetail={openMailboxDetail}
                deleteMailboxes={deleteMailboxes}
                resetMailboxes={resetMailboxes}
                startLoginJob={(ids) =>
                  settingsDraft && createLoginTask(settingsDraft, ids)
                }
                busy={busy}
              />
            }
          />
          <Route
            path="/jobs"
            element={
              <JobsPage
                jobs={jobs}
                activeJob={activeJob}
                logs={logs}
                mailboxes={mailboxes}
                openTask={() => setTaskOpen(true)}
                openMailboxDetail={openMailboxDetail}
                stopTask={stopTask}
                exportJobTokens={exportJobTokens}
                selectJob={loadJob}
                busy={busy}
              />
            }
          />
          <Route
            path="/proxies"
            element={
              settingsDraft ? (
                <ProxyPoolPage
                  settingsDraft={settingsDraft}
                  setSettingsDraft={setSettingsDraft}
                  showToast={showToast}
                  saveSettings={(next) =>
                    saveSettings(next)
                        .then(() => showToast("Proxy pool updated", "success"))
                      .catch((e) =>
                        showToast(
                            e instanceof Error ? e.message : "Save failed",
                          "error",
                        ),
                      )
                  }
                />
              ) : null
            }
          />
          <Route
            path="/plugins"
            element={
              <PluginsPage />
            }
          />
          <Route
            path="/sms"
            element={
              settingsDraft ? (
                <SmsSettingsPage
                  settingsDraft={settingsDraft}
                  setSettingsDraft={setSettingsDraft}
                  saveSettings={async (next) => {
                    try {
                      await saveSettings(next);
                      showToast("SMS settings updated", "success");
                    } catch (e) {
                      showToast(
                        e instanceof Error ? e.message : "Save failed",
                        "error",
                      );
                      throw e;
                    }
                  }}
                  busy={busy}
                />
              ) : null
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <button
        type="button"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-slate-200/70 bg-white/90 px-3 py-2 text-sm font-bold text-slate-700 shadow-soft backdrop-blur transition hover:text-slate-950 sm:bottom-5 sm:right-5"
        onClick={toggleThemePreference}
        aria-label={`Current theme ${themeOption.label}, ${themeOption.title}`}
        title={`${themeOption.label} · currently ${resolvedTheme === "dark" ? "dark" : "light"}`}
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-slate-950 text-xs font-black text-white">
          {themeOption.icon}
        </span>
        <span>{themeOption.label}</span>
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
