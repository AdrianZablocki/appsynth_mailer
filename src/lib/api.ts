import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

export const ok = (data: unknown) => NextResponse.json(data);
export const fail = (e: unknown, status = 400) =>
  NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });

/** Kontrola sesji na poziomie zasobu (zalecenie Clerka). Zwraca 401, gdy brak zalogowanego użytkownika. */
export async function guard(): Promise<NextResponse | null> {
  const { userId } = await auth();
  return userId ? null : NextResponse.json({ error: 'Zaloguj się' }, { status: 401 });
}
