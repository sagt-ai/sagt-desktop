import { create } from "zustand"
import type { SignInIntent, SignInSource } from "./sign-in-intent"

/**
 * Inloggningen i webbläsaren: en enda för hela appen, utanför komponenternas livscykel.
 *
 * Inloggningen tar ofta längre tid än användaren stannar i en vy. Låg pollningen i den
 * komponent som startade den, stoppades den när användaren bytte vy, och sessionen landade
 * aldrig i appen. Här lever den tills den lyckas, avbryts eller tar slut efter fem minuter.
 *
 * En inloggning har EN nonce. Ett nytt klick medan den pågår öppnar samma inloggningssida
 * igen (samma nonce), så det spelar ingen roll i vilken flik användaren loggar in. Varje
 * anropare (panelens knapp, ett fönster) har en egen ägarnyckel; den som avbryter släpper
 * bara sitt intresse, och inloggningen avbryts först när ingen längre väntar på den.
 * Ett svar med sessionen tas alltid emot, även om inloggningen hunnit avbrytas: servern
 * lämnar ut sessionen en gång, och användaren har då redan loggat in i webbläsaren.
 *
 * Ren modul utan Tauri-beroenden: det som når omvärlden skickas in (browser-auth.test.ts).
 */

export const POLL_INTERVAL_MS = 2500
export const POLL_TIMEOUT_MS = 300_000
/** Två klick inom den här tiden öppnar bara en flik (dubbelklick). */
export const REOPEN_DEBOUNCE_MS = 1500
/**
 * Högst så många förfrågningar samtidigt. Ingen tidsgräns per förfrågan: servern lämnar ut
 * sessionen en gång, så ett avbrutet svar vore en tappad inloggning. I stället får några
 * förfrågningar vara ute samtidigt, så att en hängd inte stoppar bevakningen.
 */
export const MAX_IN_FLIGHT = 3

/** Varför en ägare väntar på inloggningen, för `sign_in_completed`. */
export interface AuthIntent {
    intent: SignInIntent
    source: SignInSource
}

export interface BrowserAuthDeps {
    /** Öppnar inloggningssidan i webbläsaren. */
    openUrl: (url: string) => Promise<unknown>
    fetchFn: (url: string) => Promise<Response>
    /** Sessionen när inloggningen lyckats. */
    onSession: (data: any) => void
    /** Avsikten för den lyckade inloggningen, strax före onSession (se resolveIntent). */
    onIntent?: (intent: AuthIntent | null) => void
    apiBase: string
    frontendUrl: string
    newNonce?: () => string
    now?: () => number
}

/** `owners`: ägarnycklarna som väntar på inloggningen just nu. */
export const useBrowserAuthStore = create<{ isAuthenticating: boolean; owners: string[] }>(
    () => ({ isAuthenticating: false, owners: [] }),
)

let generation = 0
let nonce: string | null = null
/** En flik med den här noncen har öppnats. */
let opened = false
/** Flikar som håller på att öppnas. */
let pendingOpens = 0
let owners = new Set<string>()
/** Avsikten per ägare. Följer ägaren: den som släpper sitt intresse tar sin avsikt med sig. */
let intents = new Map<string, AuthIntent>()
let lastOpen = -Infinity
let inFlight = 0
/** Nytt vid varje klick: förfrågningar från förr räknas inte mot taket. */
let epoch = 0
let poll: ReturnType<typeof setInterval> | null = null
let timeout: ReturnType<typeof setTimeout> | null = null

function publish(): void {
    const next = [...owners]
    const prev = useBrowserAuthStore.getState().owners
    if (next.length === prev.length && next.every((h, i) => h === prev[i])) return
    useBrowserAuthStore.setState({ isAuthenticating: next.length > 0, owners: next })
}

/** Avbryter hela inloggningen. */
export function stopBrowserAuth(): void {
    generation++
    nonce = null
    opened = false
    pendingOpens = 0
    owners = new Set()
    intents = new Map()
    inFlight = 0
    lastOpen = -Infinity
    if (poll) { clearInterval(poll); poll = null }
    if (timeout) { clearTimeout(timeout); timeout = null }
    publish()
}

