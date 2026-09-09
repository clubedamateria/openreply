import Image from "next/image";
import { MessageCircle, Send, Users } from "lucide-react";
import { EMAIL_PROVIDER_ID, PASSWORD_LOGIN, signIn } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { DemoNotice } from "@/components/demo-notice";

export const metadata = {
  title: "Entrar · Clube da Matéria",
  description: "Entre para gerenciar as automações do Instagram do Clube da Matéria.",
};

const bullets = [
  { icon: MessageCircle, text: "Responda comentários automaticamente por DM" },
  { icon: Send, text: "Envie links e materiais no momento certo" },
  { icon: Users, text: "Acompanhe leads do quiz em um só lugar" },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkEmail?: string;
    callbackUrl?: string;
    template?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const checkEmail = params.checkEmail === "1";
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";

  async function signInWithPassword(formData: FormData) {
    "use server";
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: callbackUrl,
    });
  }

  async function sendMagicLink(formData: FormData) {
    "use server";
    await signIn(EMAIL_PROVIDER_ID, {
      email: String(formData.get("email") ?? ""),
      redirectTo: callbackUrl,
    });
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-8 sm:px-6">
      <div className="w-full max-w-5xl grid gap-6 lg:grid-cols-2 lg:gap-8 animate-fade-in">
        {/* Brand panel */}
        <section className="brand-hero p-8 sm:p-10 flex flex-col items-center text-center lg:items-start lg:text-left lg:justify-center">
          <Image
            src="/brand/clube-logo.png"
            alt="Logo do Clube da Matéria"
            width={120}
            height={133}
            className="h-[120px] w-auto"
            priority
          />
          <h1 className="mt-5 text-3xl font-extrabold">Clube da Matéria</h1>
          <p className="mt-2 text-base leading-relaxed text-white/85 max-w-sm">
            Automações do Instagram: transforme comentários em conversas e leads
          </p>
          <ul className="mt-6 space-y-3 text-sm font-semibold w-full max-w-sm">
            {bullets.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span
                  className="icon-tile bg-white/15 text-white"
                  aria-hidden="true"
                >
                  <Icon size={20} />
                </span>
                <span className="text-left">{text}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Form panel */}
        <div className="flex flex-col justify-center">
          <DemoNotice variant="panel" />

          <div className="card p-6 sm:p-8">
            <h2 className="text-xl font-extrabold text-brand">Entrar</h2>
            <p className="mt-1 text-sm text-muted">
              {selectedTemplate
                ? `Entre para usar o modelo ${selectedTemplate.title}.`
                : "Acesse o painel de automações."}
            </p>

            {selectedTemplate && !checkEmail && (
              <div className="mt-5 rounded-[10px] bg-accent-soft p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-accent-hover">
                  Modelo selecionado
                </p>
                <p className="mt-1 text-sm font-bold text-foreground">
                  {selectedTemplate.title}
                </p>
              </div>
            )}

            {PASSWORD_LOGIN ? (
              <form action={signInWithPassword} className="mt-6 space-y-5">
                <div>
                  <label htmlFor="email" className="label">
                    E-mail
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    className="field"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="label">
                    Senha
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    className="field"
                    aria-describedby={params.error ? "login-error" : undefined}
                    aria-invalid={params.error ? true : undefined}
                  />
                  {params.error && (
                    <p id="login-error" className="mt-2 text-sm font-semibold text-error">
                      E-mail ou senha incorretos.
                    </p>
                  )}
                </div>
                <button type="submit" className="btn btn-primary w-full">
                  Entrar
                </button>
              </form>
            ) : checkEmail ? (
              <div className="mt-6 text-center py-4">
                <h3 className="text-lg font-extrabold text-brand mb-2">
                  Verifique seu e-mail
                </h3>
                <p className="text-sm text-muted">
                  Enviamos um link seguro de acesso. Abra-o neste dispositivo para
                  continuar.
                </p>
              </div>
            ) : (
              <form action={sendMagicLink} className="mt-6 space-y-5">
                <div>
                  <label htmlFor="email" className="label">
                    E-mail
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="voce@exemplo.com"
                    className="field"
                  />
                  <p className="helper">
                    Você receberá um link de acesso por e-mail.
                  </p>
                </div>
                <button type="submit" className="btn btn-primary w-full">
                  Enviar link de acesso
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
