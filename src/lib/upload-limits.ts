/**
 * Största fil molnet tar emot per anrop (uppladdning för transkribering och talaridentifiering).
 *
 * Speglar serverns tak (31 MiB), och ett test i serverns svit fäller om de glider isär. Ett
 * större anrop avvisas innan det når servern, med ett svar webbvyn inte får läsa, så att
 * fetch bara ser "Failed to fetch". Kontrollen här ger i stället ett sant fel innan filen skickas.
 *
 * Inspelningar kodas till Opus före uppladdningen (ungefär 2 × 32 kbit/s), så taket räcker
 * till över en timme. Längden begränsas av molnets längdtak (`maxCloudJobMinutes`), inte av
 * storleken. WAV-vägen, som bara används för filer som inte kan kodas, når taket efter ungefär
 * 8 minuter i stereo, och MÖTET-kanalen till talaridentifieringen (mono-WAV) efter ungefär 17.
 */
export const MAX_UPLOAD_FILE_BYTES = 31 * 1024 * 1024;

/** `För stort: …` (samma prefix som serverns 413, se error-slug.ts), eller null om filen ryms. */
export function uploadTooLargeMessage(sizeBytes: number): string | null {
    if (sizeBytes <= MAX_UPLOAD_FILE_BYTES) return null;
    const mb = Math.ceil(sizeBytes / (1024 * 1024));
    const max = MAX_UPLOAD_FILE_BYTES / (1024 * 1024);
    return `För stort: Filen är ${mb} MB. Molnet tar emot högst ${max} MB per fil.`;
}

/** `För långt: …` när mötet är längre än molnets längdtak. Avrundat uppåt, så att 60,4 min inte står som 60. */
export function uploadTooLongMessage(durationSecs: number, maxMinutes: number): string {
    const min = Math.ceil(durationSecs / 60);
    return `För långt: Mötet är ${min} minuter. Molnet tar emot högst ${maxMinutes} minuter per möte.`;
}
