# MixFrame Audio Studio

Editor audio multitraccia frontend-only realizzato con React e Vite.

## Novità dell’interfaccia

- timeline a tutta larghezza con intestazioni delle tracce fisse;
- barra strumenti verticale su desktop;
- comandi rapidi Taglia, Duplica ed Elimina;
- pannelli laterali per audio, modifica, effetti e progetto;
- controlli di zoom e modalità concentrazione;
- barra di riproduzione ed esportazione sempre visibile;
- interfaccia mobile dedicata con dock inferiore e pannelli a scorrimento;
- maniglie di ritaglio più grandi e facili da utilizzare su touchscreen;
- salvataggio progetto ed esportazione MP3/WAV raccolti nel menu Salva.

## Avvio locale

```bash
npm install
npm run dev
```

Apri l’indirizzo mostrato dal terminale, normalmente `http://localhost:5173`.

## Build

```bash
npm run build
```

## Deploy Vercel

Importa la cartella o la repository in Vercel usando:

- Framework: Vite
- Build command: `npm run build`
- Output directory: `dist`
