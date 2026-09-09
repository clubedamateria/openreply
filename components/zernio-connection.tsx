"use client";

/**
 * Third-party connection provider panel. Intentionally renders nothing.
 * Export signature kept so existing callers still compile.
 */
export function ZernioConnection({ canManage }: { canManage: boolean }) {
  void canManage;
  return null;
}
