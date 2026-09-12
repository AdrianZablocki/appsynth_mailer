# appsynth_mailer — panel (Next.js) do wysyłki maili AppSynth

Układ repo: korzeń = aplikacja Next (dawne `audit/mailer-ui`), `mailer/` = dane panelu: szablony HTML, `defaults.json`,
`.env` (SMTP/IMAP), lokalna kopia `clients/`; `benchmarks/` = dane v0.4 (tylko odczyt). Dawny CLI `mailer/src/send.ts` usunięty
2026-09-12 — panel robi to samo (wysyłka, IMAP „Wysłane”, log). Lokalnie w `audit/` jest dowiązanie `mailer` → `mailer/`, a `AUDIT_ROOT`
w `mailer/.env` wskazuje na `audit/` (customers/, benchmarks/). Vercel: projekt `appsynth-mailer`, domena
`mailer.appsynth.pl`, deploy z CLI `npx vercel deploy --prod` (albo z GitHuba po podpięciu repo); `.vercelignore`
trzyma sekrety i dane klientów poza wysyłką. Rekordy klientów i log wysyłek: **Vercel Blob** `mailer-eu` (prywatny, region fra1/UE) — to samo źródło lokalnie
i na Vercelu, gdy w `.env.local` jest `BLOB_READ_WRITE_TOKEN` (`npx vercel env pull .env.local --environment development`).
Klucze: `clients/<domena>.json`, `mailer-log/<domena>.txt`. Lokalny `mailer/clients/` to kopia: `npm run clients:pull`
(Blob → pliki) / `npm run clients:push` (pliki → Blob). Bez tokenu panel pracuje na plikach (offline).
Załączniki z przeglądarki idą w pamięci z wysyłką; pliki z `customers/` tylko lokalnie. Decyzja 2026-09-11.

# Panel

Interfejs (Next.js) nad danymi w `mailer/`: rekordy klientów, podgląd szablonu z danymi klienta,
nowy klient z benchmarku v0.4, wysyłka testowa i do klienta. Pliki: `mailer/templates`, `mailer/clients`,
`mailer/defaults.json`, `mailer/.env`, `${AUDIT_ROOT}/customers/<domena>/` (załączniki lokalnie).

## Logowanie (Clerk, od 2026-09-11)

Cała apka i API tylko dla zalogowanych. Dwie warstwy: `src/proxy.ts` (sesja albo 401/redirect) oraz `guard()` z
`src/lib/api.ts` w każdej trasie API i `auth.protect()` na stronie głównej. Rejestracji w apce nie ma — kto może się
zalogować, decyduje **allowlista na instancji Clerka** (kod na maila albo Google). Klucze w `.env.local` (gitignore),
aplikacja Clerk `app_3JBL23l2J2NZjeDVj3pi3FBO3YY`. Nowy adres: `clerk api /allowlist_identifiers -d '{"identifier":"x@y"}'`.
Ta sama aplikacja Clerk obsługuje też `appsynth_invoice/` (invoice.appsynth.pl).

## Model danych (od 2026-09-11)

- **`mailer/clients/<domena>.json`** — jeden rekord na klienta: dane firmy i osoby (klucze = placeholdery szablonów),
  `to`, `from`, `notes` oraz sekcja `templates.<szablon>` z nadpisaniami dla konkretnego maila (`subject`, `attachments`,
  pola typu `GYLDIG_TIL`). Przepływ cold mail → follow-up → oferta to jeden rekord, trzy szablony.
- **`mailer/defaults.json`** — wartości domyślne per szablon (tematy z `[PLACEHOLDERAMI]`, ceny oferty).
- Skuteczne vars dla szablonu = `defaults[szablon]` < rekord < `rekord.templates[szablon]` (`src/lib/effective.ts`,
  ). W formularzu pola „dla szablonu X” zapisują się do sekcji `templates`, reszta do rekordu.

```
npm install
npm run dev        # http://localhost:1213
```

Zasady:
- „Wyślij test” idzie wyłącznie na `TEST_TO` z `mailer/.env`, temat z prefiksem `[TEST]`, bez logu.
- „Wyślij do klienta” wymaga wpisania domeny klienta w oknie potwierdzenia (odpowiednik `--really`),
  zapisuje kopię do IMAP „Wysłane” i dopisuje linię do `customers/<domena>/mailer-log.txt`.
- Wysyłka jest zablokowana, dopóki w szablonie zostaje jakikolwiek niewypełniony `[PLACEHOLDER]`.
- Brak wysyłki hurtowej — celowo. Jeden klient, jeden mail, jedna decyzja.

„Nowy klient z benchmarku” tworzy od razu `clients/<domena>.json` (istniejącego nie nadpisuje) z: firmą, domeną, gminą,
branżą, wynikiem, medianą branży i 3 najkosztowniejszymi niezaliczonymi checkami (mapa NB/EN w `src/lib/benchmark.ts`).
Imię, adres, konkurentów i obserwację AI uzupełniasz po ręcznych testach G.

Nadawca: selekt „od:” w nagłówku wybiera alias skrzynki z `FROM_ADDRESSES` w `mailer/.env`
(`Nazwa <adres>, Nazwa <adres>`; pierwszy = domyślny). Wybór zapisuje się w rekordzie jako `from`
Adres poza listą jest odrzucany. Logowanie SMTP/IMAP zawsze tym samym kontem —
sylwia@ jest aliasem skrzynki kontakt@.

Załączniki: checkboxy pokazują PDF/PNG z `customers/<domena>/` (bez `evidence/`) oraz `mailer/uploads/`.
„Dodaj plik z dysku…” wgrywa plik (PDF/PNG/JPG, do 15 MB) do `customers/<domena>/uploads/`, a gdy folderu klienta
nie ma — do `mailer/uploads/` (gitignore), i od razu dopina do `attachments`.

Vercel (decyzja 2026-09-11): vars i pliki klientów zostają lokalnie, na Vercelu formularz wypełnia się ręcznie,
a załącznik dodaje się z dysku. Cała warstwa dyskowa siedzi w `src/lib/store.ts`. Przenosiny = podmiana tego modułu (Blob/KV)
+ logowanie przed panelem. Do tego czasu tylko localhost.
