import posthog from 'posthog-js'
import { toast } from 'sonner'
import type { UpsellSource, UpsellView } from '@/lib/upsell-state'

const enabled = !!import.meta.env.VITE_POSTHOG_KEY

export function captureEvent(event: string, props?: Record<string, unknown>) {
    if (enabled) posthog.capture(event, props)
}

/**
 * Gemensam chokepoint för användarvända fel: visar toasten OCH fyrar ett generiskt
 * `error_shown`-event med en stabil `code`-slug (härled via `errorSlug` i lib/api.ts).
 * `code` grupperar i PostHog — skicka ALDRIG fri text/PII som grupperingsnyckel.
 */
export function showError(
    code: string,
    message: string,
    props?: Record<string, unknown>,
    toastOptions?: Parameters<typeof toast.error>[1],
) {
    toast.error(message, toastOptions)
    captureEvent('error_shown', { surface: 'desktop', code, ...props })
}

export function usePostHogEvents() {
    return {
        recordingStarted: () =>
            captureEvent('recording_started'),

        recordingStopped: (durationSeconds: number) =>
            captureEvent('recording_stopped', { duration_seconds: durationSeconds }),

        transcriptionCompleted: (wordCount: number) =>
            captureEvent('transcription_completed', { word_count: wordCount }),

        // source: 'manual' (SplitView-knappen) | 'auto_stop' (auto-analys vid stopp)
        analysisRequested: (source: string = 'manual') =>
            captureEvent('analysis_requested', { source }),

        analysisCompleted: (source: string = 'manual') =>
            captureEvent('analysis_completed', { source }),

        analysisFailed: (error: string, source: string = 'manual') =>
            captureEvent('analysis_failed', { error, source }),

        // Klient-intent; backend emitterar auktoritativa 'speakers_identified' vid lyckat svar.
        speakersIdentifyRequested: () =>
            captureEvent('speakers_identify_requested'),

        upsellShown: (trigger: string) =>
            captureEvent('upsell_shown', { trigger }),

        // Uppgraderingstratten i desktop: modal öppnad → "Uppgradera nu" → (inloggning,
        // sign_in_completed) → Stripe öppnad i webbläsaren → payment_succeeded (server).
        // `source` säger varifrån modalen öppnades, se UpsellSource. `signed_in` skiljer
        // den som måste logga in först, eftersom det är ett eget steg där folk kan falla bort.
        upsellModalOpened: (source: UpsellSource, signedIn: boolean) =>
            captureEvent('upsell_modal_opened', { source, signed_in: signedIn }),

        upgradeClicked: (source: UpsellSource, signedIn: boolean) =>
            captureEvent('upgrade_clicked', { source, signed_in: signedIn }),

        checkoutOpened: (source: UpsellSource) =>
            captureEvent('checkout_opened', { source }),

        // view: vilket läge modalen stod i när den stängdes (UpsellView) — säljsidan,
        // eller väntan på Stripe-bekräftelse efter att betalningen öppnats.
        upsellModalDismissed: (source: UpsellSource, view: UpsellView) =>
            captureEvent('upsell_modal_dismissed', { source, view }),

        cloudSyncStarted: () =>
            captureEvent('cloud_sync_started'),

        cloudSyncCompleted: (wordCount: number) =>
            captureEvent('cloud_sync_completed', { word_count: wordCount }),

        cloudSyncFailed: (errorCode: string) =>
            captureEvent('cloud_sync_failed', { error_code: errorCode }),

        transcriptCopied: () =>
            captureEvent('transcript_copied'),

        settingsOpened: () =>
            captureEvent('settings_opened'),
    }
}
