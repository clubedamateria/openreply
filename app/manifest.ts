import type { MetadataRoute } from "next";

// Lets the app be installed to the home screen: on iOS via Share -> "Add to
// Home Screen", on Android through the install prompt. It then opens
// standalone, without browser chrome.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Clube da Matéria · Automações",
    short_name: "Clube",
    description: "Automações do Instagram do Clube da Matéria",
    start_url: "/overview",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f4c9c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
