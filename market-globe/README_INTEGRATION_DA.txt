TESS SPACE GLOBE V3.1 — KUN HTML, CSS OG JAVASCRIPT

INDEHOLDER: index.html, globe.css, globe.js, ugv-display.js, ugv-data.js, assets/*. Ingen Python, JSON, GitHub Actions eller serverkode.

INTEGRATION PÅ https://alexharibo.github.io/tess-space/index.html
1. Upload hele denne mappe som /tess-space/market-globe/ til GitHub Pages-repositoriet.
2. Åbn den eksisterende /tess-space/index.html.
3. Kopier indholdet af EMBED_IN_TESS_SPACE.html ind, hvor sektionen skal ligge.
4. Udskift eventuel gammel market/globe-sektion, så der ikke vises to.
5. Kontrollér på den publicerede side at iframe-stien matcher /tess-space/market-globe/index.html.

OBS: Et iframe er valgt for at undgå CSS-konflikter med den eksisterende hjemmeside.
Globe-animationen (Three.js), satellitter, kameraføring og billeder er taget uændret fra V3.0.

DATA
ugv-data.js indeholder senest anvendte tal (111.377, jan-aug 2026). Det er et statisk snapshot.
Automatisk opdatering kræver et ægte offentligt/autoriseret API, som tillader browseradgang (CORS).
Hvis dette senere bliver tilgængeligt: udfyld DATA_ENDPOINT i ugv-data.js med HTTPS URL.
API-svar skal være JSON: {"metric":"ukraine_ugv_logistics_casevac_missions_ytd","value":111377,"through":"2026-08"}.
Et dokumenteret API fra unmannedsystemstracker.com er IKKE verificeret. Ingen falsk live-forbindelse.
Kilden angiver CC BY-NC 4.0; afklar tilladelse til kommerciel genbrug af data.

TEST
Åbn index.html via GitHub Pages eller en lokal statisk webserver. Der skal være internetadgang til Three.js CDN.
