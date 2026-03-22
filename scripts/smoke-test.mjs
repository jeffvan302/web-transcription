import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3001";
const email = process.env.SMOKE_EMAIL || "theo@yt-asr.local";
const password = process.env.SMOKE_PASSWORD || "admin1234";
const startServer = process.argv.includes("--start-server");

const tempAudio = path.join(os.tmpdir(), "yt-asr-smoke.wav");
let serverProcess = null;

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with exit code ${code}`));
    });
  });
}

async function main() {
  try {
    if (startServer) {
      serverProcess = spawn("node", ["server/index.js"], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await delay(4000);
    }

    await runCommand("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", "-ar", "16000", tempAudio]);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (!loginResponse.ok) {
      throw new Error(`Login failed: ${loginResponse.status} ${await loginResponse.text()}`);
    }

    const setCookies = loginResponse.headers.getSetCookie();
    const cookieHeader = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");

    const formData = new FormData();
    const buffer = await fs.readFile(tempAudio);
    formData.append("title", "Smoke Test Audio");
    formData.append("source", "Local Smoke Test");
    formData.append("language", "en");
    formData.append("media", new Blob([buffer], { type: "audio/wav" }), "yt-asr-smoke.wav");

    const importResponse = await fetch(`${baseUrl}/api/import/media`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
      },
      body: formData,
    });
    if (!importResponse.ok) {
      throw new Error(`Media import queue failed: ${importResponse.status} ${await importResponse.text()}`);
    }

    const queued = await importResponse.json();
    const jobId = queued.job.id;
    let completed = null;

    for (let index = 0; index < 30; index += 1) {
      await delay(1000);
      const jobsResponse = await fetch(`${baseUrl}/api/jobs`, {
        headers: {
          Cookie: cookieHeader,
        },
      });
      const jobsPayload = await jobsResponse.json();
      const current = jobsPayload.jobs.find((job) => job.id === jobId);
      if (current && (current.status === "completed" || current.status === "failed")) {
        completed = current;
        break;
      }
    }

    const stateResponse = await fetch(`${baseUrl}/api/state`, {
      headers: {
        Cookie: cookieHeader,
      },
    });
    const statePayload = await stateResponse.json();

    console.log(
      JSON.stringify(
        {
          jobStatus: completed?.status ?? null,
          jobMessage: completed?.message ?? null,
          jobError: completed?.error ?? null,
          titleCount: statePayload.state.titles.length,
          firstTitle: statePayload.state.titles[0]?.title ?? null,
          firstAudio: statePayload.state.titles[0]?.audioUrl ?? null,
          firstWaveform: statePayload.state.titles[0]?.waveformUrl ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(tempAudio, { force: true });
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
