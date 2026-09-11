# appsynth_mailer — panel (Next.js) + CLI do wysyłki maili AppSynth

Układ repo: korzeń = aplikacja Next (dawne `audit/mailer-ui`), `mailer/` = CLI + szablony + `defaults.json`,
`benchmarks/` = dane v0.4 (tylko odczyt). Lokalnie w `audit/` są dowiązania `mailer` i `mailer-ui` → tu, a `AUDIT_ROOT`
w `mailer/.env` wskazuje na `audit/` (customers/, benchmarks/). Vercel: projekt `appsynth-mailer`, domena
`mailer.appsynth.pl`, deploy z CLI `npx vercel deploy --prod` (albo z GitHuba po podpięciu repo); `.vercelignore`
trzyma sekrety i dane klientów poza wysyłką. Na Vercelu: klienci/uploady niezapisywane, log w Vercel Blob
(`mailer-store`, `mailer-log/<klient>.txt`), załączniki z przeglądarki idą w pamięci z wysyłką.

# mailer-ui — panel do `mailer/`

Lokalny interfejs (Next.js) nad narzędziem `../mailer`: rekordy klientów, podgląd szablonu z danymi klienta,
nowy klient z benchmarku v0.4, wysyłka testowa i do klienta. Korzysta z tych samych plików co CLI
(`../mailer/templates`, `../mailer/clients`, `../mailer/defaults.json`, `../mailer/.env`, `../customers/<domena>/`).

## Logowanie (Clerk, od 2026-09-11)

Cała apka i API tylko dla zalogowanych. Dwie warstwy: `src/proxy.ts` (sesja albo 401/redirect) oraz `guard()` z
`src/lib/api.ts` w każdej trasie API i `auth.protect()` na stronie głównej. Rejestracji w apce nie ma — kto może się
zalogować, decyduje **allowlista na instancji Clerka** (kod na maila albo Google). Klucze w `.env.local` (gitignore),
aplikacja Clerk `app_3JBL23l2J2NZjeDVj3pi3FBO3YY`. Nowy adres: `clerk api /allowlist_identifiers -d '{"identifier":"x@y"}'`.
Ta sama aplikacja Clerk ma docelowo obsłużyć też `faktury/`.

## Model danych (od 2026-09-11)

- **`mailer/clients/<domena>.json`** — jeden rekord na klienta: dane firmy i osoby (klucze = placeholdery szablonów),
  `to`, `from`, `notes` oraz sekcja `templates.<szablon>` z nadpisaniami dla konkretnego maila (`subject`, `attachments`,
  pola typu `GYLDIG_TIL`). Przepływ cold mail → follow-up → oferta to jeden rekord, trzy szablony.
- **`mailer/defaults.json`** — wartości domyślne per szablon (tematy z `[PLACEHOLDERAMI]`, ceny oferty).
- Skuteczne vars dla szablonu = `defaults[szablon]` < rekord < `rekord.templates[szablon]` (`src/lib/effective.ts`,
  ta sama logika w CLI). W formularzu pola „dla szablonu X” zapisują się do sekcji `templates`, reszta do rekordu.
- Stare pliki `vars/` przeniesione do `mailer/vars-legacy/` (CLI: `--vars` nadal je czyta).

```
npm install
npm run dev        # http://localhost:1213
```

Zasady (te same co w CLI):
- „Wyślij test” idzie wyłącznie na `TEST_TO` z `mailer/.env`, temat z prefiksem `[TEST]`, bez logu.
- „Wyślij do klienta” wymaga wpisania domeny klienta w oknie potwierdzenia (odpowiednik `--really`),
  zapisuje kopię do IMAP „Wysłane” i dopisuje linię do `customers/<domena>/mailer-log.txt`.
- Wysyłka jest zablokowana, dopóki w szablonie zostaje jakikolwiek niewypełniony `[PLACEHOLDER]`.
- Brak wysyłki hurtowej — celowo. Jeden klient, jeden mail, jedna decyzja.

„Nowy klient z benchmarku” tworzy od razu `clients/<domena>.json` (istniejącego nie nadpisuje) z: firmą, domeną, gminą,
branżą, wynikiem, medianą branży i 3 najkosztowniejszymi niezaliczonymi checkami (mapa NB/EN w `src/lib/benchmark.ts`).
Imię, adres, konkurentów i obserwację AI uzupełniasz po ręcznych testach G.

Nadawca: selekt „od:” w nagłówku wybiera alias skrzynki z `FROM_ADDRESSES` w `mailer/.env`
(`Nazwa <adres>, Nazwa <adres>`; pierwszy = domyślny). Wybór zapisuje się w vars jako `from`, CLI czyta to samo
(`--from` nadpisuje). Adres poza listą jest odrzucany. Logowanie SMTP/IMAP zawsze tym samym kontem —
sylwia@ jest aliasem skrzynki kontakt@.

Załączniki: checkboxy pokazują PDF/PNG z `customers/<domena>/` (bez `evidence/`) oraz `mailer/uploads/`.
„Dodaj plik z dysku…” wgrywa plik (PDF/PNG/JPG, do 15 MB) do `customers/<domena>/uploads/`, a gdy folderu klienta
nie ma — do `mailer/uploads/` (gitignore), i od razu dopina do `attachments`.

Vercel (decyzja 2026-09-11): vars i pliki klientów zostają lokalnie, na Vercelu formularz wypełnia się ręcznie,
a załącznik dodaje się z dysku. Cała warstwa dyskowa siedzi w `src/lib/store.ts`. Przenosiny = podmiana tego modułu (Blob/KV)
+ logowanie przed panelem. Do tego czasu tylko localhost.
