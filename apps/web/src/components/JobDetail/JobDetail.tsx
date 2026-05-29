import { canExportJobTokens, formatDurationSeconds, resultText } from "../../lib/format";
import type { Job, Mailbox } from "../../types";
import { Badge } from "../Badge/Badge";
import { Card } from "../Card/Card";
import { EmptyState } from "../EmptyState/EmptyState";
import { MiniStat } from "../MiniStat/MiniStat";
import styles from "./JobDetail.module.css";

export function JobDetail({
  job,
  mailboxes,
  openMailboxDetail,
  exportJobTokens,
  busy,
}: {
  job: Job | null;
  mailboxes: Mailbox[];
  openMailboxDetail: (mailbox: Mailbox) => void;
  exportJobTokens: (job: Job) => void;
  busy: boolean;
}) {
  const canExport = Boolean(job && canExportJobTokens(job));
  return (
    <Card
      title={job ? `Job Details #${job.id}` : "Job Details"}
      className="min-h-0"
      actions={
        job ? (
          <button
            type="button"
            onClick={() => exportJobTokens(job)}
            disabled={busy || !canExport}
            title={
                canExport
                  ? "Export tokens from successful mailboxes"
                  : "Only finished or stopped jobs can export tokens"
              }
            className="rounded-xl border bg-white px-3 py-2 text-sm font-bold disabled:opacity-50"
          >
            Export Tokens
          </button>
        ) : null
      }
    >
      {!job && (
        <EmptyState
          title="No job selected"
          description="Select a job from the list to inspect mailbox details."
        />
      )}
      {job && (
        <div className="flex h-[360px] flex-col lg:h-full lg:min-h-0">
          <div className="mb-3 grid grid-cols-3 gap-2">
            <MiniStat label="Total" value={job.total_count} />
            <MiniStat label="Success" value={job.success_count} />
            <MiniStat label="Failed" value={job.failed_count} />
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {(job.items || []).length === 0 && (
              <EmptyState title="No mailbox items yet" description="This job has no mailbox execution records yet." />
            )}
            {(job.items || []).map((item) => {
              const mailbox = mailboxes.find(
                (mailbox) => mailbox.email === item.email,
              );
              const canOpen = Boolean(mailbox);
              return (
              <button
                type="button"
                key={item.id}
                onClick={() => mailbox && openMailboxDetail(mailbox)}
                disabled={!canOpen}
                className={`w-full rounded-xl border bg-slate-50 p-3 text-left transition ${
                  canOpen
                    ? "hover:border-blue-200 hover:bg-blue-50/50"
                    : "cursor-default"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="break-all font-bold text-slate-900">
                      {item.email}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      Duration {formatDurationSeconds(item.duration_ms)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge status={item.status} text={resultText(item.status)} />
                    {canOpen && (
                      <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-xs font-bold text-slate-600">
                        Details
                      </span>
                    )}
                  </div>
                </div>
                {item.error && (
                  <div className="mt-2 break-all rounded-lg bg-rose-50 p-2 text-sm text-rose-700">
                    {item.error}
                  </div>
                )}
              </button>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