/** Släpper `owner`s intresse. Inloggningen avbryts när ingen längre väntar på den. */
export function stopBrowserAuthFor(owner: string): void {
    intents.delete(owner)
    if (!owners.delete(owner)) return
    if (owners.size === 0) stopBrowserAuth()
    else publish()
}

/** Ändrar ägarens avsikt utan att släppa dess intresse (ett köp som inte längre kan fortsätta). */
export function setBrowserAuthIntent(owner: string, intent: AuthIntent): void {
    if (owners.has(owner)) intents.set(owner, intent)
}

/**
 * Avsikten för en lyckad inloggning: ett köp om någon ägare väntar på ett (betalningen
 * fortsätter efter inloggningen), annars den senaste gratisavsikten.
 */
export function resolveIntent(all: AuthIntent[]): AuthIntent | null {
    return all.find(i => i.intent === "upgrade") ?? all[all.length - 1] ?? null
}

/** Startar inloggningen för `owner`, eller öppnar samma inloggning igen om den pågår. */
export function startBrowserAuth(deps: BrowserAuthDeps, owner: string, intent?: AuthIntent): void {
    const now = (deps.now ?? Date.now)()
    if (nonce === null) nonce = (deps.newNonce ?? (() => crypto.randomUUID()))()
    owners.add(owner)
    if (intent) { intents.delete(owner); intents.set(owner, intent) }
    publish()
    const mine = generation
    if (now - lastOpen < REOPEN_DEBOUNCE_MS) return
    lastOpen = now
    // Ett klick som öppnar fliken igen släpper förfrågningar som hängt sig (nätbyte,
    // viloläge) ur taket. Dubbelklick gör det inte, så taket går inte att klicka bort.
    epoch++
    inFlight = 0
    // Tidsgränsen räknas från senaste öppnade flik, även om webbläsaren aldrig svarar.
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => { if (mine === generation) stopBrowserAuth() }, POLL_TIMEOUT_MS)

    pendingOpens++
    const url = `${deps.frontendUrl}/desktop-auth?nonce=${nonce}`
    // Promise.resolve().then: ett synkront kast blir ett avvisat löfte och samma felväg.
    Promise.resolve().then(() => deps.openUrl(url)).then(
        () => { if (mine === generation) { pendingOpens--; opened = true } },
        (err) => {
            console.error("Failed to open browser:", err)
            if (mine !== generation) return
            pendingOpens--
            lastOpen = -Infinity
            // Ingen flik alls, och ingen på väg: det finns inget att vänta på, för någon.
            if (!opened && pendingOpens === 0) stopBrowserAuth()
        },
    )
    ensurePolling(deps, mine)
}

function ensurePolling(deps: BrowserAuthDeps, mine: number): void {
    if (poll) return
    poll = setInterval(async () => {
        if (mine !== generation || inFlight >= MAX_IN_FLIGHT || nonce === null) return
        const n = nonce
        const myEpoch = epoch
        inFlight++
        try {
            let res: Response
            try {
                res = await deps.fetchFn(`${deps.apiBase}/auth/desktop-poll?nonce=${n}`)
            } catch {
                return // nätfel, nästa varv försöker igen
            }
            if (res.ok) {
                let data: unknown
                try {
                    data = await res.json()
                } catch (e) {
                    console.error("Inloggningens svar gick inte att läsa:", e)
                    if (mine === generation) stopBrowserAuth()
                    return
                }
                // Tas emot även om inloggningen hunnit avbrytas (se ovan), men inte om en ny
                // inloggning startats sedan dess: användaren har då valt en annan (kanske ett
                // annat konto), och den gamla ska inte ta över.
                if (mine !== generation && nonce !== null) {
                    console.warn("Svar från en avbruten inloggning ignorerat: en ny pågår.")
                    return
                }
                const resolved = mine === generation ? resolveIntent([...intents.values()]) : null
                stopBrowserAuth()
                try {
                    deps.onIntent?.(resolved)
                    deps.onSession(data)
                } catch (e) {
                    console.error("Sessionen från inloggningen kunde inte sparas:", e)
                }
            } else if (res.status === 410 && mine === generation) {
                stopBrowserAuth() // inloggningen har gått ut hos servern
            }
            // 404 = inte klar än
        } finally {
            if (mine === generation && myEpoch === epoch) inFlight--
        }
    }, POLL_INTERVAL_MS)
}
