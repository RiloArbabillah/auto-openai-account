import { useEffect, useState } from "react";
import { PlugZap } from "lucide-react";
import { api } from "../../lib/api";
import { isValidProxyURL } from "../../lib/format";
import type { ProxyTestResult, SettingsPayload } from "../../types";
import { Badge } from "../../components/Badge/Badge";
import { Card } from "../../components/Card/Card";
import { EmptyState } from "../../components/EmptyState/EmptyState";
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

export function ProxyPoolPage({
  settingsDraft,
  setSettingsDraft,
  showToast,
  saveSettings,
}: {
  settingsDraft: SettingsPayload;
  setSettingsDraft: (s: SettingsPayload) => void;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
  saveSettings: (next: SettingsPayload) => void;
}) {
  const [results, setResults] = useState<Record<string, ProxyTestResult>>({});
  const [testing, setTesting] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [selectedCountries, setSelectedCountries] = useState(() =>
    readStoredSelection(proxyImportCountriesKey, countryOptions, defaultCountries),
  );
  const [selectedProtocols, setSelectedProtocols] = useState(() =>
    readStoredSelection(proxyImportProtocolsKey, protocolOptions, defaultProtocols),
  );
  const [importingURL, setImportingURL] = useState(false);

  useEffect(() => {
    setResults(settingsDraft.proxy_test_results || {});
  }, [settingsDraft.proxy_test_results]);

  useEffect(() => {
    window.localStorage.setItem(
      proxyImportCountriesKey,
      JSON.stringify(selectedCountries),
    );
  }, [selectedCountries]);

  useEffect(() => {
    window.localStorage.setItem(
      proxyImportProtocolsKey,
      JSON.stringify(selectedProtocols),
    );
  }, [selectedProtocols]);

  const persist = (proxies: string[]) => {
    const allowed = new Set(proxies);
    const nextResults = Object.fromEntries(
      Object.entries(results).filter(([proxy]) => allowed.has(proxy)),
    );
    const next = { ...settingsDraft, proxies };
    next.proxy_test_results = nextResults;
    setSettingsDraft(next);
    saveSettings(next);
  };
  function clearAll() {
    if (!settingsDraft.proxies.length) return;
    if (!window.confirm(`Delete all ${settingsDraft.proxies.length} proxies?`)) {
      return;
    }
    persist([]);
  }
  const failedProxies = settingsDraft.proxies.filter((proxy) => results[proxy] && !results[proxy].ok);
  const untestedProxies = settingsDraft.proxies.filter((proxy) => !results[proxy]);
  function clearFailed() {
    if (!failedProxies.length) return;
    if (!window.confirm(`Delete ${failedProxies.length} failed proxies?`)) {
      return;
    }
    const failedSet = new Set(failedProxies);
    persist(settingsDraft.proxies.filter((proxy) => !failedSet.has(proxy)));
    setResults((prev) => {
      const next = { ...prev };
      for (const proxy of failedProxies) {
        delete next[proxy];
      }
      return next;
    });
  }
  const remove = (i: number) =>
    persist(settingsDraft.proxies.filter((_, idx) => idx !== i));
  function addFromText() {
    const next = addText
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!next.length) return;
    const invalid = next.find((item) => !isValidProxyURL(item));
    if (invalid) {
      showToast(`Invalid proxy format: ${invalid}`, "error");
      return;
    }
    persist(
      Array.from(new Set([...settingsDraft.proxies.filter(Boolean), ...next])),
    );
    setAddText("");
    setAddOpen(false);
  }
  function toggleSelection(values: string[], value: string) {
    return values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];
  }
  async function importFromURL(url: string) {
    if (!url.trim()) {
      showToast("Import URL is required", "error");
      return;
    }
    setImportingURL(true);
    try {
      const data = await api<{ items: string[]; total: number }>(
        "/api/proxy/import-url",
        {
          method: "POST",
          body: JSON.stringify({ url: url.trim() }),
        },
      );
      const { merged, addedCount, skippedCount } = mergeUniqueProxiesByHost(
        settingsDraft.proxies,
        data.items,
      );
      const next = { ...settingsDraft, proxies: merged };
      setSettingsDraft(next);
      await saveSettings(next);
      setImportOpen(false);
      showToast(
        `Imported ${addedCount} proxies from URL${skippedCount ? `, skipped ${skippedCount} duplicate IPs` : ""}`,
        "success",
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Import failed", "error");
    } finally {
      setImportingURL(false);
    }
  }
  async function importPreset() {
    await importFromURL(buildProxyImportURL(defaultCountries, defaultProtocols));
  }
  async function importSelectedFilters() {
    if (!selectedCountries.length) {
      showToast("Select at least one country", "error");
      return;
    }
    if (!selectedProtocols.length) {
      showToast("Select at least one protocol", "error");
      return;
    }
    await importFromURL(buildProxyImportURL(selectedCountries, selectedProtocols));
  }
  async function testMany(proxies: string[]) {
    const ps = proxies.filter(Boolean);
    if (!ps.length) return;
    setTesting((prev) => Array.from(new Set([...prev, ...ps])));
    const queue = [...ps];
    const workerCount = Math.min(proxyTestConcurrency, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const proxy = queue.shift();
          if (!proxy) return;
          try {
            const d = await api<{ items: ProxyTestResult[] }>("/api/proxy/test", {
              method: "POST",
              body: JSON.stringify({ proxy }),
            });
            setResults((prev) => ({ ...prev, [proxy]: d.items[0] }));
          } catch (error) {
            setResults((prev) => ({
              ...prev,
              [proxy]: {
                proxy,
                ok: false,
                latency_ms: 0,
                error: error instanceof Error ? error.message : "Test failed",
              },
            }));
          } finally {
            setTesting((prev) => prev.filter((item) => item !== proxy));
          }
        }
      }),
    );
  }
  async function test(proxy: string) {
    if (!proxy.trim()) return;
    setTesting((prev) => Array.from(new Set([...prev, proxy])));
    try {
      const d = await api<{ items: ProxyTestResult[] }>("/api/proxy/test", {
        method: "POST",
        body: JSON.stringify({ proxy }),
      });
      setResults((p) => ({ ...p, [proxy]: d.items[0] }));
    } finally {
      setTesting((prev) => prev.filter((item) => item !== proxy));
    }
  }
  async function testAll() {
    await testMany(settingsDraft.proxies);
  }
  async function testUntested() {
    await testMany(untestedProxies);
  }
  async function testFailed() {
    await testMany(failedProxies);
  }
  const hasTesting = testing.length > 0;
  return (
    <>
      <Card
        title="Proxy Pool"
        icon={<PlugZap size={18} />}
        actions={
          <div className="flex gap-2">
            <button
              onClick={importPreset}
              disabled={importingURL}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {importingURL ? "Importing..." : "Import JP/US/TH"}
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold"
            >
              Import Filtered
            </button>
            <button
              onClick={() => setAddOpen(true)}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold"
            >
              Add Proxy
            </button>
            <button
              onClick={clearAll}
              disabled={!settingsDraft.proxies.length}
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700 disabled:opacity-50"
            >
              Clear All
            </button>
            <button
              onClick={clearFailed}
              disabled={!failedProxies.length}
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700 disabled:opacity-50"
            >
              {`Delete Failed (${failedProxies.length})`}
            </button>
            <button
              onClick={testFailed}
              disabled={hasTesting || !failedProxies.length}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {hasTesting ? "Testing..." : `Test Failed (${failedProxies.length})`}
            </button>
            <button
              onClick={testUntested}
              disabled={hasTesting || !untestedProxies.length}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {hasTesting ? "Testing..." : `Test Untested (${untestedProxies.length})`}
            </button>
            <button
              onClick={testAll}
              disabled={hasTesting}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
            >
              {hasTesting ? "Testing..." : "Test All"}
            </button>
          </div>
        }
      >
        <div className="space-y-2">
          {settingsDraft.proxies.map((proxy, i) => {
            const r = results[proxy];
            const isTesting = testing.includes(proxy);
            return (
              <div key={i} className="rounded-xl border bg-slate-50 p-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-800">
                    <div className="truncate">{proxy}</div>
                  </div>
                  <button
                    onClick={() => test(proxy)}
                    disabled={isTesting}
                    className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                  >
                    {isTesting ? "Testing..." : "Test"}
                  </button>
                  <button
                    onClick={() => remove(i)}
                    className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700"
                  >
                    Delete
                  </button>
                </div>
                {r && (
                  <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        status={r.ok ? "success" : "failed"}
                        text={r.ok ? "Available" : "Failed"}
                      />
                      <span>IP: {r.ip || "-"}</span>
                      <span>Country: {r.country || (r.country_code || "-")}</span>
                      <span>Latency: {r.latency_ms}ms</span>
                      {r.error && (
                        <span className="text-rose-600">{r.error}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!settingsDraft.proxies.length && (
            <EmptyState
              title="No proxies yet"
              description="Add proxies from the top-right button, then test and manage them here."
            />
          )}
        </div>
      </Card>
      {addOpen && (
        <Modal
          title="Add Proxies"
          subtitle="One proxy per line. Supports http, https, socks5, and socks5h."
          onClose={() => setAddOpen(false)}
        >
          <textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="socks5://127.0.0.1:7890\nhttp://127.0.0.1:8080"
            className="h-56 w-full rounded-xl border bg-white p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setAddOpen(false)}
              className="rounded-xl border bg-white px-3 py-2 text-sm font-bold"
            >
              Cancel
            </button>
            <button
              onClick={addFromText}
              className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white"
            >
              Add Proxies
            </button>
          </div>
        </Modal>
      )}
      {importOpen && (
        <Modal
          title="Import Filtered Proxies"
          subtitle="Pick countries and protocols. The app builds a ProxyScrape URL and imports proxies[].proxy into your current pool."
          onClose={() => !importingURL && setImportOpen(false)}
        >
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-bold text-slate-700">Countries</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedCountries(countryOptions)}
                    className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedCountries([])}
                    className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {countryOptions.map((country) => {
                  const selected = selectedCountries.includes(country);
                  return (
                    <button
                      key={country}
                      type="button"
                      onClick={() =>
                        setSelectedCountries((prev) => toggleSelection(prev, country))
                      }
                      className={`rounded-xl border px-3 py-2 text-sm font-bold ${
                        selected
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "bg-white text-slate-700"
                      }`}
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
                  <button
                    type="button"
                    onClick={() => setSelectedProtocols(protocolOptions)}
                    className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedProtocols([])}
                    className="rounded-lg border bg-white px-2 py-1 text-xs font-bold text-slate-600"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {protocolOptions.map((protocol) => {
                  const selected = selectedProtocols.includes(protocol);
                  return (
                    <button
                      key={protocol}
                      type="button"
                      onClick={() =>
                        setSelectedProtocols((prev) => toggleSelection(prev, protocol))
                      }
                      className={`rounded-xl border px-3 py-2 text-sm font-bold ${
                        selected
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "bg-white text-slate-700"
                      }`}
                    >
                      {protocol}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-2 text-sm font-bold text-slate-700">Generated URL</div>
              <div className="rounded-xl border bg-slate-50 p-3 font-mono text-xs text-slate-600 break-all">
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
              onClick={importSelectedFilters}
              disabled={importingURL}
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
