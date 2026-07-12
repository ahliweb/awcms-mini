/**
 * `openConfirmDialog` — client-side driver for `ConfirmDialog.astro`
 * (Issue #693, epic #679 platform-hardening).
 *
 * Replaces the `window.confirm(...)` / `window.prompt(...)` pairs used for
 * destructive actions across `admin/access-users.astro`,
 * `admin/tenant/domains.astro`, `admin/modules/[moduleKey].astro`,
 * `admin/security.astro`, and `admin/blog/posts/[id].astro` — native
 * browser dialogs cannot be styled/branded, do not fit the design system,
 * and (for the `window.prompt` "type a reason" case) provide no inline
 * validation feedback, only a second blocking native prompt. The
 * acceptance criterion this satisfies: "Aksi destruktif butuh konfirmasi
 * jelas dan feedback aman (pakai ConfirmDialog)" (Issue #693).
 *
 * Built on the native `<dialog>` element's own `showModal()` — which
 * already provides a real focus trap (Tab/Shift+Tab cycle within the
 * dialog, background made inert) and closes on Escape (`cancel` event)
 * without any hand-rolled JS for either (doc 14 §Aksesibilitas "Dialog
 * memerangkap fokus; Esc menutup; fokus kembali ke pemicu" — this function
 * captures `document.activeElement` before opening and restores it after
 * close, satisfying the third clause the native element does not handle
 * for us). One `ConfirmDialog.astro` instance is meant to be reused for
 * every row/action on a page (its title/body/reason-field text is
 * rewritten per call, not one dialog per row) — see that component's own
 * doc comment.
 *
 * A single dialog is only ever open once at a time from a given caller;
 * this module does not queue concurrent opens (out of scope — no current
 * admin screen needs two confirm dialogs open simultaneously).
 */

export interface ConfirmDialogOptions {
  /** Dialog heading text (e.g. "Delete role?"). */
  title: string;
  /** Dialog body/explanation text. */
  body: string;
  /** Overrides the confirm button's default label for this call. */
  confirmLabel?: string;
  /** Overrides the cancel button's default label for this call. */
  cancelLabel?: string;
  /** Shows a required reason textarea (e.g. delete reason) before confirm
   *  is accepted. */
  requireReason?: boolean;
  /** Label for the reason textarea, required when `requireReason` is true. */
  reasonLabel?: string;
  /** Inline validation message shown when the reason is left empty. */
  reasonRequiredError?: string;
}

export interface ConfirmDialogResult {
  confirmed: boolean;
  reason?: string;
}

export function openConfirmDialog(
  dialogId: string,
  options: ConfirmDialogOptions
): Promise<ConfirmDialogResult> {
  const dialog = document.getElementById(dialogId) as HTMLDialogElement | null;

  if (!dialog || typeof dialog.showModal !== "function") {
    // No dialog in the DOM (or an ancient/non-conforming browser without
    // `<dialog>` support) — fail closed, never proceed with a destructive
    // action silently.
    return Promise.resolve({ confirmed: false });
  }

  const titleEl = dialog.querySelector("[data-confirm-title]");
  const bodyEl = dialog.querySelector("[data-confirm-body]");
  const reasonField = dialog.querySelector(
    "[data-confirm-reason-field]"
  ) as HTMLElement | null;
  const reasonLabelEl = dialog.querySelector("[data-confirm-reason-label]");
  const reasonInput = dialog.querySelector(
    "[data-confirm-reason-input]"
  ) as HTMLTextAreaElement | null;
  const reasonError = dialog.querySelector(
    "[data-confirm-reason-error]"
  ) as HTMLElement | null;
  const cancelButton = dialog.querySelector(
    "[data-confirm-cancel]"
  ) as HTMLButtonElement | null;
  const acceptButton = dialog.querySelector(
    "[data-confirm-accept]"
  ) as HTMLButtonElement | null;

  if (titleEl) titleEl.textContent = options.title;
  if (bodyEl) bodyEl.textContent = options.body;
  if (acceptButton)
    acceptButton.textContent = options.confirmLabel ?? acceptButton.textContent;
  if (cancelButton)
    cancelButton.textContent = options.cancelLabel ?? cancelButton.textContent;

  const requireReason = options.requireReason ?? false;
  if (reasonField) reasonField.hidden = !requireReason;
  if (reasonLabelEl && options.reasonLabel) {
    reasonLabelEl.textContent = options.reasonLabel;
  }
  if (reasonInput) reasonInput.value = "";
  if (reasonError) {
    reasonError.hidden = true;
    reasonError.textContent = "";
  }

  const previouslyFocused = document.activeElement as HTMLElement | null;

  return new Promise((resolve) => {
    let settled = false;

    function cleanup(): void {
      cancelButton?.removeEventListener("click", onCancel);
      acceptButton?.removeEventListener("click", onAccept);
      dialog?.removeEventListener("cancel", onNativeCancel);
    }

    function finish(result: ConfirmDialogResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog?.open) dialog.close();
      previouslyFocused?.focus?.();
      resolve(result);
    }

    function onCancel(): void {
      finish({ confirmed: false });
    }

    // Fires when the user presses Escape — the browser's default action
    // (closing the dialog) still proceeds; we just also resolve the
    // promise as cancelled instead of leaving it hanging forever.
    function onNativeCancel(): void {
      finish({ confirmed: false });
    }

    function onAccept(): void {
      if (requireReason) {
        const value = reasonInput?.value.trim() ?? "";
        if (value.length === 0) {
          if (reasonError) {
            reasonError.textContent =
              options.reasonRequiredError ?? "This field is required.";
            reasonError.hidden = false;
          }
          reasonInput?.focus();
          return;
        }
        finish({ confirmed: true, reason: value });
        return;
      }
      finish({ confirmed: true });
    }

    cancelButton?.addEventListener("click", onCancel);
    acceptButton?.addEventListener("click", onAccept);
    dialog.addEventListener("cancel", onNativeCancel);

    dialog.showModal();
    (requireReason ? reasonInput : acceptButton)?.focus();
  });
}
