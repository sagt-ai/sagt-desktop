/**
 * Frågan om molnmodellen efter uppdateringen till lokal standard. Ren funktion, testad i
 * cloud-choice.test.ts.
 *
 *  - `show`: Pro med molnmodellen som tidigare standard. Visa valet.
 *  - `wait`: ingen fråga väntar, utloggad, eller utan Pro. Ingenting ändras i tysthet:
 *    planen som sparats på datorn kan vara inaktuell (en betalning som just gått igenom),
 *    och utan Pro används molnmodellen ändå inte. Frågan står kvar tills kontot är Pro.
 */
export type CloudChoiceAction = "show" | "wait";

export function cloudChoiceAction(f: { pending: boolean; isSignedIn: boolean; isPro: boolean }): CloudChoiceAction {
    return f.pending && f.isSignedIn && f.isPro ? "show" : "wait";
}
