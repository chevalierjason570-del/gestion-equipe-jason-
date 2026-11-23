import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gestion Équipe Jason",
  description: "Application de gestion d'équipe",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body style={{ margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
