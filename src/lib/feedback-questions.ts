// Frågorna. Fri text är huvudformen; tummen är en låg tröskel för den som inte
// vill skriva. En fråga utan `thumb` visar bara textfältet.

import type { FeedbackSurface } from "./feedback-state"

export interface FeedbackQuestion {
    id: string
    /** Kort fråga med tumme upp/ner. */
    thumb?: string
    /** Frågan i fri text. */
    text: string
}

const QUESTIONNAIRE_START: FeedbackQuestion[] = [
    {
        id: "after_meeting",
        thumb: "Får du nytta av texten efter mötet?",
        text: "Vad planerar du göra med texten efter mötet, något vi kan hjälpa till med?",
    },
    {
        id: "last_bother",
        thumb: "Fungerade Sagt som du väntade dig senast?",
        text: "Vad störde dig?",
    },
    {
        id: "missing",
        thumb: "Har Sagt det du behöver?",
        text: "Vad saknar du?",
    },
]

const WORTH_PAYING_FREE: FeedbackQuestion = {
    id: "worth_paying",
    thumb: "Skulle du kunna tänka dig att betala för Sagt?",
    text: "Vad skulle Sagt behöva för att vara värt att betala för?",
}

const WORTH_PAYING_PRO: FeedbackQuestion = {
    id: "pro_worth",
    thumb: "Är Pro värt pengarna för dig?",
    text: "Vad skulle göra Pro mer värt för dig?",
}

const HOW_FOUND: FeedbackQuestion = {
    id: "how_found",
    text: "Hur hittade du Sagt?",
}

export function questionsFor(surface: FeedbackSurface, isPro: boolean): FeedbackQuestion[] {
    switch (surface) {
        case "questionnaire":
            return [...QUESTIONNAIRE_START, isPro ? WORTH_PAYING_PRO : WORTH_PAYING_FREE, HOW_FOUND]
        case "paywall":
            return [{
                id: "paywall_why_not",
                thumb: "Var det tydligt vad du får med Pro?",
                text: "Vad gjorde att du inte valde Pro?",
            }]
        case "pro":
            return [
                {
                    id: "protocol_useful",
                    thumb: "Är protokollet användbart för dig?",
                    text: "Vad skulle göra det mer användbart?",
                },
                {
                    id: "other_value",
                    text: "Finns det något annat kring dina möten som du skulle vilja ha hjälp med?",
                },
            ]
    }
}

export const INVITE_TITLE = "Har du lust att svara på några frågor?"
export const INVITE_BODY = "Det skulle verkligen hjälpa oss att förstå hur vi kan göra Sagt ännu bättre för dig!"
