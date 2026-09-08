# Ändringar i Sagt.ai Desktop

Den här filen är **för användare**. Den beskriver vad som ändrats i appen, inte
hur eller varför det byggdes. Varje post skrivs för hand.

Changeloggen börjar vid 0.9.41. Äldre versioner finns inte dokumenterade här.

---

## 0.10.2 — 2026-09-02

### Fixat

- **Datorn kunde inte somna när appen var öppen.** Sagt.ai höll ljudkanalen för
  mötesljud igång hela tiden, även när ingen inspelning pågick — vilket hindrade
  Macen från att gå i viloläge och höll högtalarens ljudmotor vaken dygnet runt.
  Mötesljudet kopplas nu in när du börjar spela in och släpps när du slutar.

- **Ljud från en tidigare inspelning kunde hamna i nästa.** Upp till två sekunder
  från slutet av föregående inspelning kunde följa med in i början av nästa
  transkription. Det gick inte att se i appen.

- **Falsk varning om systemljud.** Startade du en inspelning utan att något
  spelades på datorn — vanlig diktering — varnade appen för att mötesljud inte
  fångades, trots att det inte fanns något att fånga. Varningen kommer nu bara när
  det faktiskt spelas ljud som appen missar.

- **Inspelningar som försvann utan förklaring.** Om skrivningen till disk
  misslyckades kunde inspelningen tystna helt, och alla senare inspelningar under
  samma körning gjorde det också tills appen startades om. Nu får du ett tydligt
  fel, och det som hunnit spelas in sparas.

- **En inspelning som inte innehöll något ljud sa ingenting.** Nu får du veta
  direkt när inspelningen är tom eller när din egen mikrofonkanal var tyst, i
  stället för att upptäcka det när du öppnar transkriptet.

### Nytt

- **Loggfil även på Windows.** Appen sparar nu samma slags loggfil på Windows som
  på Mac sedan förra versionen, under `AppData\Roaming\com.sagt.ai\logs\`. Den
  beskriver vad appen gör — vilka ljudenheter som används och när något
  misslyckas — så att ett problem går att felsöka i efterhand i stället för att
  behöva återskapas. **Den innehåller aldrig ditt ljud och aldrig texten ur dina
  inspelningar.** Filen roterar vid 5 MB och lämnar aldrig datorn av sig själv.

### Ändrat

- **Loggfilen skriver mycket mindre i viloläge.** Den fylldes tidigare av en rad
  per sekund även när ingenting hände, vilket gjorde att verkliga fel skrevs över
  inom ett dygn. Nu räcker samma utrymme i ungefär en månad.

## 0.10.1 — 2026-08-30

### Fixat

- **Inspelningar som inte gav något.** På Mac kunde mikrofonen låta bli att starta
  om inget annat ljud spelades på datorn. Inspelningen såg ut att komma igång, men
  gav varken ljudnivåer eller text, och den orange mikrofonsymbolen dök aldrig upp
  i menyraden. Började något spela — en video, ett möte — vaknade den plötsligt
  mitt i. Ett nytt försök fungerade ofta, vilket gjorde felet svårt att känna igen.

  Mikrofonen startar nu direkt, oavsett om något annat låter.

### Ändrat

- **Appen sparar en loggfil** under `Bibliotek/Application Support/com.sagt.ai/logs/`.
  Den beskriver vad appen gör — vilka ljudenheter som används och när något
  misslyckas — så att ett fel går att felsöka i efterhand i stället för att behöva
  återskapas. **Den innehåller aldrig ditt ljud och aldrig texten ur dina
  inspelningar.** Filen roterar vid 5 MB och lämnar aldrig datorn av sig själv.

## 0.10.0 — 2026-08-29

### Nytt

- **Sagt.ai finns nu för Mac.** Samma app som på Windows: inspelning, lokal
  transkribering med KB-Whisper och mötesljud från Teams, Zoom och Meet — utan att
  någon bot ansluter till samtalet.

  Kräver **macOS 14.2 eller senare** och en Mac med **Apple Silicon** (M1 eller
  senare). Intel-Macar stöds inte.

  Vid första start frågar macOS om mikrofon, och om systemljud första gången du
  spelar in ett möte. Båda behövs för att mötets övriga deltagare ska komma med.

  Appen är godkänd av Apple, så den öppnas utan säkerhetsvarning — även utan
  internetanslutning.

### Ändrat

- **Nedladdningssidan visar rätt fil för din dator.** Båda versionerna finns
  alltid tillgängliga, så du kan hämta Mac-filen från en Windows-dator och tvärtom.
- **Installationsfilens storlek anges nu korrekt.** Sidan sa tidigare 165 MB;
  Windows-installern är 172 MB och Mac-filen 178 MB.

### För dig som använder Windows

Ingenting har ändrats i appen. Den här versionen finns för att Windows och Mac
släpps tillsammans, med samma versionsnummer.

---

## 0.9.44 — 2026-08-05

### Fixat

- **Pro syntes inte alltid direkt efter betalning.** Tog betalningen längre än
  fem minuter slutade appen leta, och uppgraderingserbjudandet kunde ligga kvar i
  upp till en halvtimme trots att köpet gått igenom. Appen fortsätter nu att
  kontrollera, och knappen "Uppdatera status" ger besked om vad den hittade.
- **Ingen bekräftelse vid lyckat köp.** Uppgraderingsdialogen visade prislistan
  igen i stället för att bekräfta att Pro aktiverats.
- **Nätverksfel beskrevs som utebliven prenumeration.** Den som saknade
  internetanslutning fick meddelandet "ingen prenumeration hittades" och kunde
  tro att köpet misslyckats.

---

## 0.9.43 — 2026-08-01

### Fixat

- **Ljudinställningarna tillämpades inte förrän du öppnat Inställningar.** Hade
  du ställt in tystnadströskel eller paustolerans men aldrig besökt fliken efter
  omstart körde appen sina egna standardvärden — medan gränssnittet visade dina.
- **Lokal transkribering körde svensk modell oavsett valt språk.** Norska och
  engelska gav därför tyst sämre text lokalt. Lokal transkribering är nu alltid
  svensk, och det framgår i gränssnittet. Molntranskribering (Pro) byter modell
  på riktigt.

### Ändrat

- **Inställningarna skrevs om.** Varje inställning har nu en kort synlig rad, och
  konsekvenserna ligger bakom ⓘ i stället för i löpande text.
- **Hem-vyn visade läget på tre ställen samtidigt** under inspelning. Nu på ett.

### Nytt

- **"Öppna mapp"** i Lokal lagring och på Inspelningar-sidan.

---

## 0.9.42 — 2026-07-24

### Fixat

- **Mikrofonen hölls öppen så länge appen var igång**, inte bara under
  inspelning. Det blockerade andra program — bland annat webbappen — från att
  spela in, med felet "Could not start audio source", ända tills Sagt stängdes.
  Mikrofonen öppnas nu bara när den behövs.

---

## 0.9.41 — 2026-07-16

### Ändrat

- **Felrapportering i skrivbordsappen.** Tidigare syntes det inte för oss när
  något gick sönder hos en användare — en misslyckad transkribering gav en röd
  ruta och inget mer. Appen rapporterar nu felkoder utan innehåll, så att
  återkommande problem går att hitta och åtgärda.
