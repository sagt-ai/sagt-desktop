/**
 * Vad kontoplatsen i protokollpanelens rubrik visar. Ren funktion, testad i
 * account-control.test.ts.
 *  - `menu`: inloggad. Initialerna, med kontomenyn (e-post, plan, Logga ut).
 *  - `sign_in`: utloggad. En neutral personikon, med en meny som har "Logga in". Utan
 *    den finns ingen väg in utom uppgraderingsfönstret, och den som loggat ut kommer
 *    inte tillbaka.
 *  - `signing_in`: inloggningen pågår i webbläsaren.
 */
export type AccountControl = "menu" | "sign_in" | "signing_in";

export function accountControl(f: { isSignedIn: boolean; isAuthenticating: boolean }): AccountControl {
    if (f.isSignedIn) return "menu";
    return f.isAuthenticating ? "signing_in" : "sign_in";
}

/** Raderna i kontomenyn. Utloggad har alltid inloggningen, även medan den väntar. */
export type AccountMenuItem = "sign_out" | "sign_in";

export function accountMenuItems(control: AccountControl): AccountMenuItem[] {
    return control === "menu" ? ["sign_out"] : ["sign_in"];
}
