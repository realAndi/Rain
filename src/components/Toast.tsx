import { Component, For, createSignal, onCleanup } from "solid-js";

export type ToastVariant = "info" | "error" | "success" | "warning";

export interface ToastMessage {
  id: number;
  text: string;
  variant: ToastVariant;
  duration: number;
}

let _nextId = 0;
const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

export function showToast(
  text: string,
  variant: ToastVariant = "info",
  duration = 4000,
): void {
  const id = ++_nextId;
  setToasts((prev) => [...prev, { id, text, variant, duration }]);
  setTimeout(() => dismissToast(id), duration);
}

export function dismissToast(id: number): void {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

export const ToastContainer: Component = () => {
  return (
    <div class="toast-container">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={`toast toast-${toast.variant}`}
            onClick={() => dismissToast(toast.id)}
          >
            <span class="toast-icon">
              {toast.variant === "error"
                ? "!"
                : toast.variant === "success"
                  ? "\u2713"
                  : toast.variant === "warning"
                    ? "\u26A0"
                    : "\u2139"}
            </span>
            <span class="toast-text">{toast.text}</span>
          </div>
        )}
      </For>
    </div>
  );
};
