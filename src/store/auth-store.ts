import { create } from "zustand"

interface UserMeta {
    id: string
    email: string | null
    stripe_status: string | null
    monthly_minutes_limit: number
    monthly_minutes_used: number
    trial_ends_at: string | null
}

interface AuthState {
    token: string | null
    userId: string | null
    email: string | null
    stripeStatus: string | null
    monthlyMinutesLimit: number
    monthlyMinutesUsed: number
    trialEndsAt: number | null
    expiresAt: number | null
    isSignedIn: boolean

    setSession: (token: string, user: UserMeta, expiresAt: number) => void
    clearSession: () => void
    getToken: () => string | null
    isPro: () => boolean
}

/** Pro = aktiv prenumeration. Läses av isPro() och av planbytesbevakningen för räknarna. */
export function isProStatus(stripeStatus: string | null | undefined): boolean {
    return stripeStatus === "active"
}

// Upsell-suppression, INTE entitlement: loadPersisted wipear hela sessionen
// (inkl. stripeStatus) när JWT:n gått ut, så en betalande kund offline ser ut
// som Free. Markören överlever expiry och läses bara av upsell-ytor för att
// inte visa "köp Pro" för någon som redan betalar. Låser aldrig upp funktioner.
export const WAS_PRO_KEY = "sagt_was_pro"

function loadPersisted(): Partial<AuthState> {
    try {
        const raw = localStorage.getItem("sagt_auth")
        if (!raw) return {}
        const data = JSON.parse(raw)
        if (data.expiresAt && Date.now() / 1000 > data.expiresAt) {
            localStorage.removeItem("sagt_auth")
            return {}
        }
        return data
    } catch {
        return {}
    }
}

const persisted = loadPersisted()

export const useAuthStore = create<AuthState>((set, get) => ({
    token: (persisted.token as string) ?? null,
    userId: (persisted.userId as string) ?? null,
    email: (persisted.email as string) ?? null,
    stripeStatus: (persisted.stripeStatus as string) ?? null,
    monthlyMinutesLimit: (persisted.monthlyMinutesLimit as number) ?? 1500,
    monthlyMinutesUsed: (persisted.monthlyMinutesUsed as number) ?? 0,
    trialEndsAt: (persisted.trialEndsAt as number) ?? null,
    expiresAt: (persisted.expiresAt as number) ?? null,
    isSignedIn: !!(persisted.token && persisted.expiresAt && (persisted.expiresAt as number) > Date.now() / 1000),

    setSession: (token: string, user: UserMeta, expiresAt: number) => {
        const trialEndsAt = user.trial_ends_at
            ? Math.floor(new Date(user.trial_ends_at).getTime() / 1000)
            : null
        const state = {
            token,
            userId: user.id,
            email: user.email,
            stripeStatus: user.stripe_status,
            monthlyMinutesLimit: user.monthly_minutes_limit ?? 1500,
            monthlyMinutesUsed: user.monthly_minutes_used ?? 0,
            trialEndsAt,
            expiresAt,
            isSignedIn: true,
        }
        localStorage.setItem("sagt_auth", JSON.stringify(state))
        // Senast server-bekräftade sanningen styr: aktiv prenumeration sätter
        // markören, uttryckligen icke-aktiv (churnad kund) rensar den så att
        // lapsed users blir upsellbara igen. clearSession rör den medvetet
        // inte — expiry/utloggning är exakt fallet markören ska överleva.
        if (user.stripe_status === "active") {
            localStorage.setItem(WAS_PRO_KEY, "1")
        } else {
            localStorage.removeItem(WAS_PRO_KEY)
        }
        set(state)
    },

    clearSession: () => {
        localStorage.removeItem("sagt_auth")
        set({
            token: null,
            userId: null,
            email: null,
            stripeStatus: null,
            monthlyMinutesLimit: 1500,
            monthlyMinutesUsed: 0,
            trialEndsAt: null,
            expiresAt: null,
            isSignedIn: false,
        })
    },

    getToken: () => {
        const s = get()
        if (!s.token || !s.expiresAt) return null
        if (Date.now() / 1000 > s.expiresAt) {
            get().clearSession()
            return null
        }
        return s.token
    },

    isPro: () => isProStatus(get().stripeStatus),
}))
