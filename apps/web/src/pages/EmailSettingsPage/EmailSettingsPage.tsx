import { Mail } from "lucide-react";
import { useState } from "react";
import { Card } from "../../components/Card/Card";
import { Field } from "../../components/Field/Field";
import type { SettingsPayload } from "../../types";

export function EmailSettingsPage({
  settingsDraft,
  setSettingsDraft,
  saveSettings,
  busy,
}: {
  settingsDraft: SettingsPayload;
  setSettingsDraft: (settings: SettingsPayload) => void;
  saveSettings: (settings: SettingsPayload) => Promise<void> | void;
  busy: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const inputClass =
    "mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500";

  function update<K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]) {
    setSettingsDraft({ ...settingsDraft, [key]: value });
  }

  async function submit() {
    setSaving(true);
    try {
      await saveSettings(settingsDraft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="Email Settings"
      icon={<Mail size={18} />}
      actions={
        <button
          type="button"
          onClick={submit}
          disabled={busy || saving}
          className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy || saving ? "Saving..." : "Save Settings"}
        </button>
      }
    >
      <p className="text-sm text-slate-500">
        Configure the IMAP server and OTP polling behavior used for mailbox verification.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="IMAP Host">
          <input
            className={inputClass}
            value={settingsDraft.imap_host}
            onChange={(event) => update("imap_host", event.target.value)}
            placeholder="outlook.office365.com"
          />
        </Field>
        <Field label="IMAP Port">
          <input
            className={inputClass}
            type="number"
            min={1}
            value={settingsDraft.imap_port}
            onChange={(event) => update("imap_port", Number(event.target.value) || 0)}
            placeholder="993"
          />
        </Field>
        <Field label="IMAP Auth Mode">
          <select
            className={inputClass}
            value={settingsDraft.imap_auth_mode}
            onChange={(event) => update("imap_auth_mode", event.target.value)}
          >
            <option value="auto">Auto</option>
            <option value="password">Password</option>
            <option value="xoauth2">XOAUTH2</option>
          </select>
        </Field>
        <Field label="OTP Timeout (seconds)">
          <input
            className={inputClass}
            type="number"
            min={1}
            value={settingsDraft.otp_timeout_seconds}
            onChange={(event) =>
              update("otp_timeout_seconds", Number(event.target.value) || 0)
            }
            placeholder="180"
          />
        </Field>
        <Field label="OTP Poll Interval (seconds)">
          <input
            className={inputClass}
            type="number"
            min={1}
            value={settingsDraft.otp_poll_interval_seconds}
            onChange={(event) =>
              update("otp_poll_interval_seconds", Number(event.target.value) || 0)
            }
            placeholder="5"
          />
        </Field>
      </div>
    </Card>
  );
}
