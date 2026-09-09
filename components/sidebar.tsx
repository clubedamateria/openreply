"use client";

/**
 * Sidebar Navigation
 *
 * Logo + wordmark, nav with icons and active state, workspace footer with sign out.
 */

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Filter,
  BarChart3,
  Inbox,
  Megaphone,
  MessageSquareText,
  Settings,
  Stethoscope,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { signOutAction } from "@/components/sign-out-button";

const navItems: { label: string; href: string; icon: LucideIcon }[] = [
  { label: "Painel", href: "/dashboard", icon: LayoutDashboard },
  { label: "Funil", href: "/funil", icon: Filter },
  { label: "Visão geral", href: "/overview", icon: BarChart3 },
  { label: "Caixa de entrada", href: "/inbox", icon: Inbox },
  { label: "Campanhas", href: "/campaigns", icon: Megaphone },
  { label: "Registros de DM", href: "/logs", icon: MessageSquareText },
  { label: "Configurações", href: "/settings", icon: Settings },
  { label: "Diagnóstico", href: "/diagnostics", icon: Stethoscope },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
}: SidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-foreground/40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 bg-surface border-r border-border flex flex-col
          transition-transform duration-200 ease-out
          lg:h-full lg:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Same reason as the top bar: the drawer is full height, so the
            wordmark would otherwise land under the status bar. */}
        <div
          className="px-5 py-4 border-b border-border"
          style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))" }}
        >
          <Link
            href="/dashboard"
            className="flex items-center gap-3 rounded-[10px] min-h-[44px]"
          >
            <Image
              src="/brand/clube-logo.png"
              alt=""
              aria-hidden="true"
              width={40}
              height={44}
              className="h-10 w-auto shrink-0"
              priority
            />
            <span className="min-w-0 leading-tight">
              <span className="block text-base font-extrabold text-brand truncate">
                Clube da Matéria
              </span>
              <span className="block text-xs text-muted truncate">
                Automações do Instagram
              </span>
            </span>
          </Link>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={isActive ? "page" : undefined}
                className={`
                  relative flex items-center gap-3 min-h-[44px] px-3 py-2.5 rounded-[10px] text-sm transition-colors
                  ${
                    isActive
                      ? "bg-brand-soft text-brand font-bold"
                      : "text-muted hover:text-foreground hover:bg-surface-hover font-semibold"
                  }
                `}
              >
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-accent"
                  />
                )}
                <Icon size={20} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-4 border-t border-border flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground truncate min-w-0">
            {workspaceName}
          </p>
          <form action={signOutAction}>
            <button type="submit" className="btn btn-ghost btn-sm min-h-[44px]">
              <LogOut size={18} aria-hidden="true" />
              Sair
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
