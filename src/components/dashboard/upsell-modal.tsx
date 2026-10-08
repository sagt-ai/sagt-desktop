import { X, Check, CloudLightning, Shield, Loader2, CheckCircle2, Sparkles, RefreshCw } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { useBrowserAuth } from "@/hooks/use-browser-auth";
import { useCheckout } from "@/hooks/use-checkout";
import { usePostHogEvents } from "@/hooks/use-posthog-events";
import { freeChoice, PRO_FOOTNOTE, PRO_ROWS, quotaLine, upsellHeading, selectUpsellView, shouldAutoClose, shouldCelebrate, shouldCloseAfterSignIn, type QuotaLineInput, type UpsellSource } from "@/lib/upsell-state";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { onUpsellDismissed } from "@/lib/feedback-runtime";

// Båda valen i fönstret har samma stil: gratiskontot och Pro ska vara lika tydliga.
const PRIMARY_BUTTON = "w-full py-2.5 px-4 rounded-lg bg-brand border border-brand text-sm font-semibold text-paper hover:bg-brand-deep hover:border-brand-deep shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2";

interface UpsellModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Varifrån modalen öppnades — följer med på tratt-eventen nedan. */
    source: UpsellSource;
    /** Gratiskontots räknare för kvotraden ("3 av 3 AI-protokoll"), när källan är en kvot. */
    quota?: QuotaLineInput | null;
}

