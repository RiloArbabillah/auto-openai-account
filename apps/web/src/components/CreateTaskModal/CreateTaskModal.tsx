import { useState } from "react";
import { defaultPassword } from "../../lib/constants";
import type { Mailbox, SettingsPayload } from "../../types";
import { Field } from "../Field/Field";
import styles from "./CreateTaskModal.module.css";

type TaskFlow =
  | "register_login"
  | "register_codex"
  | "login"
  | "codex_login";

export function CreateTaskModal({
  settings,
  mailboxes,
  busy,
  onClose,
  onCreateRegister,
  onCreateLogin,
}: {
  settings: SettingsPayload;
  mailboxes: Mailbox[];
  busy: boolean;
  onClose: () => void;
  onCreateRegister: (
    settings: SettingsPayload,
    count: number,
    flow: TaskFlow,
    smsConfigName: string,
  ) => void;
  onCreateLogin: (
    settings: SettingsPayload,
    ids: number[],
    flow: TaskFlow,
    smsConfigName: string,
  ) => void;
}) {
  const unused = mailboxes.filter((item) => item.status === "new");
  const used = mailboxes.filter(
    (item) => item.status !== "new" && Boolean(item.register_password || item.password),
  );
  const [flow, setFlow] = useState<TaskFlow>("register_login");
  const [draft, setDraft] = useState<SettingsPayload>({
    ...settings,
    fixed_password: settings.fixed_password || defaultPassword,
    sms_configs: settings.sms_configs || [],
  });
  const [count, setCount] = useState(Math.min(1, unused.length));
  const [loginFilter, setLoginFilter] = useState("used");
  const [smsConfigName, setSMSConfigName] = useState(
    draft.sms_configs[0]?.name || "",
  );
  const isRegisterFlow = ["register_login", "register_codex"].includes(flow);
  const isCodexFlow = flow === "register_codex" || flow === "codex_login";
  const loginCandidates = used.filter(
    (item) => loginFilter === "used" || item.status === loginFilter,
  );
  const selectedSMSExists =
    !isCodexFlow ||
    draft.sms_configs.some((config) => config.name.trim() === smsConfigName.trim());
  function submit() {
    if (isRegisterFlow)
      onCreateRegister(
        draft,
        Math.max(1, Math.min(count, unused.length)),
        flow,
        smsConfigName,
      );
    else
      onCreateLogin(
        draft,
        loginCandidates.map((item) => item.id),
        flow,
        smsConfigName,
      );
  }
  const flowOptions: { value: TaskFlow; label: string }[] = [
    { value: "register_login", label: "Register + Standard Login" },
    { value: "register_codex", label: "Register + Standard Login + Codex Auth Login" },
    { value: "login", label: "Standard Login" },
    { value: "codex_login", label: "Codex Auth Login" },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border bg-white p-4 shadow-soft">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black">Create Job</h2>
            <p className="mt-1 text-sm text-slate-500">
              Choose a job type and configure the runtime settings for this run.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full border px-3 py-1 text-slate-500"
          >
            Close
          </button>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          {flowOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFlow(option.value)}
              className={
                flow === option.value
                  ? "rounded-xl bg-slate-950 px-3 py-1.5 font-bold text-white"
                  : "rounded-xl border bg-white px-3 py-1.5 font-bold"
              }
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Concurrency">
            <input
              className={styles.input}
              type="number"
              min={1}
              value={draft.register_concurrency}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  register_concurrency: Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Proxy Mode">
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={draft.proxy_mode}
              onChange={(e) =>
                setDraft({ ...draft, proxy_mode: e.target.value })
              }
            >
              <option value="local">Local Network (No Proxy)</option>
              <option value="random">Random</option>
              <option value="single">Use First Proxy</option>
              <option value="round_robin">Round Robin</option>
            </select>
          </Field>
        </div>
        {isRegisterFlow && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Field label={`Register Count (${unused.length} unused mailboxes available)`}>
              <input
                className={styles.input}
                type="number"
                min={1}
                max={unused.length}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </Field>
            <Field label="Password Mode">
              <select
                className={`${styles.input} ${styles.selectInput}`}
                value={draft.password_mode}
                onChange={(e) =>
                  setDraft({ ...draft, password_mode: e.target.value })
                }
              >
                <option value="random">Generate Randomly</option>
                <option value="fixed">Fixed Password</option>
              </select>
            </Field>
            {draft.password_mode === "fixed" && (
              <Field label="Fixed Password">
                <input
                  className={styles.input}
                  value={draft.fixed_password || defaultPassword}
                  onChange={(e) =>
                    setDraft({ ...draft, fixed_password: e.target.value })
                  }
                />
              </Field>
            )}
          </div>
        )}
        {!isRegisterFlow && (
          <div className="mt-3 grid gap-3 md:grid-cols-1">
            <Field label="Mailbox Status Filter">
              <select
                className={`${styles.input} ${styles.selectInput}`}
                value={loginFilter}
                onChange={(e) => setLoginFilter(e.target.value)}
              >
                <option value="used">All Used</option>
                <option value="registered">Registered</option>
                <option value="abnormal">Abnormal</option>
              </select>
              <p className="mt-2 text-sm text-slate-500">
                <span className="font-bold text-slate-800">
                  {loginCandidates.length}
                </span>{" "}
                mailboxes will be included in the login job
              </p>
            </Field>
          </div>
        )}
        {isCodexFlow && (
          <div className="mt-3">
            <Field label="SMS Configuration">
              <select
                className={`${styles.input} ${styles.selectInput}`}
                value={smsConfigName}
                onChange={(e) => setSMSConfigName(e.target.value)}
              >
                <option value="">Select an SMS configuration</option>
                {draft.sms_configs.map((config) => (
                  <option key={config.name} value={config.name}>
                    {config.name} · {config.platform}
                  </option>
                ))}
              </select>
              {!selectedSMSExists && (
                  <p className="mt-2 text-sm font-semibold text-rose-600">
                    Codex flows require a valid SMS configuration.
                  </p>
                )}
              </Field>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-xl border bg-white px-3 py-2 font-bold"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={
              busy ||
              (isRegisterFlow ? unused.length === 0 : loginCandidates.length === 0) ||
              !selectedSMSExists
            }
            className="rounded-xl bg-slate-950 px-3 py-2 font-bold text-white disabled:opacity-50"
          >
            Create Job
          </button>
        </div>
      </div>
    </div>
  );
}
