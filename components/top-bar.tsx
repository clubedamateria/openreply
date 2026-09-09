"use client";

/**
 * Top Bar
 *
 * Page title, mobile hamburger, and connection status.
 */

import { usePathname } from "next/navigation";
import { AtSign, Menu } from "lucide-react";

const pageTitles: Record<string, string> = {
  "/dashboard": "Painel",
  "/funil": "Funil",
  "/overview": "Visão geral",
  "/inbox": "Caixa de entrada",
  "/campaigns": "Campanhas",
  "/campaigns/new": "Nova campanha",
  "/automations": "Campanhas",
  "/automations/new": "Nova campanha",
  "/logs": "Registros de DM",
  "/settings": "Configurações",
  "/diagnostics": "Diagnóstico",
};

interface TopBarProps {
  onMenuClick: () => void;
  instagramUsername: string | null;
  instagramAccountCount: number;
}

export default function TopBar({
  onMenuClick,
  instagramUsername,
  instagramAccountCount,
}: TopBarProps) {
  const pathname = usePathname();
  const title = pageTitles[pathname] ?? "Painel";

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 lg:px-8 border-b border-border bg-surface"
      // Installed to the home screen the app starts at the very top of the
      // display, so without this the title sits under the clock and battery.
      // The inset is 0 in a browser tab and on desktop.
      style={{
        height: "calc(4rem + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <button
          type="button"
          onClick={onMenuClick}
          className="lg:hidden btn btn-secondary shrink-0 !px-2.5 min-w-[44px]"
          aria-label="Abrir menu lateral"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <h1 className="truncate text-lg font-extrabold text-brand sm:text-xl">
          {title}
        </h1>
      </div>

      {instagramAccountCount > 0 ? (
        <span className="badge badge-info shrink-0 max-w-[50vw]">
          <AtSign size={14} aria-hidden="true" />
          <span className="truncate">
            {instagramAccountCount > 1
              ? `${instagramAccountCount} contas`
              : `@${instagramUsername}`}
          </span>
        </span>
      ) : (
        <a
          href="/api/instagram/connect"
          className="btn btn-primary btn-sm shrink-0 whitespace-nowrap min-h-[44px]"
        >
          <AtSign size={18} aria-hidden="true" />
          {/* Full label needs more room than a 360px header has to spare. */}
          <span className="sm:hidden">Conectar</span>
          <span className="hidden sm:inline">Conectar Instagram</span>
        </a>
      )}
    </header>
  );
}
