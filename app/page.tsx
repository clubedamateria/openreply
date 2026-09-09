import { redirect } from "next/navigation";

/** Site público removido: a raiz leva direto ao painel (ou ao login). */
export default function Home() {
  redirect("/dashboard");
}
