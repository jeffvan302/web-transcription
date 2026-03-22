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

## Development Accounts

In non-production mode, the database seeds these development users on first startup:

- `admin` / `password`  (admin, forced to change password on first sign-in)
- `maya@yt-asr.local` / `maya1234`
- `jordan@yt-asr.local` / `jordan1234`
- `theo@yt-asr.local` / `admin1234`

In production, a bootstrap admin account is created by default as `admin` / `password`, and it is flagged to change the password on first sign-in. You can override that bootstrap account through environment variables such as:

- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_DISPLAY_NAME`

## What Works

- real email/password login with server sessions
- user administration, admin password reset, and self-service password change
- server-enforced checkout and check-in rules
- server-persisted working drafts with immediate save on important edit commits
- local media upload
- embedded subtitle track detection for uploaded media
- `.asr` archive import
- batch YouTube import job queue using `yt-dlp`
- working-audio extraction with `ffmpeg`
- waveform image generation with `ffmpeg`
- export current title as `.asr`
- export all titles as a zip bundle of `.asr` files
- admin storage configuration and connection testing
- interrupted background job recovery on process restart

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
- You can keep the admin storage provider on `Local Disk`, or preconfigure a hosted S3-compatible target at boot with `STORAGE_PROVIDER`, `STORAGE_BUCKET`, `STORAGE_PREFIX`, `STORAGE_ENDPOINT_URL`, `STORAGE_REGION`, `STORAGE_ADDRESSING_MODE`, `STORAGE_ACCESS_KEY_ID`, and `STORAGE_SECRET_ACCESS_KEY`.
- `STORAGE_ENDPOINT_URL` can be either a full URL or a bare hostname such as `s3.us-east-005.backblazeb2.com`; the server normalizes bare hostnames to HTTPS automatically.
- Railway Buckets or any S3-compatible provider can be wired through the admin storage settings because the backend supports S3-compatible object storage.
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
