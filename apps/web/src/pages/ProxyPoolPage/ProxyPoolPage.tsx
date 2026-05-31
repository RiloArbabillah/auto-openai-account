import { useEffect, useMemo, useState } from "react";
import { PlugZap } from "lucide-react";
import { api, createSettingsItemID } from "../../lib/api";
import { isValidProxyURL } from "../../lib/format";
import type { ProxyGroup, ProxyTestResult, SettingsPayload } from "../../types";
import { Badge } from "../../components/Badge/Badge";
import { Card } from "../../components/Card/Card";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import { Field } from "../../components/Field/Field";
import { Modal } from "../../components/Modal/Modal";
import styles from "./ProxyPoolPage.module.css";

const proxyTestConcurrency = 10;
const proxyScrapeBaseURL =
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json";
const countryOptions = ["JP", "US", "TH", "ID", "SG", "MY", "VN", "PH", "KR", "HK", "TW"];
const protocolOptions = ["http", "https", "socks5", "socks5h"];
const defaultCountries = ["JP", "US", "TH"];
const defaultProtocols = ["socks5", "http", "https"];
const proxyImportCountriesKey = "proxy-import-countries";
const proxyImportProtocolsKey = "proxy-import-protocols";

type AddDraft = {
  name: string;
  mode: "random" | "round_robin";
  text: string;
};

const initialAddDraft: AddDraft = {
  name: "",
  mode: "round_robin",
  text: "",
};

function buildProxyImportURL(countries: string[], protocols: string[]) {
  const params = new URLSearchParams();
  if (countries.length) {
    params.set("country", countries.join(","));
  }
  if (protocols.length) {
    params.set("protocol", protocols.join(","));
  }
  const suffix = params.toString();
  return suffix ? `${proxyScrapeBaseURL}&${suffix}` : proxyScrapeBaseURL;
}

function proxyHostKey(value: string) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port;
    const family =
      parsed.protocol === "socks5:" || parsed.protocol === "socks5h:"
        ? "socks"
        : parsed.protocol === "http:" || parsed.protocol === "https:"
          ? "http"
          : "";
    return host && port && family ? `${family}:${host}:${port}` : value.trim().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function mergeUniqueProxiesByHost(existing: string[], incoming: string[]) {
  const seen = new Set(existing.map(proxyHostKey));
  const added: string[] = [];
  for (const proxy of incoming) {
    const key = proxyHostKey(proxy);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    added.push(proxy);
  }
  return {
    merged: [...existing, ...added],
    addedCount: added.length,
    skippedCount: incoming.length - added.length,
  };
}

function readStoredSelection(storageKey: string, allowed: string[], fallback: string[]) {
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const filtered = parsed.filter(
      (value): value is string => typeof value === "string" && allowed.includes(value),
    );
    return filtered.length ? Array.from(new Set(filtered)) : fallback;
  } catch {
    return fallback;
  }
}

