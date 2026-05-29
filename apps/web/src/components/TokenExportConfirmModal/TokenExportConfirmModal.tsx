import type { TokenExportConfirm } from "../../types";
import { Modal } from "../Modal/Modal";
import styles from "./TokenExportConfirmModal.module.css";

export function TokenExportConfirmModal({
  exportInfo,
  onClose,
  onConfirm,
}: {
  exportInfo: NonNullable<TokenExportConfirm>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="Confirm Token Export"
      subtitle={`Job #${exportInfo.jobId}`}
      onClose={onClose}
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-slate-700">
          <div className="text-base font-black text-slate-950">
            {exportInfo.count} records ready to export
          </div>
          <div className="mt-2 leading-6">
            Only successful mailboxes with generated tokens from this job will be exported.
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border bg-white px-3 py-2 font-bold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-slate-950 px-3 py-2 font-bold text-white"
          >
            Export
          </button>
        </div>
      </div>
    </Modal>
  );
}
