# Sagt.ai Desktop changelog

This file is **for users**. It describes what has changed in the app, not how or
why it was built. Every entry is written by hand.

The changelog starts at 0.9.41. Earlier versions are not documented here.

---

## 0.12.4 — 2026-10-25

### Added

- **Speaker names are suggested when you create a protocol.** If names come
  up in the meeting, or you list the participants in "Vilka är med?", the
  speakers are named in the transcript instead of only "DU" and "MÖTET". Click
  a name to change it. Nothing is suggested when the meeting gives no names.
  You can turn this off in Settings.

### Changed

- **Longer meetings can be transcribed in the cloud.** Before, cloud
  transcription stopped at about 8 minutes. Recordings that are too large to
  send as they are are now compressed first, to about a tenth of their size,
  so much longer meetings can be sent. Short meetings are sent unchanged. The
  recording on your computer is not changed, and a meeting that is longer than
  the cloud accepts gets a message with the limit instead of a failed upload.

---

## 0.12.3 — 2026-10-25

### Changed

- **Security updates to the components the app is built on.** The app
  framework, the libraries that secure its connections and several smaller
  libraries are updated to versions where known security issues are fixed.
  Nothing changes in how the app works, and the update installs as usual.

---

## 0.12.2 — 2026-10-22

### Fixed

- **A meeting could be lost if the app closed while it was still transcribing.**
  The recording used to be saved only once all of its text was ready. On a slow
  computer that could take minutes after you pressed Stop, and closing the app,
  restarting it for an update or pressing Cancel in that time lost the meeting.
  Now the meeting is saved as soon as you press Stop and the text fills in as it
  is ready. Cancel keeps the recording with the text that was finished.
- **Recordings interrupted by a crash or shutdown are recovered.** If the app
  stopped unexpectedly during or after a recording, the next start finds the
  audio and adds it to Recordings, marked as recovered.
- **Closing the app while a meeting is being saved now asks first.**
- **Text could still appear after pressing Cancel.** A few seconds after
  cancelling, text from the cancelled transcription could show up. It no longer
  does.
- **A transcription step that stops responding no longer stalls the rest.**
  If one part of a recording takes far too long to transcribe, it is skipped with
  a notice and the remaining text still arrives.
- **Deleting a recording while it was being transcribed left the app busy.**
  The app kept showing that it was processing, and asked about unsaved work when
  you closed it. It now returns to normal.
- **The diagnostic log stayed empty when the app was started from the Start
  menu.** This only mattered if you sent us a log file for support, but then the
  log was missing everything. It now records normally however the app is started.

## 0.12.1 — 2026-10-15

### Changed

- **A gentler note when the microphone has heard nothing.** If you only listen
  in a meeting and your microphone or headset suppresses background noise, the
  app used to warn after 30 seconds that the microphone picked up no sound, and
  the warning stayed until you spoke. Now it waits a minute, shows a short
  notice only, and says what to check if your own words do not appear.
- **A clearer note when local transcription takes a while.** While your computer
  finishes a long meeting, the note now shows how long the meeting was and how
  long you have been waiting, and explains that the computer decides the speed and
  the model decides the quality. When the text is done, a line above the
  transcript shows how long it took.

### Fixed

- **Opening Sagt again started a second copy of the app.** Clicking the app in
  the Start menu or on the taskbar while it was already running opened another
  instance next to the first. Now the window that is already open comes to the
  front, and a recording in progress carries on.
- **The copy button left the clipboard empty.** Clicking the copy icon on the
  transcript, summary, decisions or action items showed the check mark, but nothing
  was copied. The app now copies through the system clipboard and only shows the
  check mark once the text is actually there.

## 0.12.0 — 2026-10-11

### Added

- **Let your AI assistant read your meetings (MCP).** Under Settings you can let an
  AI assistant on this computer, such as Claude Desktop, Claude Code or Codex in the
  ChatGPT app, search and read your transcripts and meeting minutes. It is off until
  you turn it on, read-only, and never reaches your audio. When it is on, the text your
  assistant reads goes to that assistant's provider. Requires an account: 10 tool calls
  per day with a free account, unlimited on Pro.
- **A warning when your microphone hears nothing.** If the microphone picks up no
  sound after the first 30 seconds of a recording, the app tells you, so you can check
  which microphone is selected.

### Changed

- **Very short recordings without text are no longer saved.** A recording shorter
  than 3 seconds that produced no text is discarded instead of filling your list.

## 0.11.0 — 2026-10-08

### Added

