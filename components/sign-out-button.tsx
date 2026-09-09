"use server";

import { signOut } from "@/lib/auth";

/** Server action used by the sidebar "Sair" form. */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
