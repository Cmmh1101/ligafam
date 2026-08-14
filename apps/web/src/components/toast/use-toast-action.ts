"use client";

import { useTransition } from "react";
import { useToast } from "./toast-context";

export function useToastAction<Args extends unknown[]>(
  action: (...args: Args) => void | Promise<void>,
  successMessage?: string
) {
  const [pending, startTransition] = useTransition();
  const { addToast } = useToast();

  function run(...args: Args) {
    startTransition(async () => {
      await action(...args);
      if (successMessage) addToast(successMessage, "success");
    });
  }

  return { pending, run };
}
