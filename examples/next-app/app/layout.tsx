import type { ReactNode } from "react";
import { Providers } from "./providers";

export const metadata = { title: "Veranta SDK demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "ui-sans-serif, system-ui", margin: 0, background: "#0b0e14", color: "#e6e6e6" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
