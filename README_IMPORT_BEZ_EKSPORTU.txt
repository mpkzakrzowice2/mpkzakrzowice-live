MPKZAKRZOWICE — odzyskanie mapy bez ręcznego kopiowania eksportu

Ta poprawka pozwala jednorazowo odtworzyć mapę z Roblox Studio bez wklejania tekstu OBRYSY do strony.

1. Zastąp server.js w GitHub plikiem server.js z tego pakietu i zatwierdź zmianę.
2. Poczekaj w Render na status Live. DATABASE_URL, API_KEY oraz MAP_ADMIN_KEY zostaw w Render Environment; nie publikuj tych sekretów w GitHub.
3. W Roblox Studio utwórz zwykły Script w ServerScriptService i wklej kod z mpkzakrzowice_map_upload.server.lua.
4. Opublikuj grę i uruchom ją normalnie przez Roblox Player. Script przeskanuje drogi i wyśle je w małych fragmentach do Neon.
5. W konsoli serwera (F9 > Server) poczekaj na komunikat: [mpkzakrzowice-import] SUKCES.
6. Następnie usuń tymczasowy Script mpkzakrzowice_map_upload z ServerScriptService w Studio i ponownie opublikuj grę. Nie usuwaj skryptu telemetrycznego autobusów.
7. Otwórz https://mpkzakrzowice-live.onrender.com/health. Oczekiwane: persistentStorageConfigured:true i mapSaved:true.

Jeśli API zgłosi 401, sprawdź, czy Creator Dashboard secret MPK_API_KEY jest identyczny z API_KEY na Render. Nie udostępniaj żadnego z tych kluczy.
