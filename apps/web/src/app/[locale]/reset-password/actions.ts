"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function updatePasswordAction(locale: string, formData: FormData) {
  const password = String(formData.get("password") ?? "");

  if (password.length < 6) {
    redirect(`/${locale}/reset-password?error=passwordTooShort`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    const key = error.message.toLowerCase().includes("password") ? "passwordTooShort" : "genericError";
    redirect(`/${locale}/reset-password?error=${key}`);
  }

  redirect(`/${locale}`);
}
