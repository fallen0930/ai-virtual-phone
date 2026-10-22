import type { ReactNode } from "react";
import type { Viewport } from "next";

import { AndroidFullscreen } from "@/components/android-fullscreen";

export const viewport: Viewport = {
  themeColor: "#121110",
  colorScheme: "dark",
};

export default function WorldBuilderLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
html,
body {
  background: #121110 !important;
  color-scheme: dark;
}
`,
        }}
      />
      <AndroidFullscreen />
      {children}
    </>
  );
}
