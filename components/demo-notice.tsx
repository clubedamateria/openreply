"use client";

/**
 * Demo notice. Intentionally renders nothing: this instance is not a demo.
 * Props are kept so existing callers still compile.
 */
export function DemoNotice({ variant }: { variant: "banner" | "panel" }) {
  void variant;
  return null;
}
