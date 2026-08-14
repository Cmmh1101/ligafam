"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useToast } from "./toast-context";

export function ToastFromSearchParam() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const { addToast } = useToast();
  const t = useTranslations();
  const toastKey = searchParams.get("toast");
  const consumedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!toastKey) {
      consumedRef.current = null;
      return;
    }
    if (consumedRef.current === toastKey) return;
    consumedRef.current = toastKey;
    addToast(t(toastKey), "success");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("toast");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastKey]);

  return null;
}
