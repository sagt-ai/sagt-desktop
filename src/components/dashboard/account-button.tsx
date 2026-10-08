import { useEffect, useRef, useState } from "react";
import { Loader2, LogIn, LogOut, UserRound } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { useBrowserAuth } from "@/hooks/use-browser-auth";
import { accountControl, accountMenuItems } from "@/lib/account-control";
import { cn } from "@/lib/utils";

/**
 * Kontoplatsen i protokollpanelens rubrik. Samma runda knapp för alla, så att den tar
 * lika liten plats inloggad som utloggad: initialerna med kontomenyn för inloggad, en
 * neutral personikon med en meny som har "Logga in" för utloggad. Inloggningen är
 * densamma som uppgraderingsfönstrets gratisväg (webbläsaren, inget köp), och skapar
 * kontot om det inte finns.
 */
export function AccountButton() {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const email = useAuthStore((s) => s.email);
    const isPro = useAuthStore((s) => s.isPro());
    const clearSession = useAuthStore((s) => s.clearSession);
    const { startAuth, isAuthenticating } = useBrowserAuth("panel");
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    // Stäng menyn vid klick utanför och med Escape.
    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open]);

    const control = accountControl({ isSignedIn, isAuthenticating });
    const items = accountMenuItems(control);
    const signedIn = control === "menu";
    const initials = email ? email.split("@")[0].slice(0, 2).toUpperCase() : "?";
    const triggerLabel = signedIn
        ? (email || "Konto")
        : control === "signing_in" ? "Väntar på inloggningen" : "Logga in";

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "w-8 h-8 rounded-full text-xs font-semibold flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 focus:ring-offset-2",
                    signedIn
                        ? "bg-brand text-paper hover:bg-brand-deep"
                        : "bg-white border border-line text-ink-muted hover:text-ink-soft hover:border-ink-muted/40",
                )}
                title={triggerLabel}
                aria-label={triggerLabel}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                {signedIn
                    ? initials
                    : control === "signing_in"
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <UserRound className="w-4 h-4" />}
            </button>
            {open && (
                <div role="menu" className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-lg border border-line py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                    {signedIn && (
                        <div className="px-4 py-2 border-b border-line">
                            <p className="text-sm font-medium text-ink truncate">{email}</p>
                            <p className="text-xs text-ink-muted mt-0.5">{isPro ? "Sagt Pro" : "Gratiskonto"}</p>
                        </div>
                    )}
                    {items.includes("sign_out") && (
                        <button
                            role="menuitem"
                            onClick={() => { setOpen(false); clearSession(); }}
                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
                        >
                            <LogOut className="w-3.5 h-3.5" />
                            Logga ut
                        </button>
                    )}
                    {items.includes("sign_in") && (
                        // Klickbar även medan inloggningen väntar: ett nytt klick öppnar
                        // inloggningssidan igen, så att en stängd flik inte låser vägen in.
                        <button
                            role="menuitem"
                            onClick={() => { setOpen(false); startAuth({ intent: "free", source: "sign_in_button" }); }}
                            title={control === "signing_in" ? "Öppna inloggningen igen" : "Logga in eller skapa ett gratiskonto"}
                            className="w-full px-4 py-2 text-left hover:bg-paper-dim transition-colors flex items-start gap-2"
                        >
                            {control === "signing_in"
                                ? <Loader2 className="w-3.5 h-3.5 mt-0.5 text-brand animate-spin flex-none" />
                                : <LogIn className="w-3.5 h-3.5 mt-0.5 text-brand flex-none" />}
                            <span className="min-w-0">
                                <span className="block text-sm font-medium text-ink">
                                    {control === "signing_in" ? "Väntar på inloggningen..." : "Logga in"}
                                </span>
                                <span className="block text-xs text-ink-muted mt-0.5">Gratiskonto för AI-protokoll</span>
                            </span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
