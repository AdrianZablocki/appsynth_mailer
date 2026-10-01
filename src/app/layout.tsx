import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const sans = Geist({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin', 'latin-ext'], weight: ['500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = { title: 'AppSynth Mailer', description: 'Podgląd, edycja i wysyłka szablonów maili' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <ClerkProvider>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
