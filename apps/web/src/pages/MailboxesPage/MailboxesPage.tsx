import { useState } from "react";
import { Database, UploadCloud } from "lucide-react";
import { jobTypeText, resultText } from "../../lib/format";
import type { Mailbox, MailboxView } from "../../types";
import { Badge } from "../../components/Badge/Badge";
import { Card } from "../../components/Card/Card";
import { DataTable } from "../../components/DataTable/DataTable";
import { EmptyState } from "../../components/EmptyState/EmptyState";
import { MiniStat } from "../../components/MiniStat/MiniStat";
import { Modal } from "../../components/Modal/Modal";
import styles from "./MailboxesPage.module.css";

export function MailboxesPage({
  mailboxes,
  importText,
  setImportText,
  importMailboxes,
  openMailboxDetail,
  deleteMailboxes,
  resetMailboxes,
  startLoginJob,
  testMailboxConnection,
  busy,
}: {
  mailboxes: Mailbox[];
  importText: string;
  setImportText: (value: string) => void;
  importMailboxes: () => void;
  openMailboxDetail: (mailbox: Mailbox) => void;
  deleteMailboxes: (ids: number[]) => void;
  resetMailboxes: (ids: number[]) => void;
  startLoginJob: (ids: number[]) => void;
  testMailboxConnection: (id: number) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [view, setView] = useState<MailboxView>("all");
  const [page, setPage] = useState(1);
  const counts = mailboxes.reduce<Record<string, number>>((a, m) => {
    a[m.status] = (a[m.status] || 0) + 1;
    return a;
  }, {});
  const usedCount = mailboxes.length - (counts.new || 0);
  const tabs: { key: MailboxView; label: string; value: number }[] = [
    { key: "all", label: "All", value: mailboxes.length },
    { key: "unused", label: "Unused", value: counts.new || 0 },
    { key: "used", label: "Used", value: usedCount },
    { key: "registered", label: "Registered", value: counts.registered || 0 },
    { key: "abnormal", label: "Abnormal", value: counts.abnormal || 0 },
  ];
  const visible = mailboxes.filter((m) => {
    if (view === "all") return true;
    if (view === "unused") return m.status === "new";
    if (view === "used") return m.status !== "new";
    return m.status === view;
  });
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = visible.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const allSelected =
    pageItems.length > 0 && pageItems.every((m) => selected.includes(m.id));
  const toggleOne = (id: number) =>
    setSelected((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id],
    );
  const toggleAll = () => {
    const pageIds = pageItems.map((m) => m.id);
    setSelected((prev) =>
      allSelected
        ? prev.filter((id) => !pageIds.includes(id))
        : Array.from(new Set([...prev, ...pageIds])),
    );
  };
  async function submitImport() {
    await importMailboxes();
    setImportOpen(false);
  }
  async function confirmDelete() {
    if (
      selected.length &&
      window.confirm(`Delete ${selected.length} mailboxes?`)
    ) {
      await deleteMailboxes(selected);
      setSelected([]);
    }
  }
  async function confirmReset() {
    if (
      selected.length &&
      window.confirm(`Reset ${selected.length} mailboxes back to unused?`)
    ) {
      await resetMailboxes(selected);
      setSelected([]);
    }
  }
  return (
    <div className="space-y-4">
      <Card title="Mailbox Pool" icon={<Database size={18} />}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <MiniStat label="All" value={mailboxes.length} />
            <MiniStat label="Unused" value={counts.new || 0} />
            <MiniStat label="Used" value={usedCount} />
            <MiniStat label="Registered" value={counts.registered || 0} />
            <MiniStat label="Abnormal" value={counts.abnormal || 0} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setImportOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-3 py-2 font-bold text-white"
            >
              <UploadCloud size={16} />
              Bulk Import
            </button>
            <button
              onClick={() => startLoginJob(selected)}
              disabled={busy || selected.length === 0}
              className="rounded-xl border bg-white px-3 py-2 font-bold disabled:opacity-50"
            >
              Bulk Login
            </button>
            <button
              onClick={confirmReset}
              disabled={busy || selected.length === 0}
              className="rounded-xl border bg-white px-3 py-2 font-bold disabled:opacity-50"
            >
              Reset to Unused
            </button>
            <button
              onClick={confirmDelete}
              disabled={busy || selected.length === 0}
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 font-bold text-rose-700 disabled:opacity-50"
            >
              Bulk Delete
            </button>
          </div>
        </div>
      </Card>
      <Card title="Mailbox List" icon={<Database size={18} />}>
        <div className="mb-3 flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setView(tab.key);
                setPage(1);
                setSelected([]);
              }}
              className={
                view === tab.key
                  ? "rounded-xl bg-slate-950 px-3 py-1.5 font-bold text-white"
                  : "rounded-xl border bg-white px-3 py-1.5 font-bold"
              }
            >
              {tab.label}
              <span className="ml-2 opacity-70">{tab.value}</span>
            </button>
          ))}
        </div>
        <DataTable headers={["", "Email", "Status", "Job", "Result", "Actions"]} minWidth="52rem">
          {pageItems.map((m) => (
            <tr key={m.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  onChange={() => toggleOne(m.id)}
                />
              </td>
              <td className="font-semibold">{m.email}</td>
              <td>
                <Badge
                  status={m.status}
                    text={m.status === "new" ? "Unused" : m.status_text}
                />
              </td>
              <td>
                {m.last_job_id
                  ? `#${m.last_job_id} ${jobTypeText(m.last_job_type)}`
                  : "-"}
              </td>
              <td>
                {m.last_job_status ? (
                  <Badge
                    status={m.last_job_status}
                    text={resultText(m.last_job_status)}
                  />
                ) : (
                  "-"
                )}
                {m.last_job_error && (
                  <div className="mt-1 max-w-56 truncate text-xs text-rose-600">
                    {m.last_job_error}
                  </div>
                )}
              </td>
              <td>
                <div className="flex gap-2">
                  <button
                    onClick={() => openMailboxDetail(m)}
                    className="rounded-xl border bg-white px-3 py-2 text-xs font-bold"
                  >
                    Details
                  </button>
                  <button
                    onClick={() => startLoginJob([m.id])}
                    className="rounded-xl border bg-white px-3 py-2 text-xs font-bold"
                  >
                    Login
                  </button>
                  <button
                    onClick={() => testMailboxConnection(m.id)}
                    disabled={busy}
                    className="rounded-xl border bg-white px-3 py-2 text-xs font-bold disabled:opacity-50"
                  >
                    Test Email
                  </button>
                  <button
                    onClick={() => resetMailboxes([m.id])}
                    className="rounded-xl border bg-white px-3 py-2 text-xs font-bold"
                  >
                    Reset
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
        {visible.length === 0 && (
          <div className="mt-3">
            <EmptyState
              title="No mailboxes yet"
              description={
                mailboxes.length === 0
                  ? "Use Bulk Import above to add mailboxes, then manage them here."
                  : "No mailboxes match the current filter. Change the filter and try again."
              }
            />
          </div>
        )}
        <div className="mt-3 flex items-center gap-3 text-sm text-slate-500">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            Select current page
          </label>
          <span>
            Selected {selected.length} mailboxes, showing {pageItems.length} / {visible.length}
          </span>
        </div>
        {visible.length > pageSize && (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border bg-slate-50 p-3 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Page {currentPage} / {totalPages}, {pageSize} per page
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={currentPage === 1}
                className="rounded-xl border bg-white px-3 py-2 font-bold disabled:opacity-50"
              >
                First
              </button>
              <button
                type="button"
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="rounded-xl border bg-white px-3 py-2 font-bold disabled:opacity-50"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="rounded-xl border bg-white px-3 py-2 font-bold disabled:opacity-50"
              >
                Next
              </button>
              <button
                type="button"
                onClick={() => setPage(totalPages)}
                disabled={currentPage === totalPages}
                className="rounded-xl border bg-white px-3 py-2 font-bold disabled:opacity-50"
              >
                Last
              </button>
            </div>
          </div>
        )}
      </Card>
      {importOpen && (
        <Modal title="Bulk Import Mailboxes" onClose={() => setImportOpen(false)}>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="email@example.com----password----client_id----refresh_token"
            className="h-60 w-full rounded-xl border bg-white p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setImportOpen(false)}
              className="rounded-xl border bg-white px-3 py-2 font-bold"
            >
              Cancel
            </button>
            <button
              onClick={submitImport}
              disabled={busy}
              className="rounded-xl bg-slate-950 px-3 py-2 font-bold text-white disabled:opacity-50"
            >
              Import
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
