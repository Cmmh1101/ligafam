"use client";

import { useToast } from "./toast-context";

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => removeToast(toast.id)}
          className={`w-full max-w-md rounded-lg border px-4 py-3 text-left text-sm font-medium shadow-lg ${
            toast.variant === "success"
              ? "border-green-600 bg-green-50 text-green-700"
              : "border-red-600 bg-red-50 text-red-700"
          }`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
