"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function updateProfileAction(locale: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const fullName = String(formData.get("full_name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!fullName) {
    redirect(`/${locale}/profile?error=errors.fullNameRequired`);
  }

  const { error } = await supabase
    .from("profiles")
    .update({ full_name: fullName, phone: phone || null })
    .eq("id", user.id);

  if (error) {
    const key = error.code === "23505" ? "errors.phoneAlreadyInUse" : "errors.generic";
    redirect(`/${locale}/profile?error=${key}`);
  }

  revalidatePath(`/${locale}`);
  revalidatePath(`/${locale}/profile`);
}
