# Sagt.ai Desktop

**Free, private meeting transcription for Swedish. Runs on your own machine.**

[Download for Windows →](https://downloads.sagt.ai/Sagt.ai-setup.exe) (172 MB) · [Download for Mac →](https://downloads.sagt.ai/Sagt.ai-arm64.dmg) (178 MB)

[sagt.ai](https://sagt.ai) · Windows 10/11 · macOS 14.2+ (Apple Silicon) · MIT licensed

![Sagt.ai Desktop — real-time Swedish transcription](assets/screenshot.png)

Sagt.ai transcribes meetings in Swedish using **KB-Whisper**, the speech model trained by [KBLab](https://huggingface.co/KBLab) at Kungliga Biblioteket — the National Library of Sweden. On the free tier the model runs entirely on your own CPU: no audio upload, no account, no internet connection required.

It listens to **your computer's audio** rather than integrating with a meeting platform, so it works with Teams, Zoom, Skype, Google Meet and in-person conversations alike — and no bot ever appears in the participant list.

> **Early access:** This is a public beta. Expect rough edges. If something breaks, [open an issue](../../issues) — we read every one.

> **⭐ If this is useful to you, a star helps.** It is the main way small open source
> projects become findable — several directories that list open source software use a
> star threshold as their entry requirement, so it decides whether anyone else gets to
> discover the project at all.

---

## What it does

- **Records and transcribes in real time** — text appears as you speak, ~1–3 s latency
- **No bot in your meeting** — captures microphone + system audio directly. Nobody in the participant list knows you're taking notes
- **100% local on the free tier** — KB-Whisper Small runs on your own CPU. Zero audio leaves your machine
- **No account required** — no email, no password, no sign-up. Download, install, record
- **Installs without administrator rights** — works on a locked-down work laptop
- **Works offline** — no internet connection needed on the free tier
- **You and the meeting on separate channels** — your microphone and the computer's audio are transcribed apart, so the transcript shows what you said and what was said in the meeting
- **AI meeting protocol on Pro** — summaries, decisions and action items via Gemma 4 31B on Berget.ai's Swedish servers. Never outside Europe

## Free vs Pro

|  | Free | Pro (199 kr/month) |
|---|---|---|
| Local real-time transcription | ✅ Unlimited | ✅ |
| KB-Whisper Small (offline, on-device) | ✅ | ✅ |
| Captures Teams / Zoom / Skype / Meet audio | ✅ | ✅ |
| Works with no internet connection | ✅ | ✅ |
| Account required | ❌ None | Yes |
| AI meeting summary | — | ✅ |
| Key decisions & action items | — | ✅ |
| You and the meeting on separate channels | ✅ | ✅ |
| KB-Whisper Large (higher accuracy, cloud) | — | ✅ |
| Cloud transcription quota | n/a | 1,500 min/month |
| Data ever leaves the EU | ❌ Never | ❌ Never |

Local transcription is unlimited on both tiers — the quota applies only to cloud processing.

## Why a desktop app and not a website

A website cannot hear the audio of your other programs. An app can. That single fact is what makes the rest possible:

| | Cloud meeting bots | Sagt.ai |
|---|---|---|
| How it joins | A "Notetaker" bot enters the call | Captures your computer's own audio |
| Visible to other participants | Yes, in the participant list | No |
| Works with | Platforms it integrates with | Anything that makes sound, including in-person meetings |
| Where audio goes | The vendor's cloud | Your CPU (free tier) |
| Works offline | No | Yes |

## Why KB-Whisper?

KB-Whisper is trained by [KBLab](https://huggingface.co/KBLab) at [Kungliga Biblioteket](https://kb.se), the National Library of Sweden, on over 50,000 hours of Swedish speech. It outperforms OpenAI's general-purpose `whisper-large-v3` on Swedish audio — names, dialects and domain terminology included.

A generic multilingual model treats Swedish as one language among a hundred. A model trained by the institution that archives the language does not.

## Verify it yourself

This repository exists so you don't have to take our word for any of the above. The claims map to specific files:

| Claim | Where to check |
|---|---|
| Audio is captured locally and not uploaded | [`src-tauri/src/audio.rs`](src-tauri/src/audio.rs) |
| Transcription runs on-device via a bundled model | `whisper-cli` sidecar invocation in `src-tauri/src/` |
| Error reports contain no transcript text | [`src/lib/error-slug.ts`](src/lib/error-slug.ts) |
| What is sent to analytics | Search the source for `posthog.capture` |

You can also watch the network yourself while a local transcription runs: Task Manager → Resource Monitor → Network on Windows, or Activity Monitor → Network on a Mac.

## Privacy — what leaves your machine

**In local mode, your audio and transcripts never leave your machine.** Recordings are transcribed on your own CPU by a bundled KB-Whisper model — nothing is uploaded, and there is no cloud round-trip. That is the promise that matters, and you can verify it yourself in Resource Monitor on Windows, Activity Monitor on a Mac, or any network monitoring tool: no audio ever crosses the wire. The audio pipeline source is [`src-tauri/src/audio.rs`](src-tauri/src/audio.rs).

The app is **not** network-silent, though, and we would rather say so plainly than have you discover it in Resource Monitor. It also:

- **checks for updates** against [`downloads.sagt.ai/update-manifest.json`](https://downloads.sagt.ai/update-manifest.json),
- **fetches app config** on startup (minimum supported version, maintenance status, message of the day),
- **sends product analytics** to PostHog on EU servers — which events fired, on which app version, and a stable error code when something fails.

Some of these fire *while a local transcription is running*: if local processing runs long, the app records that a Pro hint was shown, and any error you see is reported as an error code.

**Analytics never carry audio, transcript text, or file names.** Error events send a stable slug such as `network_error` or `unauthorized` (see [`src/lib/error-slug.ts`](src/lib/error-slug.ts)) — never free-form error text, which could otherwise leak content. If you are signed in, these events are linked to your account rather than being anonymous.

There is currently **no in-app switch to turn analytics off**. If that matters to you, [open an issue](../../issues) — it is a fair thing to ask for. Full details: [Privacy Policy](https://sagt.ai/integritetspolicy).

### If you are evaluating this for an organisation

- [Data processing agreement](https://sagt.ai/en/dpa) (GDPR Article 28)
- [Complete subprocessor list](https://sagt.ai/en/subprocessors) — every vendor, what they see, which country
- [Plain-language data summary](https://sagt.ai/en/your-data)

Cloud-processed audio is deleted automatically within 24 hours; immediate deletion is available as a setting. Recordings and transcripts are **never** used to train AI models, ours or anyone else's. All subprocessors operate within the EU/EEA.

We hold **neither ISO 27001 nor SOC 2**, and do not claim to. What we offer instead is published documentation and source you can read.

## Known limitations

Stated plainly, so you can decide before downloading:

- **Apple Silicon Macs only.** The Mac build is arm64 — there is no Intel Mac build and no universal binary. macOS 14.2 or later is required, because the API used to capture meeting audio does not exist before it. No Linux build exists.
- **No file export.** Transcripts and summaries are copied to the clipboard; PDF and Word export are not implemented yet.
- **Speakers are told apart by channel only.** Everyone on the same channel appears as one speaker: the other people on a call as "Mötet" (the meeting), and people in the room with you as "Du" (you). Acoustic speaker separation ("Speaker 1, 2, 3") was switched off on 2026-09-18.
- **Swedish-first.** The bundled on-device model handles Swedish only. Norwegian and English are available through the cloud tier (Pro).
- **Public beta.** Expect rough edges.

## FAQ

**Does it work with Teams, Zoom and Skype?**
Yes, and with anything else that makes sound. Sagt captures your computer's audio output rather than integrating with a specific platform, so the meeting tool is irrelevant — including a conversation happening in the room.

**Do I need an account?**
Not for the free tier. No email address, no password, no sign-up. An account is only needed for Pro features (AI protocol, cloud sync).

**Does my audio leave my computer?**
Not on the free tier — transcription runs on your own CPU. On Pro, only the recordings you choose to process are uploaded, to servers in Sweden, and the audio files are deleted within 24 hours.

**Is it really free, or is it a trial?**
Free is free, with no time limit and no usage cap. Local transcription is unlimited.

**Does it work without internet?**
Yes. Recording and local transcription work fully offline.

**Which languages does it handle?**
The on-device model is Swedish. Norwegian (NB-Whisper) and English (Whisper large-v3) are available via the cloud tier.

**Do I need administrator rights to install it?**
No. It installs per-user, which means it works on a managed work laptop.

**Is there a Mac version?**
Yes, since v0.10.0 — the same app, released from the same version tag as Windows. It needs macOS 14.2 or later on an Apple Silicon Mac (M1 or newer); Intel Macs are not supported.

**Can I export to Word or PDF?**
Not yet — text is copied to the clipboard.

## Installation

**Windows 10 or 11 (64-bit)**, or **macOS 14.2+ on an Apple Silicon Mac**. There is no Intel Mac build and no Linux build.

### Windows

1. [Download the signed installer](https://downloads.sagt.ai/Sagt.ai-setup.exe) (172 MB)
2. Run `Sagt.ai-setup.exe` — signed with Azure Trusted Signing, so Windows shows a verified publisher: **EDI Labs AB**. No administrator rights needed
3. Launch Sagt.ai and start recording — no account, no email address

### macOS

1. [Download the disk image](https://downloads.sagt.ai/Sagt.ai-arm64.dmg) (178 MB)
2. Open it and drag Sagt.ai to Applications. The app is signed with an Apple Developer ID and notarised by Apple, so it opens without a security warning — including on a machine that is offline
3. On first launch macOS asks for microphone access, and for system audio the first time you record a meeting. Both are needed for the other participants to be captured

The app auto-updates in the background when a new version is available.

## Releases & build provenance

This repository is the **source mirror** for the desktop app — it exists so you can audit exactly what the app does. It is synced at every release and tagged with the same version as the official installer.

Official binaries are built, code-signed (Azure Trusted Signing) and published from the maintainers' release pipeline — **not** from this repository. By design, this repo contains **no release credentials, no signing keys and no publishing pipeline**; its CI only typechecks and compiles the code. This keeps the attack surface of the public repo at zero while the code stays fully reviewable.

## Build from source

Prerequisites: [Rust toolchain](https://rustup.rs) and [Node.js 20+](https://nodejs.org).

```bash
npm install
cp .env.example .env   # fill in your values
npm run tauri:dev      # opens the app with DevTools (F12) enabled
```

TypeScript check:
```bash
npx tsc --noEmit
```

> **Note:** The `ggml-kb-whisper-small.bin` model file is not included in this repository — it is fetched from a private bucket during official CI builds. For local development you can substitute any GGML-compatible Whisper model and place it at `src-tauri/resources/models/ggml-kb-whisper-small.bin`.

## Tech stack

- [Tauri v2](https://tauri.app) (Rust + WebView2 on Windows, WKWebView on macOS)
- React + TypeScript + Tailwind CSS
- [KB-Whisper](https://huggingface.co/KBLab) via local `whisper-cli` sidecar (beam-size 1, VAD-gated)
- System audio captured as a channel separate from the microphone — WASAPI loopback on Windows, Core Audio taps on macOS
- SQLite for local recording storage
- Cloud tier: KB-Whisper Large and Gemma 4 31B via [Berget.ai](https://berget.ai) (Swedish servers). Acoustic speaker diarization via pyannoteAI is switched off since 2026-09-18

---

## Changelog

What has changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Windows and macOS are both supported and ship from the same tag; Linux and Intel Mac PRs are welcome but review time is not guaranteed.

Security issues: see [SECURITY.md](SECURITY.md) — please do not open public issues for vulnerabilities.

## License

MIT — see [LICENSE](LICENSE).

"Sagt.ai" is a trademark of EDI Labs AB. Forks must use a different name and remove all Sagt.ai branding.
