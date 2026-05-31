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
  codexLoginTargetIds,
  loginTargetIds,
  onClose,
  onCreateRegister,
  onCreateLogin,
}: {
  settings: SettingsPayload;
  mailboxes: Mailbox[];
  busy: boolean;
  codexLoginTargetIds?: number[];
  loginTargetIds?: number[];
  onClose: () => void;
  onCreateRegister: (
    settings: SettingsPayload,
    count: number,
    flow: TaskFlow,
    smsConfigID: string,
    proxyGroupID: string,
  ) => void;
  onCreateLogin: (
    settings: SettingsPayload,
    ids: number[],
    flow: TaskFlow,
    smsConfigID: string,
    proxyGroupID: string,
  ) => void;
}) {
  const unused = mailboxes.filter((item) => item.status === "new");
  const used = mailboxes.filter(
    (item) => item.status !== "new" && Boolean(item.register_password || item.password),
  );
  const codexTargetIds = codexLoginTargetIds || [];
  const loginTargetIdsResolved = loginTargetIds || [];
  const forcedCodexLogin = codexTargetIds.length > 0;
  const forcedLogin = loginTargetIdsResolved.length > 0;
  const [flow, setFlow] = useState<TaskFlow>(
    forcedCodexLogin ? "codex_login" : forcedLogin ? "login" : "register_login",
  );
  const [draft, setDraft] = useState<SettingsPayload>({
    ...settings,
    fixed_password: settings.fixed_password || defaultPassword,
    sms_configs: settings.sms_configs || [],
    proxy_groups: settings.proxy_groups || [],
    proxy_test_results: settings.proxy_test_results || {},
  });
  const [registerConcurrencyInput, setRegisterConcurrencyInput] = useState(
    String(settings.register_concurrency || 1),
  );
  const [countInput, setCountInput] = useState(String(Math.min(1, unused.length)));
  const [loginFilter, setLoginFilter] = useState("used");
  const [smsConfigID, setSMSConfigID] = useState(draft.sms_configs[0]?.id || "");
  const [proxyTarget, setProxyTarget] = useState("");
  const isRegisterFlow = flow === "register_login" || flow === "register_codex";
  const isCodexFlow = flow === "register_codex" || flow === "codex_login";
  const registerConcurrency =
    Number(registerConcurrencyInput) > 0 ? Math.floor(Number(registerConcurrencyInput)) : 1;
  const count =
    unused.length > 0 && Number(countInput) > 0
      ? Math.min(Math.floor(Number(countInput)), unused.length)
      : Math.min(1, unused.length);
  const registerConcurrencyInvalid =
    registerConcurrencyInput.trim() === "" || Number(registerConcurrencyInput) <= 0;
  const countInvalid = isRegisterFlow && (countInput.trim() === "" || Number(countInput) <= 0);
  const registerInputsInvalid = registerConcurrencyInvalid || countInvalid;
  const loginCandidates = forcedCodexLogin
    ? used.filter((item) => codexTargetIds.includes(item.id))
    : forcedLogin
      ? used.filter((item) => loginTargetIdsResolved.includes(item.id))
      : used.filter((item) => loginFilter === "used" || item.status === loginFilter);
  const selectedSMSExists =
    !isCodexFlow || draft.sms_configs.some((config) => config.id === smsConfigID);
  const selectedSMSConfig = draft.sms_configs.find((config) => config.id === smsConfigID);
  const requiredPhoneCount = isRegisterFlow
    ? Math.max(1, Math.min(count, unused.length))
    : loginCandidates.length;
  const poolReadyCount = selectedSMSConfig?.pool_summary?.ready_count || 0;
  const smsCapacityError =
    isCodexFlow &&
    selectedSMSConfig?.type === "pool" &&
    poolReadyCount < requiredPhoneCount
      ? `Phone pool capacity is too low: ${poolReadyCount} ready, ${requiredPhoneCount} required.`
      : "";

  const flowOptions: { value: TaskFlow; label: string }[] = forcedCodexLogin
    ? [{ value: "codex_login", label: "Codex Auth Login" }]
    : forcedLogin
      ? [{ value: "login", label: "Standard Login" }]
      : [
          { value: "register_login", label: "Register + Standard Login" },
          { value: "register_codex", label: "Register + Standard Login + Codex Auth Login" },
          { value: "login", label: "Standard Login" },
          { value: "codex_login", label: "Codex Auth Login" },
        ];

  function smsOptionLabel(config: SettingsPayload["sms_configs"][number]) {
    if (config.type === "pool") {
      return `${config.name} · Phone Pool · Ready ${config.pool_summary?.ready_count || 0}`;
    }
    return `${config.name} · ${config.platform}`;
  }

  function submit() {
    if (smsCapacityError || registerInputsInvalid) {
      return;
    }
    const nextDraft = {
      ...draft,
      register_concurrency: registerConcurrency,
    };
    if (isRegisterFlow) {
      onCreateRegister(
        nextDraft,
        Math.max(1, Math.min(count, unused.length)),
        flow,
        smsConfigID,
        proxyTarget,
      );
      return;
    }
    onCreateLogin(
      nextDraft,
      loginCandidates.map((item) => item.id),
      flow,
      smsConfigID,
      proxyTarget,
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border bg-white p-4 shadow-soft">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black">
              {forcedCodexLogin
                ? "Create Codex Auth Login Job"
                : forcedLogin
                  ? "Create Standard Login Job"
                  : "Create Job"}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {forcedCodexLogin
                ? "Use the current mailbox selection and choose SMS plus proxy settings for a Codex login run."
                : forcedLogin
                  ? "Use the current mailbox selection and choose runtime settings for a standard login run."
                  : "Choose a job type and configure the runtime settings for this run."}
            </p>
          </div>
          <button onClick={onClose} className="self-start pt-0.5 text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>
        {!forcedCodexLogin && !forcedLogin && (
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
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Concurrency">
            <input
              className={styles.input}
              type="number"
              min={1}
              value={registerConcurrencyInput}
              onChange={(e) => setRegisterConcurrencyInput(e.target.value)}
            />
          </Field>
          <Field label="Proxy Group">
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={proxyTarget}
              onChange={(e) => setProxyTarget(e.target.value)}
            >
              <option value="">Local Network (Direct)</option>
              {draft.proxy_groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} · {group.mode === "round_robin" ? "Round Robin" : "Random"}
                </option>
              ))}
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
                value={countInput}
                onChange={(e) => setCountInput(e.target.value)}
              />
            </Field>
            <Field label="Password Mode">
              <select
                className={`${styles.input} ${styles.selectInput}`}
                value={draft.password_mode}
                onChange={(e) => setDraft({ ...draft, password_mode: e.target.value })}
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
                  onChange={(e) => setDraft({ ...draft, fixed_password: e.target.value })}
                />
              </Field>
            )}
          </div>
        )}
        {(!isRegisterFlow || forcedCodexLogin || forcedLogin) && (
          <div className="mt-3 grid gap-3 md:grid-cols-1">
            {!forcedCodexLogin && !forcedLogin && (
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
              </Field>
            )}
            <p className="text-sm text-slate-500">
              <span className="font-bold text-slate-800">{loginCandidates.length}</span>{" "}
              {forcedCodexLogin
                ? "selected mailboxes will be included in the Codex login job"
                : forcedLogin
                  ? "selected mailboxes will be included in the standard login job"
                  : "mailboxes will be included in the login job"}
            </p>
          </div>
        )}
        {isCodexFlow && (
          <div className="mt-3">
            <Field label="SMS Configuration">
              <select
                className={`${styles.input} ${styles.selectInput}`}
                value={smsConfigID}
                onChange={(e) => setSMSConfigID(e.target.value)}
              >
                <option value="">Select an SMS configuration</option>
                {draft.sms_configs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {smsOptionLabel(config)}
                  </option>
                ))}
              </select>
              {!selectedSMSExists && (
                <p className="mt-2 text-sm font-semibold text-rose-600">
                  Codex flows require a valid SMS configuration.
                </p>
              )}
              {selectedSMSConfig?.type === "pool" && (
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  Provider: {selectedSMSConfig.platform_label || "Phone Pool"}. Ready numbers: {poolReadyCount}. Remaining total uses: {selectedSMSConfig.pool_summary?.remaining_uses || 0}.
                </div>
              )}
              {smsCapacityError && (
                <p className="mt-2 text-sm font-semibold text-rose-600">{smsCapacityError}</p>
              )}
            </Field>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border bg-white px-3 py-2 font-bold">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={
              busy ||
              (isRegisterFlow ? unused.length === 0 : loginCandidates.length === 0) ||
              registerInputsInvalid ||
              !selectedSMSExists ||
              Boolean(smsCapacityError)
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
