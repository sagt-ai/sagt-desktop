import { useEffect } from 'react'
import posthog from 'posthog-js'
import { useAuthStore } from '@/store/auth-store'
import { captureEvent } from '@/hooks/use-posthog-events'
import { CURRENT_VERSION } from '@/lib/version'
import { recordingMarker } from '@/lib/recording-marker'
import { consumeSignInIntent } from '@/lib/sign-in-intent'

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://eu.i.posthog.com'

if (KEY) {
    posthog.init(KEY, {
        api_host: HOST,
        // Samma lagring som webben: `distinct_id` och `$device_id` i WebViewns
        // localStorage, som överlever omstarter (licensen ligger där av samma
        // skäl). LEK 9 kap. 28 § gäller även appar, inte bara webbläsare, så
        // samtyckesfrågan är öppen här också.
        persistence: 'localStorage',
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        // Ska stå kvar. Utan raden avgör PostHog-projektets inställning. Med
        // inspelning påslagen där laddar 1.372.1 inspelaren (CSP:n i
        // tauri.conf.json släpper igenom den) och skickar vyernas text,
        // transkript inräknade. Kört i en harness 2026-09-22. Webben fick
        // samma rad 2026-09-23.
        disable_session_recording: true,
        // Frågorna till användaren ställs av appens eget kort (components/feedback),
        // som fungerar utan nät och ser ut som appen. Utan raden kan en enkät som
        // skapas i PostHog dyka upp här ovanpå den.
        disable_surveys: true,
        loaded: (ph) => {
            ph.register({ platform: 'desktop', app_version: CURRENT_VERSION })
            ph.capture('app_opened')
            // En inspelning från förra körningen som aldrig sparades eller avbröts.
            recordingMarker.reportLeftover()
        },
    })
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        if (!KEY) return

        // Dataminimering: identify bär bara Clerk-id:t och planen, ingen e-post. Belagt i en
        // harness 2026-09-23: `$set` på `$identify` innehöll `email` före ändringen och
        // bara `plan` efter.
        // Identify immediately if session is already persisted on startup
        const { isSignedIn, userId, isPro } = useAuthStore.getState()
        if (isSignedIn && userId) {
            posthog.identify(userId, { plan: isPro() ? 'pro' : 'free' })
        }

        // Keep identify/reset in sync with auth state changes
        return useAuthStore.subscribe((state, prev) => {
            if (state.isSignedIn && !prev.isSignedIn && state.userId) {
                posthog.identify(state.userId, { plan: state.isPro() ? 'pro' : 'free' })
                // intent: 'free' (gratiskonto) eller 'upgrade' (köpet fortsätter), och
                // fönstrets källa, så att tratten går att följa per rätt. Saknas avsikten
                // startades inloggningen inte från uppgraderingsfönstret.
                const started = consumeSignInIntent()
                captureEvent('sign_in_completed', started ? { intent: started.intent, source: started.source } : {})
            } else if (!state.isSignedIn && prev.isSignedIn) {
                captureEvent('sign_out')
                posthog.reset()
                // Re-register device super properties — reset() clears them
                posthog.register({ platform: 'desktop', app_version: CURRENT_VERSION })
            }
        })
    }, [])

    return <>{children}</>
}
