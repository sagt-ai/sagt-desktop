import { useState } from "react";

/**
 * Delad hook för mönstret "avfärda ett kort och kom ihåg valet över omstarter".
 *
 * Avfärdandet persisteras i localStorage under `key` (redan namespacead med
 * `sagt_`-prefix av anroparen). Returnerar `{ dismissed, dismiss }`.
 *
 * `token` styr *vad* som avfärdas — och därmed när kortet får visas igen:
 *   - utelämnad → boolean-läge. Nyckeln sätts till "1"; `dismissed` = nyckeln finns.
 *     (Pro-hinten: en gång avfärdad, för alltid dold.)
 *   - satt      → värde-läge. Nyckeln sätts till `token`; `dismissed` = lagrat === token.
 *     (MOTD-bannern: ett *nytt* meddelande = ny token = kortet visas igen trots
 *     att en tidigare version avfärdats.)
 *
 * Det lagrade värdet läses en gång vid mount, men jämförs mot `token` vid varje
 * rendering. Det spelar roll när token kommer först efter mount: vid kallstart
 * släpps appen in efter 4 s och motd kommer med bakgrundshämtningen. Jämfördes
 * värdet bara vid mount (mot "1", eftersom motd då var null) visades ett redan
 * avfärdat meddelande igen så fort det kom.
 */
export function useDismissible(key: string, token?: string | null) {
    // null/undefined token faller tillbaka på "1", så boolean-läget och ett
    // ännu-inte-laddat värde (t.ex. motd === null) beter sig identiskt med
    // originalen: lagrat === "1" är falskt när bara värde-tokens skrivits.
    const resolved = token ?? "1";
    const [stored, setStored] = useState(() => localStorage.getItem(key));

    const dismiss = () => {
        localStorage.setItem(key, resolved);
        setStored(resolved);
    };

    return { dismissed: stored === resolved, dismiss };
}
