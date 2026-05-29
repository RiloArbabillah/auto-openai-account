import { Play, RefreshCw } from "lucide-react";
import type { Job, Mailbox, RuntimeLog } from "../../types";
import { JobSummary } from "../../components/JobSummary/JobSummary";
import { LogPanel } from "../../components/LogPanel/LogPanel";
import { Stat } from "../../components/Stat/Stat";
import styles from "./Overview.module.css";

export function Overview({
  stats,
  mailboxes,
  logs,
  activeJob,
  busy,
  openTask,
  openMailboxDetail,
  refresh,
}: {
  stats: {
    newCount: number;
    runningCount: number;
    loginingCount: number;
    registered: number;
    abnormal: number;
    proxyCount: number;
  };
  mailboxes: Mailbox[];
  logs: RuntimeLog[];
  activeJob: Job | null;
  busy: boolean;
  openTask: () => void;
  openMailboxDetail: (mailbox: Mailbox) => void;
  refresh: () => void;
}) {
  const progress =
    activeJob && activeJob.total_count
      ? Math.round(
          ((activeJob.success_count + activeJob.failed_count) /
            activeJob.total_count) *
            100,
        )
      : 0;
  return (
    <div className="flex min-h-0 flex-col lg:h-[calc(100vh-5.75rem)]">
      <section className="mb-4 shrink-0 grid gap-4 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-200/70 bg-white/80 p-3 shadow-soft backdrop-blur sm:grid-cols-3">
          <Stat label="Proxies" value={stats.proxyCount} />
          <Stat label="Unused" value={stats.newCount} />
          <Stat label="Registering" value={stats.runningCount} />
          <Stat label="Logging In" value={stats.loginingCount} />
          <Stat label="Registered" value={stats.registered} />
          <Stat label="Abnormal" value={stats.abnormal} />
        </div>
        <div className="rounded-2xl border border-slate-200/70 bg-white/80 p-4 shadow-soft backdrop-blur">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Modern SaaS Console</p>
          <h1 className="max-w-3xl text-2xl font-black tracking-[-0.04em]">
            Run bulk registration, proxy routing, and live logs from one control panel.
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Start with a job, choose registration or token refresh, then tune concurrency, passwords, and proxy strategy.
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded-xl border bg-white px-3 py-2 font-bold"
            >
              <RefreshCw size={16} />
              Refresh
            </button>
            <button
              onClick={openTask}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-3 py-2 font-bold text-white shadow-lg disabled:opacity-50"
            >
              <Play size={16} />
              Create Job
            </button>
          </div>
        </div>
      </section>
      <section className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <JobSummary
          activeJob={activeJob}
          mailboxes={mailboxes}
          progress={progress}
          openMailboxDetail={openMailboxDetail}
        />
        <LogPanel logs={logs} activeJob={activeJob} fillHeight />
      </section>
    </div>
  );
}