export function UpsellModal({ isOpen, onClose, source, quota = null }: UpsellModalProps) {
    const events = usePostHogEvents();
    const userId = useAuthStore((s) => s.userId);
    // Gällande session. userId kan stå kvar efter att sessionen gått ut; vägen till ett
    // gratiskonto (inloggning) ska då ändå visas.
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const isPro = useAuthStore((s) => s.isPro());
    const { isWaiting, startPolling, stopPolling, manualRefresh } = usePaymentRefresh();
    // Inloggningen är gemensam för appen. Fönstret har en egen ägarnyckel och visar och
    // släpper bara sitt eget intresse, aldrig panelens "Logga in" eller ett annat fönsters.
    // En gemensam nyckel för alla instanser av fönstret (bara ett syns åt gången), så att ett
    // fönster som visas igen efter ett vybyte känner igen och kan släppa sin inloggning.
    const authOwner = "upsell";
    const { startAuth, stopAuth, setIntent, isWaiting: isMyAuthPending } = useBrowserAuth(authOwner);
    const { openCheckout: openCheckoutInBrowser, isOpening } = useCheckout();
    const [pendingUpgrade, setPendingUpgrade] = useState(false);
    // Senaste värdet för städningen när fönstret försvinner (effekten ser annars det första).
    const pendingUpgradeRef = useRef(false);
    pendingUpgradeRef.current = pendingUpgrade;
    const sourceRef = useRef(source);
    sourceRef.current = source;
    const [isChecking, setIsChecking] = useState(false);

    // Överlever pollingens 5-minuterstimeout, till skillnad från isWaiting.
    //
    // Tidigare styrde isWaiting hela vyn: när timeouten slog om föll modalen tillbaka till
    // säljsidan och "Jag har betalat"-knappen försvann. En kund vars Stripe-webhook dröjde
    // längre än fem minuter stod då utan väg framåt — och sedan 60-sekunderspollingen i
    // App.tsx togs bort (se use-session-refresh.ts) fanns ingen backstop kvar som fångade
    // aktiveringen automatiskt när fönstret redan hade fokus.
    const [paymentAttempted, setPaymentAttempted] = useState(false);

    // onClose skickas in som inline-arrow från split-view.tsx och byter alltså identitet vid
    // varje omrendering av SplitView — som renderar om ofta under live-transkribering. Effekter
    // nedan får därför aldrig ha onClose i sina beroenden.
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    // Engångsspärr för aktiveringsfirandet. Nödvändig just för att paymentAttempted (till
    // skillnad från isWaiting) inte självslocknar när betalningen går igenom: utan den skulle
    // varje omrendering fyra av en ny toast och skjuta stängningen framför sig.
    const celebratedRef = useRef(false);

    // Öppna Stripe-checkout. Backend kräver inloggning och knyter köpet till kontot;
    // fel visas av useCheckout, så här återstår bara att starta väntan när det lyckats.
    const openCheckout = async () => {
        if (!(await openCheckoutInBrowser())) return;
        events.checkoutOpened(source);
        celebratedRef.current = false; // nytt försök ska kunna firas igen
        setPaymentAttempted(true);
        startPolling();
    };

    // Uttrycklig avfärdning — nollställer betalförsöket så nästa öppning visar säljsidan.
    const dismiss = () => {
        const view = selectUpsellView({ isPro, paymentAttempted, isWaiting });
        events.upsellModalDismissed(source, view);
        onUpsellDismissed(view);
        close();
    };

    // Stäng och glöm ett påbörjat köp: ett "Uppgradera nu" som övergetts ska inte fortsätta
    // till betalningen vid en senare inloggning (till exempel från "Logga in" i panelen).
    const close = () => {
        setPaymentAttempted(false);
        forgetUpgrade(true);
        stopPolling();
        onClose();
    };

    // Ett påbörjat "Uppgradera nu" glöms: köpet kan inte fortsätta från ett stängt fönster.
    // Stänger användaren själv efter ett övergivet köp släpper fönstret sitt intresse i
    // inloggningen. Stängs eller försvinner fönstret utifrån får inloggningen fortsätta,
    // eftersom användaren kan vara mitt i den, men räknas som en gratisinloggning. En
    // gratisinloggning från fönstret avbryts inte av att fönstret stängs: användaren kan
    // vara mitt i den i webbläsaren.
    const forgetUpgrade = (release: boolean) => {
        if (pendingUpgradeRef.current || upgradeChosenRef.current) {
            if (release) stopAuth();
            else setIntent({ intent: 'free', source: sourceRef.current });
        }
        resetUpgrade();
    };
    // Det enda stället som nollställer ett påbörjat köp.
    const resetUpgrade = () => {
        setPendingUpgrade(false);
        upgradeChosenRef.current = false;
    };

    // Gratisvalet: ett val, inte en avfärdning, så ingen fråga om varför köpet uteblev.
    const chooseFree = () => {
        events.upsellFreeChosen(source);
        close();
    };

    const handleManualCheck = async () => {
        // Utan anslutning kan vi inte uttala oss om kontots tillstånd alls. Säg det i stället
        // för att låta doPoll:s false betyda "ingen prenumeration" — den som just betalat och
        // tappat nätet ska inte tro att köpet misslyckades och betala en gång till.
        if (!navigator.onLine) {
            toast.error("Ingen internetanslutning — kunde inte kontrollera betalningen.");
            return;
        }
        setIsChecking(true);
        try {
            const activated = await manualRefresh();
            // Lyckas den syns det via isPro (fira-effekten nedan) — bara utebliven
            // aktivering behöver sägas uttryckligen, annars ser knappen trasig ut.
            //
            // Formuleringen påstår medvetet inget om kontot: doPoll returnerar false både när
            // servern svarat "inte aktiv" och när anropet aldrig kom fram (fetch-felet fångas
            // i use-payment-refresh.ts). "Ingen bekräftelse än" är sant i båda fallen.
            if (!activated) {
                toast.info("Ingen bekräftelse än. Stripe kan behöva någon minut — försök igen strax.");
            }
        } finally {
            setIsChecking(false);
        }
    };

    // Pro aktiverat efter betalning → fira och stäng. Villkoras på paymentAttempted, inte
    // isWaiting, så att den som klickar "Jag har betalat" efter timeouten också får kvittot.
    //
    // Flaggan nollställs i stängningen — inte direkt — så rubriken hinner stå kvar på
    // "Pro aktiverat!" under de 1,5 sekunderna. Nollställningen är nödvändig: paymentAttempted
    // självslocknar inte som isWaiting gjorde, och lämnas den kvar visar en senare öppning av
    // modalen (split-view.tsx:647/733 öppnar den på 402 från servern, utan isPro-kontroll)
    // rubriken "Pro aktiverat!" ovanför säljsidan, med auto-stängningen nedan urkopplad.
    useEffect(() => {
        if (!shouldCelebrate({ isPro, paymentAttempted, alreadyCelebrated: celebratedRef.current })) return;
        celebratedRef.current = true;
        toast.success("Pro aktiverat! Välkommen till Sagt Pro.");
        const t = setTimeout(() => {
            setPaymentAttempted(false);
            onCloseRef.current();
        }, 1500);
        return () => clearTimeout(t);
    }, [isPro, paymentAttempted]);

    // Återvändande Pro-kund som loggat in (utan pågående betalning) → inget att sälja, stäng
    useEffect(() => {
        if (shouldAutoClose({ isPro, paymentAttempted, isOpen })) onCloseRef.current();
    }, [isOpen, isPro, paymentAttempted]);

    // Inloggning klar efter upgrade-intent → fortsätt automatiskt till Stripe
    useEffect(() => {
        if (pendingUpgrade && isSignedIn) {
            setPendingUpgrade(false);
            if (!isPro) openCheckout();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingUpgrade, isSignedIn, userId, isPro]);

    // Städa polling när modalen stängs. Stängs den utifrån (automatiskt efter inloggning
    // eller av föräldern) glöms också ett påbörjat köp, så att en senare inloggning inte
    // öppnar betalningen från ett stängt fönster. Inloggningen själv får fortsätta.
    useEffect(() => {
        if (!isOpen) {
            stopPolling();
            forgetUpgrade(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, stopPolling]);

    // Fönstret försvinner (vybyte): samma som en stängning utifrån.
    useEffect(() => () => forgetUpgrade(false),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []);

    // Inloggad vid öppningen? Läses en gång per öppning, så att en inloggning i fönstret
    // går att känna igen.
    const signedInAtOpenRef = useRef(false);
    // "Uppgradera nu" vald i den här öppningen. En ref och inte pendingUpgrade: den
    // nollställs i samma ögonblick som inloggningen landar, innan betalningen hunnit öppnas,
    // och då hade stängningen nedan slagit till mitt i köpet.
    const upgradeChosenRef = useRef(false);
    useEffect(() => {
        if (isOpen) {
            signedInAtOpenRef.current = isSignedIn;
            upgradeChosenRef.current = false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    // Inloggning utan köp från ett fönster om gratiskontot (kvotrad eller "konto först"):
    // inget mer att visa, stäng. Den som valde "Uppgradera" har pendingUpgrade och går
    // vidare till betalningen i effekten ovan.
    useEffect(() => {
        if (!shouldCloseAfterSignIn({
            source, isOpen, signedInAtOpen: signedInAtOpenRef.current,
            isSignedIn, pendingUpgrade: pendingUpgrade || upgradeChosenRef.current,
        })) return;
        toast.success("Du är inloggad.");
        onCloseRef.current();
    }, [source, isOpen, isSignedIn, pendingUpgrade]);

    // Tratten börjar här: en gång per öppning, med källan den öppnades från. Beror medvetet
    // bara på isOpen — source och userId läses vid öppningen, en senare inloggning i samma
    // öppning ska inte räknas som en ny. Pro-kunder räknas inte: auto-stängningen ovan
    // stänger modalen direkt för dem, så där finns ingen visning att mäta.
    useEffect(() => {
        if (isOpen && !isPro) events.upsellModalOpened(source, !!userId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    if (!isOpen) return null;

    const handleUpgrade = async () => {
        // Ett nytt klick medan fönstrets inloggning väntar öppnar bara fliken igen; det är
        // inte ett nytt beslut att köpa och räknas inte en gång till.
        if (!(pendingUpgrade && isMyAuthPending)) events.upgradeClicked(source, !!userId);
        // Ej inloggad → logga in först (konto krävs för Stripe-kundreferens),
        // fortsätt sedan automatiskt till checkout via pendingUpgrade-effekten.
        upgradeChosenRef.current = true;
        // Sessionen, inte userId: userId står kvar efter en utgången session.
        if (!isSignedIn) {
            setPendingUpgrade(true);
            startAuth({ intent: 'upgrade', source });
            return;
        }
        openCheckout();
    };

    // "Skapa gratiskonto / logga in" — inloggning utan köp. Samma inloggning i webbläsaren
    // skapar kontot om det inte finns, och loggar in ett befintligt (även Pro).
    const handleLoginOnly = () => {
        if (isSignedIn) return;
        // Ett tidigare, övergivet "Uppgradera nu" ska inte göra den här inloggningen till ett köp.
        resetUpgrade();
        // Fönstrets eget gratisval avstår från köpet: fönstrets avsikt blir free.
        startAuth({ intent: 'free', source });
    };

    // Rubrik och kropp läser SAMMA vy — det är enda sättet att göra det strukturellt
    // omöjligt för dem att säga emot varandra. Tidigare hade rubriken ett eget villkor.
    const view = selectUpsellView({ isPro, paymentAttempted, isWaiting });
    const activated = view === 'activated';
    const line = quotaLine({ source, isPro, quota });
    const free = freeChoice({ source, isPro, isSignedIn, quota });

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-[480px] max-w-[90vw] max-h-[95vh] overflow-y-auto shadow-2xl border border-line relative animate-in zoom-in-95 slide-in-from-bottom-4 duration-300">
                {/* Header — solid brand, no gradient */}
                <div className="h-32 bg-brand relative flex items-center justify-center p-6">
                    <button
                        onClick={dismiss}
                        className="absolute top-4 right-4 p-1.5 rounded-full bg-black/20 text-white/80 hover:bg-black/40 hover:text-white transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>

                    <div className="relative z-10 flex flex-col items-center text-white">
                        <div className="w-12 h-12 bg-white/20 backdrop-blur border border-white/30 rounded-full flex items-center justify-center mb-2 shadow-lg">
                            {activated
                                ? <CheckCircle2 className="w-6 h-6 text-verified" />
                                : <CloudLightning className="w-6 h-6 text-white" />
                            }
                        </div>
                        <h2 className="text-xl font-display font-bold tracking-tight">
                            {activated ? "Pro aktiverat!" : upsellHeading({ source, isSignedIn })}
                        </h2>
                    </div>
                </div>

                <div className="p-8">
                    {view === 'activated' ? (
                        /* Kvittot. Visas de ~1,5 sekunder modalen står kvar efter bekräftad
                           betalning. Utan den här grenen föll aktiveringen igenom till säljsidan,
                           så kunden fick "Pro aktiverat!" ovanför prislistan och "Uppgradera nu". */
                        <div className="flex flex-col items-center gap-4 py-4 text-center">
                            <div className="w-12 h-12 bg-verified/10 rounded-full flex items-center justify-center">
                                <CheckCircle2 className="w-6 h-6 text-verified" />
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-ink">Betalningen är bekräftad</p>
                                <p className="text-xs text-ink-muted">
                                    Molntranskribering, AI-protokoll, synk och export är upplåsta. Kvitto kommer via e-post.
                                </p>
                            </div>
                        </div>
                    ) : view !== 'sales' ? (
                        /* Betalning påbörjad. Vyn överlever pollingens timeout — 'awaiting-confirmation'
                           betyder att vi fortfarande pollar, 'confirmation-stalled' att vi väntar på
                           användaren. */
                        <div className="flex flex-col items-center gap-5 py-2 text-center">
                            <div className="relative">
                                {view === 'awaiting-confirmation' && (
                                    <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping opacity-25"></div>
                                )}
                                <div className="relative w-12 h-12 bg-brand/10 rounded-full flex items-center justify-center">
                                    {view === 'awaiting-confirmation'
                                        ? <Loader2 className="w-6 h-6 animate-spin text-brand" />
                                        : <RefreshCw className="w-6 h-6 text-brand" />
                                    }
                                </div>
                            </div>
                            <div className="space-y-1">
                                {view === 'awaiting-confirmation' ? (
                                    <>
                                        <p className="text-sm font-medium text-ink">Betalning öppnad i webbläsaren</p>
                                        <p className="text-xs text-ink-muted">Väntar på bekräftelse från Stripe...</p>
                                    </>
                                ) : (
                                    <>
                                        <p className="text-sm font-medium text-ink">Ingen bekräftelse än</p>
                                        <p className="text-xs text-ink-muted">
                                            Bekräftelsen från Stripe kan dröja några minuter. Har du betalat?
                                            Uppdatera här — annars kan du öppna betalningen igen.
                                        </p>
                                    </>
                                )}
                            </div>
                            <button
                                onClick={handleManualCheck}
                                disabled={isChecking}
                                className="text-sm font-medium text-brand hover:text-brand-deep underline underline-offset-2 disabled:opacity-60 disabled:no-underline flex items-center gap-2"
                            >
                                {isChecking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                {isChecking ? "Kontrollerar..." : "Jag har betalat — uppdatera nu"}
                            </button>
                            {view === 'confirmation-stalled' && (
                                <button
                                    onClick={openCheckout}
                                    disabled={isOpening}
                                    className="text-xs text-ink-soft hover:text-ink underline underline-offset-2 disabled:opacity-60"
                                >
                                    {isOpening ? "Öppnar betalningen..." : "Öppna betalningen igen"}
                                </button>
                            )}
                            <button
                                onClick={dismiss}
                                className="text-xs text-ink-muted hover:text-ink-soft"
                            >
                                Avbryt
                            </button>
                        </div>
                    ) : (
                        /* Säljsidan. För gratiskontots källor två tydligt åtskilda val: gratisvalet
                           och Pro, med samma knappstil och "eller" emellan, så att gratiskontot inte
                           kan förväxlas med ett köp. */
                        <>
                            {line && (
                                <p className="text-sm font-medium text-ink bg-amber-50 border border-amber-200/70 rounded-lg px-4 py-3 mb-4 text-center" role="status">
                                    {line}
                                </p>
                            )}
                            {free && (
                                <>
                                    <button
                                        onClick={free.action === 'sign_in' ? handleLoginOnly : chooseFree}
                                        className={PRIMARY_BUTTON}
                                    >
                                        {free.action === 'sign_in' && isMyAuthPending && !pendingUpgrade
                                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Väntar på inloggningen. Öppna igen</>
                                            : free.label}
                                    </button>
                                    <p className="text-xs text-ink-muted text-center mt-2">{free.caption}</p>
                                    <div className="flex items-center gap-3 my-5" role="separator" aria-label="eller">
                                        <div className="h-px flex-1 bg-line" />
                                        <span className="text-xs font-medium uppercase tracking-widest text-ink-muted">eller</span>
                                        <div className="h-px flex-1 bg-line" />
                                    </div>
                                </>
                            )}
                            <p className="text-sm text-ink-soft text-center mb-4">
                                Sagt Pro: vår största svenska modell och obegränsade mötesprotokoll.
                            </p>

                            <div className="bg-paper-dim border border-line rounded-xl p-5 mb-5">
                                <div className="flex items-center justify-between font-semibold text-ink mb-4 pb-4 border-b border-line">
                                    <span>Sagt.ai Pro</span>
                                    {/* Samma formulering som prissidan på sagt.ai. Här stod "ex. moms" fram till
                                        2026-09-14, i strid med sajten. */}
                                    <span className="text-brand">199 kr<span className="text-xs text-ink-muted font-normal"> / mån inkl. moms</span></span>
                                </div>
                                <ul className="space-y-3">
                                    {PRO_ROWS.map((row, i) => (
                                        <li key={row} className="flex items-start gap-3 text-sm text-ink-soft">
                                            <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                                {i === 0 ? <Sparkles className="w-2.5 h-2.5" /> : <Check className="w-2.5 h-2.5" />}
                                            </div>
                                            {row}
                                        </li>
                                    ))}
                                </ul>
                                <p className="text-[11px] text-ink-muted text-center mt-4 flex items-center justify-center gap-1.5">
                                    <Shield className="w-3 h-3 flex-shrink-0" />
                                    {PRO_FOOTNOTE}
                                </p>
                            </div>

                            <button
                                onClick={handleUpgrade}
                                disabled={isOpening}
                                className={PRIMARY_BUTTON}
                            >
                                {isMyAuthPending && pendingUpgrade ? (
                                    <><Loader2 className="w-4 h-4 animate-spin" /> Loggar in. Öppna igen</>
                                ) : isOpening ? (
                                    <><Loader2 className="w-4 h-4 animate-spin" /> Öppnar betalningen...</>
                                ) : (
                                    "Uppgradera nu"
                                )}
                            </button>

                            {!isSignedIn && !free && (
                                <button
                                    onClick={handleLoginOnly}
                                    className="mt-3 w-full text-center text-xs text-ink-muted hover:text-ink-soft transition-colors disabled:opacity-50"
                                >
                                    {isMyAuthPending && !pendingUpgrade
                                        ? "Väntar på inloggningen. Öppna igen"
                                        : "Skapa gratiskonto / logga in"}
                                </button>
                            )}
                            <button
                                onClick={dismiss}
                                className="mt-3 w-full text-center text-xs text-ink-muted hover:text-ink-soft transition-colors"
                            >
                                Avbryt
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
