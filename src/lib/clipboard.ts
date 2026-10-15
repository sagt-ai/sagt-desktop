// Kopiera text till systemurklippet.
//
// Går via Tauris clipboard-plugin (nativt urklipp från Rust) i första hand.
// Uppmätt 2026-10-13 i appens webbvy på macOS: `navigator.clipboard.writeText`
// avvisas med NotAllowedError när ingen användargest är aktiv, medan pluginen
// lyckas. Kopiera-knappen väntade tidigare inte in svaret, så bocken visades
// fast urklippet förblev tomt. Webbläsarens API behålls som reserv för miljöer
// utan Tauri (t.ex. UI-harnessen).
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<void> {
    try {
        await writeText(text);
        return;
    } catch (err) {
        // Reserven nedan får avgöra; dess fel når anroparen. Pluginens fel loggas
        // så att orsaken syns om även reserven faller.
        console.warn("Urklipp via plugin misslyckades, provar webbläsarens API:", err);
    }
    await navigator.clipboard.writeText(text);
}
