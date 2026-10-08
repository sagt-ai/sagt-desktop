import { useState, useEffect } from "react";
import { Sidebar } from "./components/layout/sidebar";
import { ControlBar } from "./components/layout/control-bar";
import { TitleBar } from "./components/layout/title-bar";
import { SplitView } from "./components/dashboard/split-view";
import { AppGuard } from "./components/guard/AppGuard";
import { SettingsPage } from "./pages/settings-page";
import { RecordingsPage } from "./pages/recordings-page";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "./store/settings-store";
import { useSyncStore } from "./store/sync-store";
import { Toaster, toast } from "sonner";
import { useConnectivity } from "@/hooks/use-connectivity";
import { useSessionRefresh } from "@/hooks/use-session-refresh";
import { useUpdater } from "@/hooks/use-updater";
import { useCloudStream } from "@/hooks/use-cloud-stream";
import { useLiveSpeakerNaming } from "@/hooks/use-live-speaker-naming";
import { useLiveDiarize } from "@/hooks/use-live-diarize";
import { runStorageCleanup, getStorageUsage, formatBytes, GB, type CleanupResult } from "@/lib/storage";
import { MotdBanner } from "@/components/lifecycle/motd-banner";
import { TrialBanner } from "@/components/lifecycle/trial-banner";
import { AudioWarningBanner } from "@/components/lifecycle/audio-warning-banner";
import { FeedbackCard } from "@/components/feedback/feedback-card";
import { markErrorSeen, onAppStarted } from "@/lib/feedback-runtime";
import { startEntitlementsSync } from "@/store/entitlements-store";
import { CloudChoiceDialog } from "@/components/dashboard/cloud-choice-dialog";

