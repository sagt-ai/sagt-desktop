// Testdata för exporten. Webbportalens tester läser samma fil, så att en fil från appen
// och en från webben ser likadana ut. Håll den utan importer: den läses från två projekt.

export const MEETING_A = {
    createdAt: "2026-09-26T12:05:00Z",
    lines: [
        { label: "Du", text: "Hej och välkomna till mötet." },
        { label: "Mötet", text: "Tack. Vi börjar med budgeten." },
    ],
    analysis: {
        summary: "Budgeten gicks igenom.",
        decisions: ["Budgeten godkänns."],
        actions: ["Anna skickar underlaget."],
    },
};

export const EXPECTED_TXT_A = `Möte 26 september 2026, 14:05

TRANSKRIPTION

Du: Hej och välkomna till mötet.

Mötet: Tack. Vi börjar med budgeten.

PROTOKOLL

Sammanfattning
Budgeten gicks igenom.

Beslut
- Budgeten godkänns.

Åtgärder
- Anna skickar underlaget.
`;

export const EXPECTED_MD_A = `# Möte 26 september 2026, 14:05

## Transkription

**Du:** Hej och välkomna till mötet.

**Mötet:** Tack. Vi börjar med budgeten.

## Protokoll

### Sammanfattning

Budgeten gicks igenom.

### Beslut

- Budgeten godkänns.

### Åtgärder

- Anna skickar underlaget.
`;
