# mpkzakrzowice — trwały zapis mapy bez płatnego dysku Render

Ta wersja zostawia usługę Render na planie Free i przechowuje mapę ulic w bazie PostgreSQL Neon Free. Dane mapy nie są zapisywane na lokalnym dysku Render.

## Co trzeba zrobić

1. **Nie wdrażaj poprzedniej wersji z `plan: starter` i dyskiem.** Użyj plików z tego pakietu.
2. Wejdź na https://console.neon.tech/ i utwórz projekt na planie Free.
3. W konsoli Neon wybierz Connect i skopiuj pooled connection string PostgreSQL. Powinien zawierać `sslmode=require`. Traktuj go jak hasło i nigdy nie wklejaj go do czatu ani do GitHuba.
4. W Render otwórz usługę `mpkzakrzowice-live` → **Environment** → dodaj zmienną `DATABASE_URL` i wklej connection string z Neon. Zapisz zmiany.
5. W swoim repozytorium GitHub `mpkzakrzowice-live` zastąp pliki `server.js`, `package.json`, `render.yaml` i `index.html` odpowiednikami z tego pakietu. Zatwierdź zmiany (Commit). Render powinien rozpocząć wdrożenie.
6. Sprawdź `https://mpkzakrzowice-live.onrender.com/health`. Pole `persistentStorageConfigured` powinno mieć `true`.
7. Otwórz stronę mapy, wklej eksport `OBRYSY:` z Roblox Studio, kliknij **Wczytaj podgląd**, potem **Zapisz mapę publicznie**. To zapisze mapę do bazy Neon.
8. Odśwież stronę; powinna sama wczytać mapę z bazy. W razie restartu lub ponownego wdrożenia dane mapy pozostaną w Neon.

## Ważne

- Neon oferuje obecnie bezpłatny plan z 1 GB bazy danych i limitem godzin obliczeniowych; po bezczynności baza może zasypiać, ale zapisane dane pozostają w bazie. Sprawdź aktualny limit w panelu Neon.
- Render Free nadal może zasypiać i po restarcie wyzeruje dane chwilowe, np. aktualne pozycje autobusów; mapa ulic jest przechowywana osobno w Neon i nie powinna znikać.
- Jeśli mapa zniknęła już przed konfiguracją Neon, odzyskasz ją tylko jeśli masz zapisany eksport `OBRYSY:` lub możesz wygenerować go ponownie w Roblox Studio.
- Nie zmieniaj `API_KEY` ani `MAP_ADMIN_KEY`, chyba że musisz je odtworzyć. `DATABASE_URL` ustawiaj wyłącznie w Render → Environment, nie commituj go do repozytorium.