- **A free account with AI meeting minutes.** Sign in with a free account to
  create up to 3 AI meeting minutes per month from your local transcript. The
  panel shows how many you have left. Recording and transcription still work
  without an account.
- **Export for free accounts.** A free account can export up to 10 times per
  month, also without an internet connection. The export dialog shows how many
  exports you have left. Exporting several meetings at once counts as one.
- **PDF export.** Transcripts and minutes can now be saved as PDF, in addition to
  Word, Markdown and text.
- **Resizable and collapsible panels.** Drag the edge between the transcript and
  the minutes, or the edge of the menu, to change the width. Double-click an edge
  to reset it. Each panel and the menu can be collapsed. Your layout is
  remembered.
- **Sign-in button.** When you are signed out, the round button at the top right
  opens a menu with "Logga in" (Sign in).

### Changed

- **Pro: choose where transcription runs.** The local model is now the default
  for everyone. Pro users can switch to the larger cloud model whenever they want
  higher accuracy. If you used the cloud model before, the app asks you once
  which one you want.
- **Clearer upgrade window.** The free account and Pro are shown as two separate
  choices.
- **Information banners span the whole window,** so the line under the panel
  headings stays straight.

## 0.10.10 — 2026-09-28

### Fixed

- **A failed AI analysis no longer replaces your summary.** If the analysis could
  not be completed, the app could save an empty summary over the one you already
  had. Your existing summary now stays, and the app tells you the analysis
  failed so you can try again.
- **Re-analysing an older synced recording works again.** When the cloud copy of
  a recording was no longer available, "Analysera igen" (Analyse again) showed an error. The app
  now analyses the transcript on your computer instead, and the recording is
  marked as local so you can sync it again.
- **Transcribing without analysis keeps your summary.** Sending a recording for
  cloud transcription only no longer clears an existing summary.

### Changed

- **Re-analysis uses the best transcript you have.** If a recording has a cloud
  transcript, it is used for re-analysis instead of the local one.
- **Clearer error messages.** Internal error codes are no longer shown in error
  messages.

## 0.10.9 — 2026-09-28

### Changed

- **Clearer wording in the feedback questions.** One of the questions now asks
  whether Sagt worked the way you expected, without referring to a particular
  occasion.

## 0.10.8 — 2026-09-27

### Added

- **Tell us what you think.** After you have transcribed a few meetings, a small
  card may ask if you would like to answer a few short questions about Sagt.
  Each question starts with thumbs up or down, and you can write as much or as
  little as you like. Answers are sent as you go, so you can stop at any time.
  Choose "Inte nu" (not now) and the card rests for two weeks, or "Nej tack"
  (no thanks) and it never asks again. It never appears on first launch, during a recording, or after an
  error. You can also open the questions yourself under Settings.
- **One question when you uninstall on Windows.** After a normal uninstall, your
  browser opens a page that asks what made you uninstall. Answering is optional.

### Fixed

- **A dismissed notice could come back.** If the app took a while to connect
  when it started, a notice you had already closed was shown again.

## 0.10.7 — 2026-09-27

### Added

- **Export transcripts and meeting notes to a file (Pro).** Save a meeting as
  Word (.docx), Markdown or plain text from the transcript view. In Recordings
  you can tick several meetings and export them together, either as one file
  per meeting in a zip or as one combined file in date order. You choose what to
  include: the transcript, the meeting notes, or both. Files are created on your
  computer and saved where you choose, so export works offline. Without Pro you
  can still copy the text to the clipboard.

## 0.10.6 — 2026-09-23

### Fixed

- **A short recording could end up with an empty transcript.** When you stopped
  a recording, the last thing said could be shown on screen but missing from the
  saved recording. In a short recording that could be all of it. The app now
  waits for the last passage before it saves.

- **Recordings without speech were listed as transcribed.** When there was no
  speech to find, the local model returned a placeholder instead of nothing. It
  was hidden in the transcript view but saved with the recording. Such
  recordings are now listed without a transcript.

- **Microphones and outputs that deliver 16-bit integer audio were read at the
  wrong level.** Transcription from such a device could be garbled or empty.

- **A cloud passage could be sent more than once (Pro).** If the app hit an
  error while adding a transcribed passage to the transcript, it sent the same
  passage again, up to four more times. Each time counted against your monthly
  cloud quota.

### Changed

- **Your e-mail address is no longer sent to our usage statistics.** When you
  are signed in, usage events are linked to your account ID and your plan only.

- **Usage statistics now say why a local recording has no text.** They include
  the audio level per channel and how many passages were transcribed, came back
  empty or failed. They never include the audio or the text.

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
