# Sagt.ai Desktop changelog

This file is **for users**. It describes what has changed in the app, not how or
why it was built. Every entry is written by hand.

The changelog starts at 0.9.41. Earlier versions are not documented here.

---

## 0.10.5 — 2026-09-22

### Fixed

- **Cloud transcription could lose a passage when the server had trouble (Pro).**
  If the connection or the server failed for a few seconds, a passage could go
  missing from the transcript. The app now tries again for up to about 12 seconds
  before it gives up.

- **A passage that arrived late could end up out of order (Pro).** The transcript
  on screen was in the right order, but the saved text and the meeting analysis
  could have the late passage in the wrong place.

- **Text from the previous meeting could appear in the next one (Pro).** If you
  started a new recording right after stopping one, a late passage from the
  earlier meeting could end up in the new one.

## 0.10.4 — 2026-09-19

### Changed

- **Speaker separation is switched off for now.** Its options are hidden, and the
  app no longer uploads the meeting audio after every recording for no purpose.
  You and the meeting are still told apart as before.

### Fixed

- **Speaker names after short meetings (Pro).** Names for the speakers are now
  suggested even when you stop a recording shorter than a minute and a half, and
  they appear in the transcript right away.

## 0.10.3 — 2026-09-14

### Fixed

- **Upgrading from the trial banner was not tied to your account.** If you paid
  through the button in the banner, Pro could fail to appear after the purchase.
  The purchase is now always tied to the account you are signed in with, wherever
  in the app you upgrade.

- **The upgrade dialog showed the price as excluding VAT.** Pro costs 199 kr a
  month including VAT, just as on sagt.ai.

### Changed

- **You can no longer buy Pro twice by mistake.** If you already have a
  subscription — or have just paid and Pro has not shown up in the app yet — you
  are told so instead of being taken to a new payment.

- **The upgrade buttons show that the payment page is opening**, and say clearly
  when you need to sign in or have no internet connection.

## 0.10.2 — 2026-09-08

### Fixed

- **The computer could not go to sleep while the app was open.** Sagt.ai kept the
  meeting-audio channel running all the time, even when nothing was being
  recorded — which stopped the Mac from going to sleep and kept the speaker's
  audio engine awake around the clock. Meeting audio is now connected when you
  start recording and released when you stop.

- **Audio from a previous recording could end up in the next one.** Up to two
  seconds from the end of the previous recording could carry over into the start
  of the next transcript. There was no way to see this in the app.

- **False warning about system audio.** If you started a recording with nothing
  playing on the computer — ordinary dictation — the app warned that meeting audio
  was not being captured, even though there was nothing to capture. The warning
  now appears only when audio is actually playing and the app is missing it.

- **Recordings that were lost without explanation.** If writing to disk failed,
  the recording could go completely silent, and so could every later recording
  until the app was restarted. You now get a clear error, and what has been
  recorded so far is saved.

- **A recording with no sound in it said nothing.** You are now told right away
  when a recording is empty or when your own microphone channel was silent,
  instead of finding out when you open the transcript.

### Added

- **A log file on Windows too.** The app now keeps the same kind of log file on
  Windows that the Mac has had since the previous version, under
  `AppData\Roaming\com.sagt.ai\logs\`. It describes what the app does — which
  audio devices are used and when something fails — so a problem can be diagnosed
  afterwards instead of having to be reproduced. **It never contains your audio or
  the text of your recordings.** The file rotates at 5 MB and never leaves your
  computer on its own.

### Changed

- **The log file writes much less when idle.** It used to fill up with one line
  per second even when nothing was happening, which meant real errors were
  overwritten within a day. The same space now lasts about a month.

## 0.10.1 — 2026-08-30

### Fixed

- **Recordings that produced nothing.** On the Mac, the microphone could fail to
  start if no other sound was playing on the computer. The recording appeared to
  start but showed no audio levels and produced no text, and the orange
  microphone indicator never appeared in the menu bar. If something started
  playing — a video, a meeting — it would suddenly wake up mid-recording. Trying
  again often worked, which made the fault hard to recognise.

  The microphone now starts right away, whether or not anything else is making
  sound.

### Changed

- **The app keeps a log file** under `Library/Application Support/com.sagt.ai/logs/`.
  It describes what the app does — which audio devices are used and when
  something fails — so a fault can be diagnosed afterwards instead of having to be
  reproduced. **It never contains your audio or the text of your recordings.** The
  file rotates at 5 MB and never leaves your computer on its own.

## 0.10.0 — 2026-08-29

### Added

- **Sagt.ai is now available for the Mac.** The same app as on Windows:
  recording, on-device transcription with KB-Whisper, and meeting audio from
  Teams, Zoom and Meet — without a bot joining the call.

  Requires **macOS 14.2 or later** and a Mac with **Apple Silicon** (M1 or
  later). Intel Macs are not supported.

  On first launch macOS asks for access to the microphone, and to system audio
  the first time you record a meeting. Both are needed for the other people in
  the meeting to be included.

  The app is notarised by Apple, so it opens without a security warning — even
  without an internet connection.

### Changed

- **The download page shows the right file for your computer.** Both versions are
  always available, so you can download the Mac file from a Windows computer and
  vice versa.
- **The installer size is now stated correctly.** The page used to say 165 MB; the
  Windows installer is 172 MB and the Mac file 178 MB.

### For Windows users

Nothing has changed in the app. This version exists because Windows and the Mac
are released together, with the same version number.

---

## 0.9.44 — 2026-08-05

### Fixed

- **Pro did not always show up right after payment.** If the payment took longer
  than five minutes, the app stopped checking, and the upgrade offer could stay
  for up to half an hour even though the purchase had gone through. The app now
  keeps checking, and the refresh-status button tells you what it found.
- **No confirmation after a successful purchase.** The upgrade dialog showed the
  price list again instead of confirming that Pro had been activated.
- **Network errors were described as a missing subscription.** Anyone without an
  internet connection was told that no subscription was found, and could believe
  the purchase had failed.

---

## 0.9.43 — 2026-08-01

### Fixed

- **Audio settings were not applied until you opened Settings.** If you had set a
  silence threshold or pause tolerance but had not visited the tab after a
  restart, the app used its own defaults — while the interface showed yours.
- **On-device transcription ran the Swedish model whatever language you chose.**
  Norwegian and English therefore quietly gave poorer text on-device. On-device
  transcription is now always Swedish, and the interface says so. Cloud
  transcription (Pro) really does switch model.

### Changed

- **The settings were rewritten.** Every setting now has one short visible line,
  and the consequences sit behind ⓘ instead of in running text.
- **The home view showed the mode in three places at once** while recording. Now
  it shows it in one.

### Added

- **"Open folder"** in Local storage and on the Recordings page.

---

## 0.9.42 — 2026-07-24

### Fixed

- **The microphone was held open for as long as the app was running**, not just
  while recording. That stopped other programs — including the web app — from
  recording, with the error "Could not start audio source", until Sagt was closed.
  The microphone is now opened only when it is needed.

---

## 0.9.41 — 2026-07-16

### Changed

- **Error reporting in the desktop app.** Until now we could not see when
  something broke for a user — a failed transcription gave a red box and nothing
  more. The app now reports error codes without any content, so that recurring
  problems can be found and fixed.
