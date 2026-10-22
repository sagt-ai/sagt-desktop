/**
 * En inspelning raderades medan den fortfarande transkriberades. Ljudmotorn sparar då
 * aldrig något slutläge, så det som annars avslutar "Bearbetar…" kommer inte. Utan den
 * här hanteringen stod gränssnittet kvar som upptaget, och stängningen och uppdateraren
 * frågade om en inspelning som inte längre finns.
 */
export interface RemovedDeps {
    isRecording: boolean;
    markSaved(filePath: string): void;
    setIsProcessing(processing: boolean): void;
    setUploadStatus(status: "idle"): void;
}

export function settleRemovedRecording(filePath: string, deps: RemovedDeps): void {
    // Markören gäller den raderade inspelningen och tas bort oavsett.
    deps.markSaved(filePath);
    // En ny inspelning som redan startat ska inte få sitt tillstånd nollställt.
    if (deps.isRecording) return;
    deps.setIsProcessing(false);
    deps.setUploadStatus("idle");
}