function App() {
  useConnectivity();
  useUpdater();
  useCloudStream();
  useLiveSpeakerNaming();
  useLiveDiarize();
  useSessionRefresh();

  const [currentView, setCurrentView] = useState<'dashboard' | 'settings' | 'recordings'>('dashboard');

  // Inbjudan till frågorna även för den som redan spelat in tre möten.
  useEffect(() => { onAppStarted(); }, []);

  // Gratiskvoternas räknare följer sessionen: hämtas vid inloggning och vid varje
  // förnyelse, töms vid utloggning.
  useEffect(() => startEntitlementsSync(), []);

  // Lokal modell är standard för alla, även Pro. Molnmodellen är ett val (lägesväljaren,
  // Inställningar, eller engångsfrågan i CloudChoiceDialog efter uppdateringen).

  // Bootstrap av ljudmotorn. Både mikrofonvalet OCH VAD-inställningarna måste pushas
  // hit — Rust har egna defaults (tröskel 0.008, tystnad 800 ms) som annars gäller tills
  // användaren råkar öppna Inställningar-fliken, där den enda andra anropspunkten låg.
  // Effekten var tyst: en användare som ställt paustoleransen till 3 s fick 800 ms efter
  // varje omstart, utan att gränssnittet visade något annat än 3 s.
  useEffect(() => {
    const state = useSettingsStore.getState();
    invoke("init_audio_engine", { device: state.inputDevice }).catch(console.error);
    invoke("update_audio_settings", {
      threshold: state.vadThreshold,
      silenceMs: state.silenceDuration,
    }).catch(console.error);
  }, []);

  // Auto-gallring av ljudfiler enligt vald policy: vid appstart och efter varje sparad
  // inspelning (history-updated). Vid "Behåll allt" + stor diskanvändning visas i stället
  // en nudge — inget raderas utan aktivt val (offline-first: ljudet är enda kopian).
  useEffect(() => {
    const NUDGE_THRESHOLD_BYTES = 10 * GB;

    runStorageCleanup()
      .then(async (result) => {
        if (result !== null) return; // policy hanterade gallringen
        const usage = await getStorageUsage();
        if (usage.recordings_bytes > NUDGE_THRESHOLD_BYTES) {
          toast.warning(
            `Dina inspelningar tar ${formatBytes(usage.recordings_bytes)} på disken. ` +
            `Välj en gallringspolicy under Inställningar → Lagring.`,
            { duration: 12_000 }
          );
        }
      })
      .catch(console.error);

    const unlistenPromise = listen("history-updated", () => {
      runStorageCleanup().catch(console.error);
    });
    // Håll in-memory-state i synk: om gallringen träffar inspelningen som är öppen i
    // SplitView måste activeJob.audio_deleted uppdateras, annars ser guards stale data
    // och moln-uppladdning misslyckas med kryptiskt filfel.
    const unlistenCleaned = listen<CleanupResult>("storage-cleaned", (event) => {
      const { activeJob, setActiveJob, activeJobFromHistory } = useSyncStore.getState();
      if (activeJob?.id && event.payload.deleted_ids.includes(activeJob.id)) {
        setActiveJob({ ...activeJob, audio_deleted: true }, activeJobFromHistory);
      }
    });
    return () => {
      unlistenPromise.then((f) => f());
      unlistenCleaned.then((f) => f());
    };
  }, []);

  // Surface ljudmotor-fel (mik saknas, stream-bygge misslyckas) som toast istället för
  // tyst död. Rust återställer is_running=false vid fel så att en omstart/enhetsbyte
  // faktiskt försöker igen.
  useEffect(() => {
    const unlistenPromise = listen<string>("audio-error", (event) => {
      console.error("Audio engine error:", event.payload);
      toast.error("Ljudfel: " + event.payload, { duration: 8000 });
      markErrorSeen();
    });
    return () => { unlistenPromise.then((f) => f()); };
  }, []);

  // Graciös degradering (lat mic): micen kunde inte öppnas vid inspelningsstart — oftast
  // för att en annan app (webbmötet i webbläsaren, Teams/Zoom) håller den. Inspelningen
  // avbryts INTE; den fortsätter med enbart mötesljudet (MÖTET/loopback). Informativt
  // meddelande, inte ett fel — mötets övriga deltagare transkriberas ändå.
  useEffect(() => {
    const unlistenPromise = listen<string>("mic-unavailable", () => {
      toast.info(
        "Spelar in mötesljudet utan din egen mikrofonkanal — mikrofonen används av en annan app.",
        { duration: 8000 }
      );
    });
    return () => { unlistenPromise.then((f) => f()); };
  }, []);

  // Guardrail från ljudmotorn: inspelning pågår men inget systemljud fångas
  // (t.ex. Teams på annan endpoint, ljudutgång urdragen). Engångsvarning per
  // inspelning från Rust. Toast för uppmärksamhet + persistent banner (store) —
  // toasten försvinner efter 10 s men problemet kvarstår tills det åtgärdats.
  // audio-warning-cleared: systemljud flödar igen (t.ex. follow-the-audio-switch
  // hittade rätt endpoint) → släck bannern.
  useEffect(() => {
    const unlistenWarning = listen<string>("audio-warning", (event) => {
      console.warn("Audio engine warning:", event.payload);
      toast.warning(event.payload, { duration: 10000 });
      markErrorSeen();
      useSyncStore.getState().setAudioWarning(event.payload);
    });
    const unlistenCleared = listen("audio-warning-cleared", () => {
      useSyncStore.getState().setAudioWarning(null);
    });
    return () => {
      unlistenWarning.then((f) => f());
      unlistenCleared.then((f) => f());
    };
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-paper-dim text-foreground font-sans antialiased text-sm">
      <TitleBar />
      <div className="flex-1 min-h-0 w-full relative">
        <AppGuard>
          {/* Bannerna ligger över hela bredden, ovanför menyn och panelerna. Låg de bara
              över huvudytan tryckte de ned panelernas rubrikrad men inte menyns, och
              linjen under rubrikerna blev inte hel. */}
          <div className="flex flex-col h-full w-full overflow-hidden">
            <MotdBanner />
            <TrialBanner />
            <AudioWarningBanner />
            <div className="flex flex-1 min-h-0 w-full overflow-hidden">
              <Sidebar currentView={currentView} onViewChange={setCurrentView} />
              <main className="flex-1 flex flex-col h-full overflow-hidden relative">
                <div className="flex-1 overflow-hidden relative">
                  {currentView === 'dashboard' ? <SplitView /> :
                    currentView === 'settings' ? <SettingsPage /> :
                      <RecordingsPage onViewChange={setCurrentView} />}
                  <FeedbackCard />
                </div>
                <ControlBar onViewChange={setCurrentView} />
              </main>
            </div>
          </div>
          <CloudChoiceDialog />
        </AppGuard>
      </div>
      <Toaster richColors position="bottom-right" />
    </div>
  );
}

export default App;
