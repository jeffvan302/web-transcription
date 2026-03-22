# Web Transcription

This repository now contains a real full-stack baseline for the `yt-asr` web rewrite:

- React/Vite frontend
- Express backend API
- SQLite persistence for users, sessions, titles, drafts, audits, and jobs
- Server-managed file/object storage abstraction
- Background import jobs for YouTube, local media, and `.asr` packages
- Real audio extraction and waveform generation with `ffmpeg`
- Optional transcription through OpenAI or local Whisper

## Important Deployment Note

GitHub Pages can only host the static frontend build. It cannot host:

- authentication
- sessions
- the API
- background jobs
- file uploads
- server-side storage access
- media processing

That means GitHub Pages is useful only as a static preview. The real application needs a server runtime such as Railway.

## Local Development

1. Copy the environment template if you want custom settings:

```powershell
Copy-Item .env.example .env
```

2. Install dependencies:

```powershell
npm install
```

3. Run the frontend and backend together:

```powershell
npm run dev
```

Frontend runs on `http://localhost:4173` and proxies API requests to the backend on `http://localhost:3001`.

## Seeded Accounts

The database seeds these development users on first startup:

- `maya@yt-asr.local` / `maya1234`
- `jordan@yt-asr.local` / `jordan1234`
- `theo@yt-asr.local` / `admin1234`

## What Works

- real email/password login with server sessions
- server-enforced checkout and check-in rules
- server-persisted working drafts
- local media upload
- `.asr` archive import
- YouTube import job queue using `yt-dlp`
- working-audio extraction with `ffmpeg`
- waveform image generation with `ffmpeg`
- export current title as `.asr`
- export all titles as a zip bundle of `.asr` files
- admin storage configuration and connection testing

If transcription is unavailable, imports still succeed and create titles that can be edited manually.

## Optional Transcription Backends

You can enable either of these:

1. OpenAI Audio Transcription

```powershell
$env:OPENAI_API_KEY = "<your-key>"
```

2. Local Whisper via FFmpeg

```powershell
$env:WHISPER_MODEL_PATH = "C:\\path\\to\\ggml-base.en.bin"
```

If neither backend is available, uploaded/imported titles without subtitles are created with zero phrases so you can transcribe manually.

## Railway Deployment

This repo is now set up for Railway with the included [`railway.json`](/C:/Users/TheunisvanNiekerk/Code/Web_Transcription/railway.json), Docker build, and `/api/health` endpoint.

Recommended setup:

1. Create a Railway project from this GitHub repository.
2. Keep the default Dockerfile-based deployment.
3. Add a Railway Volume and mount it at `/app/data`.
4. Set `APP_BASE_URL` to your Railway public domain.
5. Optionally set `OPENAI_API_KEY` if you want automatic transcription.

Important notes:

- The app stores SQLite data, uploads, generated waveforms, and local object storage under `data/`, so a persistent volume is required for a real deployment.
- If you want to mount your volume somewhere else, set `APP_DATA_DIR` to the mounted path.
- Start with the admin storage provider set to `Local Disk` so uploaded assets stay on the mounted volume.
- Railway Buckets can be wired later through the admin storage settings because the backend supports S3-compatible object storage.
- Leave Railway Serverless disabled for this service for now. Background import/transcription jobs run inside the web process, so sleeping the service can interrupt long-running jobs.

## Smoke Test

This repo includes a small end-to-end smoke test that:

- starts the server
- signs in
- uploads a generated audio file
- waits for the background import
- confirms that a title, audio artifact, and waveform artifact were created

Run it with:

```powershell
node .\scripts\smoke-test.mjs --start-server
```

## Container Runtime

The included [`Dockerfile`](/C:/Users/TheunisvanNiekerk/Code/Web_Transcription/Dockerfile) builds the frontend and runs the Node server on port `3000`, which is suitable for Railway-style deployment.