function toggleSelection(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

export function ProxyPoolPage({
  settingsDraft,
  setSettingsDraft,
  showToast,
  saveSettings,
}: {
  settingsDraft: SettingsPayload;
  setSettingsDraft: (s: SettingsPayload) => void;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
  saveSettings: (next: SettingsPayload) => Promise<void> | void;
}) {
  const [results, setResults] = useState<Record<string, ProxyTestResult>>({});
  const [testing, setTesting] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(initialAddDraft);
  const [editingGroupID, setEditingGroupID] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetGroupID, setImportTargetGroupID] = useState("");
  const [selectedCountries, setSelectedCountries] = useState(() =>
    readStoredSelection(proxyImportCountriesKey, countryOptions, defaultCountries),
  );
  const [selectedProtocols, setSelectedProtocols] = useState(() =>
    readStoredSelection(proxyImportProtocolsKey, protocolOptions, defaultProtocols),
  );
  const [importingURL, setImportingURL] = useState(false);

  const groups = settingsDraft.proxy_groups || [];
  const allProxies = useMemo(
    () => groups.flatMap((group) => group.proxies || []),
    [groups],
  );
  const failedProxies = allProxies.filter((proxy) => results[proxy] && !results[proxy].ok);
  const untestedProxies = allProxies.filter((proxy) => !results[proxy]);
  const hasTesting = testing.length > 0;

  useEffect(() => {
    setResults(settingsDraft.proxy_test_results || {});
  }, [settingsDraft.proxy_test_results]);

  useEffect(() => {
    window.localStorage.setItem(proxyImportCountriesKey, JSON.stringify(selectedCountries));
  }, [selectedCountries]);

  useEffect(() => {
    window.localStorage.setItem(proxyImportProtocolsKey, JSON.stringify(selectedProtocols));
  }, [selectedProtocols]);

  useEffect(() => {
    if (!importTargetGroupID && groups.length > 0) {
      setImportTargetGroupID(groups[0].id);
    }
    if (importTargetGroupID && !groups.some((group) => group.id === importTargetGroupID)) {
      setImportTargetGroupID(groups[0]?.id || "");
    }
  }, [groups, importTargetGroupID]);

  function syncDraft(nextGroups: ProxyGroup[], nextResults = results) {
    const next = {
      ...settingsDraft,
      proxy_groups: nextGroups,
      proxy_test_results: nextResults,
    };
    setSettingsDraft(next);
    setResults(nextResults);
    return next;
  }

  async function persist(nextGroups: ProxyGroup[], nextResults = results) {
    const next = syncDraft(nextGroups, nextResults);
    await Promise.resolve(saveSettings(next));
  }

  function resetAddDraft() {
    setAddDraft(initialAddDraft);
    setEditingGroupID(null);
  }

  function openAddModal() {
    resetAddDraft();
    setAddOpen(true);
  }

  function openEditModal(group: ProxyGroup) {
    setEditingGroupID(group.id);
    setAddDraft({
      name: group.name,
      mode: group.mode === "random" ? "random" : "round_robin",
      text: group.proxies.join("\n"),
    });
    setAddOpen(true);
  }

  async function saveGroup() {
    const name = addDraft.name.trim();
    if (!name) {
      showToast("Enter a group name", "error");
      return;
    }
    if (
      groups.some(
        (group) =>
          group.name.trim().toLowerCase() === name.toLowerCase() &&
          group.id !== editingGroupID,
      )
    ) {
      showToast(`Group name already exists: ${name}`, "error");
      return;
    }
    const proxies = Array.from(
      new Set(
        addDraft.text
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
    if (!proxies.length) {
      showToast("Enter at least one proxy", "error");
      return;
    }
    const invalid = proxies.find((item) => !isValidProxyURL(item));
    if (invalid) {
      showToast(`Invalid proxy format: ${invalid}`, "error");
      return;
    }
    const nextGroup: ProxyGroup = {
      id: editingGroupID || createSettingsItemID(),
      name,
      mode: addDraft.mode,
      proxies,
    };
    const nextGroups = editingGroupID
      ? groups.map((group) => (group.id === editingGroupID ? nextGroup : group))
      : [...groups, nextGroup];
    await persist(nextGroups);
    setAddOpen(false);
    resetAddDraft();
    showToast(editingGroupID ? "Proxy group updated" : "Proxy group added", "success");
  }

  async function removeGroup(id: string) {
    const removed = groups.find((group) => group.id === id);
    if (!removed) return;
    if (!window.confirm(`Delete proxy group \"${removed.name}\"?`)) {
      return;
    }
    const nextGroups = groups.filter((group) => group.id !== id);
    const allowed = new Set(nextGroups.flatMap((group) => group.proxies));
    const nextResults = Object.fromEntries(
      Object.entries(results).filter(([proxy]) => allowed.has(proxy)),
    );
    await persist(nextGroups, nextResults);
  }

  async function removeProxy(groupID: string, proxy: string) {
    const nextGroups = groups
      .map((group) =>
        group.id !== groupID
          ? group
          : { ...group, proxies: group.proxies.filter((item) => item !== proxy) },
      )
      .filter((group) => group.proxies.length > 0);
    const allowed = new Set(nextGroups.flatMap((group) => group.proxies));
    const nextResults = Object.fromEntries(
      Object.entries(results).filter(([key]) => allowed.has(key)),
    );
    await persist(nextGroups, nextResults);
  }

  async function clearAll() {
    if (!groups.length) return;
    if (!window.confirm(`Delete all ${groups.length} proxy groups?`)) {
      return;
    }
    await persist([], {});
  }

  async function clearFailed() {
    if (!failedProxies.length) return;
    if (!window.confirm(`Delete ${failedProxies.length} failed proxies from all groups?`)) {
      return;
    }
    const failedSet = new Set(failedProxies);
    const nextGroups = groups
      .map((group) => ({
        ...group,
        proxies: group.proxies.filter((proxy) => !failedSet.has(proxy)),
      }))
      .filter((group) => group.proxies.length > 0);
    const allowed = new Set(nextGroups.flatMap((group) => group.proxies));
    const nextResults = Object.fromEntries(
      Object.entries(results).filter(([proxy]) => allowed.has(proxy)),
    );
    await persist(nextGroups, nextResults);
  }

  function updateLocalResults(nextResults: Record<string, ProxyTestResult>) {
    setResults(nextResults);
    setSettingsDraft({
      ...settingsDraft,
      proxy_test_results: nextResults,
    });
  }

  async function testProxy(proxy: string) {
    if (!proxy.trim()) return;
    setTesting((prev) => Array.from(new Set([...prev, proxy])));
    try {
      const data = await api<{ items: ProxyTestResult[] }>("/api/proxy/test", {
        method: "POST",
        body: JSON.stringify({ proxy }),
      });
      const nextResults = { ...results, [proxy]: data.items[0] };
      updateLocalResults(nextResults);
    } catch (error) {
      const nextResults = {
        ...results,
        [proxy]: {
          proxy,
          ok: false,
          latency_ms: 0,
          error: error instanceof Error ? error.message : "Proxy test failed",
        },
      };
      updateLocalResults(nextResults);
    } finally {
      setTesting((prev) => prev.filter((item) => item !== proxy));
    }
  }

  async function testMany(proxies: string[]) {
    const queue = proxies.filter(Boolean);
    if (!queue.length) return;
    const workerCount = Math.min(proxyTestConcurrency, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const proxy = queue.shift();
          if (!proxy) return;
          await testProxy(proxy);
        }
      }),
    );
  }

  async function testGroup(group: ProxyGroup) {
    await testMany(group.proxies);
  }

  async function importFromURL(url: string) {
    if (!importTargetGroupID) {
      showToast("Create a proxy group first", "error");
      return;
    }
    setImportingURL(true);
    try {
      const data = await api<{ items: string[]; total: number }>("/api/proxy/import-url", {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      const nextGroups = groups.map((group) => {
        if (group.id !== importTargetGroupID) return group;
        const merged = mergeUniqueProxiesByHost(group.proxies, data.items);
        showToast(
          `Imported ${merged.addedCount} proxies${merged.skippedCount ? `, skipped ${merged.skippedCount} duplicates` : ""}`,
          "success",
        );
        return { ...group, proxies: merged.merged };
      });
      await persist(nextGroups);
      setImportOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Import failed", "error");
    } finally {
      setImportingURL(false);
    }
  }

  const targetGroup = groups.find((group) => group.id === importTargetGroupID) || null;

  return (
    <>
      <Card
        title="Proxy Pool"
        icon={<PlugZap size={18} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => importFromURL(buildProxyImportURL(defaultCountries, defaultProtocols))}
              disabled={importingURL || groups.length === 0}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {importingURL ? "Importing..." : "Import JP/US/TH"}
            </button>
            <button
              onClick={() => setImportOpen(true)}
              disabled={groups.length === 0}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              Import Filtered
            </button>
            <button
              onClick={openAddModal}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold"
            >
              Add Group
            </button>
            <button
              onClick={clearFailed}
              disabled={!failedProxies.length}
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700 disabled:opacity-50"
            >
              Delete Failed ({failedProxies.length})
            </button>
            <button
              onClick={() => testMany(failedProxies)}
              disabled={hasTesting || !failedProxies.length}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {hasTesting ? "Testing..." : `Test Failed (${failedProxies.length})`}
            </button>
            <button
              onClick={() => testMany(untestedProxies)}
              disabled={hasTesting || !untestedProxies.length}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {hasTesting ? "Testing..." : `Test Untested (${untestedProxies.length})`}
            </button>
            <button
              onClick={() => testMany(allProxies)}
              disabled={hasTesting || !allProxies.length}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {hasTesting ? "Testing..." : "Test All"}
            </button>
            <button
              onClick={clearAll}
              disabled={!groups.length}
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700 disabled:opacity-50"
            >
              Clear All
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {groups.map((group) => {
            const groupBusy = group.proxies.some((proxy) => testing.includes(proxy));
            return (
              <div key={group.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-black text-slate-900">{group.name}</h3>
                      <Badge
                        status={group.mode === "round_robin" ? "running" : "success"}
                        text={group.mode === "round_robin" ? "Round Robin" : "Random"}
                      />
                      <span className="text-sm text-slate-500">{group.proxies.length} proxies</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => openEditModal(group)}
                      className="rounded-xl border bg-white px-3 py-2 text-sm font-bold"
                    >
                      Edit Group
                    </button>
                    <button
                      onClick={() => testGroup(group)}
                      disabled={groupBusy}
                      className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
                    >
                      {groupBusy ? "Testing..." : "Test Group"}
                    </button>
                    <button
                      onClick={() => removeGroup(group.id)}
                      className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700"
                    >
                      Delete Group
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {group.proxies.map((proxy) => {
                    const result = results[proxy];
                    const isTesting = testing.includes(proxy);
                    return (
                      <div key={`${group.id}-${proxy}`} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                          <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800">
                            <div className="truncate">{proxy}</div>
                          </div>
                          <button
                            onClick={() => testProxy(proxy)}
                            disabled={isTesting}
                            className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                          >
                            {isTesting ? "Testing..." : "Test"}
                          </button>
                          <button
                            onClick={() => removeProxy(group.id, proxy)}
                            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700"
                          >
                            Delete
                          </button>
                        </div>
                        {result && (
                          <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                status={result.ok ? "success" : "failed"}
                                text={result.ok ? "Available" : "Failed"}
                              />
                              <span>IP: {result.ip || "-"}</span>
                              <span>Country: {result.country || result.country_code || "-"}</span>
                              <span>Latency: {result.latency_ms}ms</span>
                              {result.error && <span className="text-rose-600">{result.error}</span>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!groups.length && (
            <EmptyState
              title="No proxy groups yet"
              description="Add a proxy group first, then import, test, and manage proxies here."
            />
          )}
        </div>
      </Card>
      {addOpen && (
        <Modal
          title={editingGroupID ? "Edit Proxy Group" : "Add Proxy Group"}
          subtitle="Supports http, https, socks5, and socks5h. One proxy per line."
          onClose={() => {
            setAddOpen(false);
            resetAddDraft();
          }}
        >
          <div className="space-y-3">
            <Field label="Group Name">
              <input
                value={addDraft.name}
                onChange={(e) => setAddDraft((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="US residential"
                className={styles.input}
              />
            </Field>
            <Field label="Mode">
              <select
                value={addDraft.mode}
                onChange={(e) =>
                  setAddDraft((prev) => ({
                    ...prev,
                    mode: e.target.value === "random" ? "random" : "round_robin",
                  }))
                }
                className={`${styles.input} ${styles.selectInput}`}
              >
                <option value="round_robin">Round Robin</option>
                <option value="random">Random</option>
              </select>
            </Field>
            <Field label="Proxy List">
              <textarea
                value={addDraft.text}
                onChange={(e) => setAddDraft((prev) => ({ ...prev, text: e.target.value }))}
                placeholder="socks5://127.0.0.1:7890\nhttp://127.0.0.1:8080"
                className={`${styles.input} h-56 font-mono`}
              />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => {
                setAddOpen(false);
                resetAddDraft();
              }}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold"
            >
              Cancel
            </button>
            <button
              onClick={saveGroup}
              className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white"
            >
              {editingGroupID ? "Save Group" : "Add Group"}
            </button>
          </div>
        </Modal>
      )}
      {importOpen && (
        <Modal
          title="Import Filtered Proxies"
          subtitle="Build a ProxyScrape URL and import proxies into one group."
          onClose={() => !importingURL && setImportOpen(false)}
        >
          <div className="space-y-4">
            <Field label="Target Group">
              <select
                value={importTargetGroupID}
                onChange={(e) => setImportTargetGroupID(e.target.value)}
                className={`${styles.input} ${styles.selectInput}`}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </Field>
            {targetGroup && (
              <div className="rounded-xl border bg-slate-50 px-3 py-2 text-sm text-slate-600">
                New proxies will be merged into <span className="font-bold">{targetGroup.name}</span>.
              </div>
            )}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-bold text-slate-700">Countries</div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setSelectedCountries(countryOptions)} className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600">Select All</button>
                  <button type="button" onClick={() => setSelectedCountries([])} className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600">Clear All</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {countryOptions.map((country) => {
                  const selected = selectedCountries.includes(country);
                  return (
                    <button
                      key={country}
                      type="button"
                      onClick={() => setSelectedCountries((prev) => toggleSelection(prev, country))}
                      className={`rounded-xl border px-3 py-2 text-sm font-bold ${selected ? "border-blue-200 bg-blue-50 text-blue-700" : "bg-white text-slate-700"}`}
                    >
                      {country}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-bold text-slate-700">Protocols</div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setSelectedProtocols(protocolOptions)} className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600">Select All</button>
                  <button type="button" onClick={() => setSelectedProtocols([])} className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600">Clear All</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {protocolOptions.map((protocol) => {
                  const selected = selectedProtocols.includes(protocol);
                  return (
                    <button
                      key={protocol}
                      type="button"
                      onClick={() => setSelectedProtocols((prev) => toggleSelection(prev, protocol))}
                      className={`rounded-xl border px-3 py-2 text-sm font-bold ${selected ? "border-blue-200 bg-blue-50 text-blue-700" : "bg-white text-slate-700"}`}
                    >
                      {protocol}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-2 text-sm font-bold text-slate-700">Generated URL</div>
              <div className="break-all rounded-xl border bg-slate-50 p-3 font-mono text-xs text-slate-600">
                {buildProxyImportURL(selectedCountries, selectedProtocols)}
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedCountries(defaultCountries);
                setSelectedProtocols(defaultProtocols);
              }}
              disabled={importingURL}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              Reset to Default
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => setImportOpen(false)}
                disabled={importingURL}
                className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => importFromURL(buildProxyImportURL(selectedCountries, selectedProtocols))}
                disabled={importingURL || !groups.length}
                className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {importingURL ? "Importing..." : "Import Proxies"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
