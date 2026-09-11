import { clerkMiddleware } from '@clerk/nextjs/server';

/*
 Warstwa 1: proxy — wszystko poza /sign-in i ścieżkami Clerka wymaga sesji (API → 401 JSON, strona → redirect).
 Warstwa 2 (właściwa wg Clerka): każda trasa API woła guard() z lib/api.ts, a strona główna auth.protect().
 Kto może się zalogować, decyduje allowlista na instancji Clerka — bez rejestracji z ulicy.
*/
export default clerkMiddleware(async (auth, req) => {
  const path = req.nextUrl.pathname;
  if (path.startsWith('/sign-in') || path.startsWith('/__clerk')) return;
  const { userId } = await auth();
  if (userId) return;
  if (path.startsWith('/api/')) return Response.json({ error: 'Zaloguj się' }, { status: 401 });
  await auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
