import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAuthStore } from '@/store/auth-store';
import { usePaymentRefresh } from '@/hooks/use-payment-refresh';

/**
 * Säkerhetsnät för appen som står öppen och orörd.
 *
 * Måste vara **längre än backendens idle-fönster (~15 min)**. En kortare beat hindrar
 * servern från att någonsin skala till noll, och en varmhållen instans kostar per timme
 * oavsett hur billig själva requesten är. Den ursprungliga 60-sekundersvarianten höll
 * den vaken dygnet runt.
 */
const SAFETY_NET_MS = 30 * 60_000;

/**
 * Kortaste tid mellan två fokusdrivna refreshar. Utan den genererar snabb alt-tab
 * fram och tillbaka en storm av anrop.
 */
const MIN_GAP_MS = 60_000;

/**
 * Håller Pro-status och sessionsgiltighet färska utan att polla.
 *
 * Ersätter en `setInterval(manualRefresh, 60_000)`. Pollingen försvarade ett rent
 * kosmetiskt problem — backend returnerar redan 401 för raderade konton vid varje
 * riktig operation, så en raderad användare kan aldrig transkribera, ladda upp eller
 * synka oavsett vad desktopens UI visar. Det enda pollingen köpte var att gränssnittet
 * uppdaterades medan appen stod orörd.
 *
 * Fokusvarianten träffar rätt fall i stället: en mötesinspelare som ligger öppen i
 * bakgrunden hela dagen genererar ingen trafik alls, medan den som faktiskt används
 * uppdateras oftare än den gamla minuttimern gjorde.
 */
export function useSessionRefresh() {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const { manualRefresh } = usePaymentRefresh();

    // Senaste-ref så att effekten nedan kan bero enbart på isSignedIn. manualRefresh är
    // stabil idag (Zustand-metoderna den stänger över byter aldrig identitet), men skulle
    // den någon gång sluta vara det hamnar den i effektens beroenden och river då upp
    // fönsterlyssnaren vid varje refresh — en självmatande loop som är obehaglig att hitta.
    const refreshRef = useRef(manualRefresh);
    useEffect(() => { refreshRef.current = manualRefresh; }, [manualRefresh]);

    useEffect(() => {
        if (!isSignedIn) return;

        let cancelled = false;
        let lastRun = 0;

        const run = (force: boolean) => {
            const now = Date.now();
            if (!force && now - lastRun < MIN_GAP_MS) return;
            lastRun = now;
            refreshRef.current();
        };

        run(true); // vid appstart och vid inloggning

        const timer = setInterval(() => run(true), SAFETY_NET_MS);

        // getCurrentWindow() kan kasta *synkront* om Tauri-kontexten saknas, och den här
        // effekten kör i App-roten — ett obehandlat kast skulle fälla hela appen. Timern
        // ovan är redan registrerad, så fokusdelen får misslyckas tyst.
        let unlisten: (() => void) | undefined;
        try {
            getCurrentWindow()
                .onFocusChanged(({ payload: focused }) => { if (focused) run(false); })
                .then((f) => {
                    // Effekten kan ha städats innan promisen löste — annars läcker lyssnaren.
                    if (cancelled) f(); else unlisten = f;
                })
                .catch(console.error);
        } catch (e) {
            console.error(e);
        }

        return () => {
            cancelled = true;
            clearInterval(timer);
            unlisten?.();
        };
    }, [isSignedIn]);
}
