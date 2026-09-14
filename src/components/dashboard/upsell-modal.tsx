import { X, Check, CloudLightning, Shield, Loader2, CheckCircle2, Sparkles, RefreshCw } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { usePaymentRefresh } from "@/hooks/use-payment-refresh";
import { useBrowserAuth } from "@/hooks/use-browser-auth";
import { useCheckout } from "@/hooks/use-checkout";
import { selectUpsellView, shouldAutoClose, shouldCelebrate } from "@/lib/upsell-state";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface UpsellModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function UpsellModal({ isOpen, onClose }: UpsellModalProps) {
    const userId = useAuthStore((s) => s.userId);
    const isPro = useAuthStore((s) => s.isPro());
    const { isWaiting, startPolling, stopPolling, manualRefresh } = usePaymentRefresh();
    const { startAuth, isAuthenticating } = useBrowserAuth();
    const { openCheckout: openCheckoutInBrowser, isOpening } = useCheckout();
    const [pendingUpgrade, setPendingUpgrade] = useState(false);
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
        celebratedRef.current = false; // nytt försök ska kunna firas igen
        setPaymentAttempted(true);
        startPolling();
    };

    // Uttrycklig avfärdning — nollställer betalförsöket så nästa öppning visar säljsidan.
    const dismiss = () => {
        setPaymentAttempted(false);
        stopPolling();
        onClose();
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
        if (pendingUpgrade && userId) {
            setPendingUpgrade(false);
            if (!isPro) openCheckout();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingUpgrade, userId, isPro]);

    // Städa polling när modalen stängs
    useEffect(() => {
        if (!isOpen) stopPolling();
    }, [isOpen, stopPolling]);

    if (!isOpen) return null;

    const handleUpgrade = async () => {
        // Ej inloggad → logga in först (konto krävs för Stripe-kundreferens),
        // fortsätt sedan automatiskt till checkout via pendingUpgrade-effekten.
        if (!userId) {
            setPendingUpgrade(true);
            startAuth();
            return;
        }
        openCheckout();
    };

    // "Har du redan Pro? Logga in" — ren inloggning utan köp-intent
    const handleLoginOnly = () => {
        if (!userId) startAuth();
    };

    // Rubrik och kropp läser SAMMA vy — det är enda sättet att göra det strukturellt
    // omöjligt för dem att säga emot varandra. Tidigare hade rubriken ett eget villkor.
    const view = selectUpsellView({ isPro, paymentAttempted, isWaiting });
    const activated = view === 'activated';

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-[480px] max-w-[90vw] shadow-2xl border border-line overflow-hidden relative animate-in zoom-in-95 slide-in-from-bottom-4 duration-300">
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
                            {activated ? "Pro aktiverat!" : "Uppgradera till Sagt Pro"}
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
                                    Molntranskribering, AI-protokoll och synk är upplåsta. Kvitto kommer via e-post.
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
                        /* Default / success state */
                        <>
                            <p className="text-sm text-ink-soft text-center mb-6">
                                Marknadens bästa svenska precision + färdiga mötesprotokoll.
                            </p>

                            <div className="bg-paper-dim border border-line rounded-xl p-5 mb-6">
                                <div className="flex items-center justify-between font-semibold text-ink mb-4 pb-4 border-b border-line">
                                    <span>Sagt.ai Pro</span>
                                    {/* Samma formulering som webbens PRO_PRICE (frontend/content/pricing.ts). Här stod
                                        "ex. moms" fram till 2026-09-14, i strid med sajten och KOSTNADER.md. */}
                                    <span className="text-brand">199 kr<span className="text-xs text-ink-muted font-normal"> / mån inkl. moms</span></span>
                                </div>
                                <ul className="space-y-3">
                                    {/* Ledargument — större modell = högre kvalitet (ryms inte lokalt → moln) */}
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Sparkles className="w-2.5 h-2.5" />
                                        </div>
                                        KB-Whisper Large — högre precision än vad som ryms lokalt
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        AI-mötesprotokoll — sammanfattning, beslut & åtgärder
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Synk mellan enheter
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-ink-soft">
                                        <div className="mt-0.5 w-4 h-4 rounded-full bg-verified/10 text-verified flex items-center justify-center flex-shrink-0">
                                            <Check className="w-2.5 h-2.5" />
                                        </div>
                                        Avbryt när du vill
                                    </li>
                                </ul>
                                <p className="text-[11px] text-ink-muted text-center mt-4 flex items-center justify-center gap-1.5">
                                    <Shield className="w-3 h-3 flex-shrink-0" />
                                    Körs på EU-servrar i Sverige. Ljud raderas automatiskt inom 24 h.
                                </p>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={dismiss}
                                    className="flex-1 py-2.5 px-4 rounded-lg bg-white border border-line text-sm font-medium text-ink-soft hover:bg-paper-dim transition-colors"
                                >
                                    Avbryt
                                </button>
                                <button
                                    onClick={handleUpgrade}
                                    disabled={isAuthenticating || isOpening}
                                    className="flex-[2] py-2.5 px-4 rounded-lg bg-brand border border-brand text-sm font-semibold text-paper hover:bg-brand-deep hover:border-brand-deep shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                >
                                    {isAuthenticating ? (
                                        <><Loader2 className="w-4 h-4 animate-spin" /> Loggar in...</>
                                    ) : isOpening ? (
                                        <><Loader2 className="w-4 h-4 animate-spin" /> Öppnar betalningen...</>
                                    ) : (
                                        "Uppgradera nu"
                                    )}
                                </button>
                            </div>

                            {!userId && (
                                <button
                                    onClick={handleLoginOnly}
                                    disabled={isAuthenticating}
                                    className="mt-3 w-full text-center text-xs text-ink-muted hover:text-ink-soft transition-colors disabled:opacity-50"
                                >
                                    Har du redan Pro? Logga in
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
