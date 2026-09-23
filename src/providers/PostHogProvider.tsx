import { useEffect } from 'react'
import posthog from 'posthog-js'
import { useAuthStore } from '@/store/auth-store'
import { captureEvent } from '@/hooks/use-posthog-events'
import { CURRENT_VERSION } from '@/lib/version'

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
        loaded: (ph) => {
            ph.register({ platform: 'desktop', app_version: CURRENT_VERSION })
            ph.capture('app_opened')
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
                captureEvent('sign_in_completed')
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
