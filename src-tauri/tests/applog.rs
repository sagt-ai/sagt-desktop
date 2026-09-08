//! Verifierar att filloggningen faktiskt fångar `println!`.
//!
//! Ligger i `tests/` och inte som `#[cfg(test)]`-modul med avsikt: `init` pekar om
//! processens fd 1 och 2, vilket hade slagit ut utskrifterna för ALLA andra tester
//! i samma binär. Ett eget testbinär isolerar den effekten.
//!
//! 🔴 Och det är ETT test, inte flera. Fd 1 och 2 är processglobala, medan Rust kör
//! tester parallellt i samma process — två tester som var för sig pekar om och
//! återställer dem trampar på varandra och ger sporadiska fel som inte har med
//! koden att göra. Uppmätt: uppdelat i två föll UTF-8-testet trots att skyddet
//! fanns. Alternativet vore `--test-threads=1`, men ett test som bara passerar med
//! en flagga är ett test som kommer att köras utan den.
//!
//! Filen innehåller nu två `#[test]`, men regeln ovan står oförändrad: de är
//! `#[cfg(unix)]` respektive `#[cfg(windows)]` och kan därför aldrig existera i
//! samma binär. Per plattform är det fortfarande exakt ett test.
//!
//! Testet sparar undan fd 1 och 2 innan omdirigeringen och återställer dem före
//! assertionerna — annars hade ett misslyckat test skrivit sitt felmeddelande till
//! loggfilen i stället för till terminalen, vilket är den sämsta möjliga platsen
//! för ett fel i just loggningen.
//!
//! ⚠️ Vi skriver med `libc::write` mot fd 1 och 2, inte med `println!`. Skälet är
//! inte kosmetiskt: Rusts testharness fångar `println!` OVANFÖR fd-lagret, så ett
//! test byggt på `println!` mäter harnesset och inte oss — det föll utan
//! `--nocapture` och passerade med, vilket är precis den sortens test som ser ut
//! att bevisa något och inte gör det. Fd-nivån är dessutom det appen faktiskt
//! förlitar sig på: i en GUI-startad app går `println!` rakt ned till fd 1.
//! `println!`-vägen är verifierad manuellt med `--nocapture`.

#[cfg(unix)]
#[test]
fn loggfilen_fangar_bada_stromarna_med_tidsstampel_och_overlever_skrap() {
    let dir = std::env::temp_dir().join(format!("sagt-applog-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // SAFETY: 1 och 2 är öppna i ett testbinär; dup returnerar nya fd:n vi äger.
    let saved_out = unsafe { libc::dup(libc::STDOUT_FILENO) };
    let saved_err = unsafe { libc::dup(libc::STDERR_FILENO) };
    assert!(saved_out >= 0 && saved_err >= 0, "kunde inte spara std-fd:n");

    let path = desktop_lib::applog::init(&dir).expect("init misslyckades");
    skriv_till_fd(libc::STDOUT_FILENO, "MARKOR_STDOUT_7f3a\n");
    skriv_till_fd(libc::STDERR_FILENO, "MARKOR_STDERR_7f3a\n");

    // 0xFF är aldrig giltig UTF-8, i någon position. Utan skyddet i läsartråden är
    // detta ingen kosmetisk bugg utan en total hängning: lines() ger Err på en
    // sådan byte, tråden dör, pipens 64 KB fylls och varje println! i appen
    // blockerar i kärnan. Ett bibliotek vi inte äger räcker för att utlösa det.
    let skrap: [u8; 4] = [0xFF, 0xFE, 0xFF, b'\n'];
    // SAFETY: giltig pekare och längd, fd 1 är öppen.
    unsafe {
        libc::write(libc::STDOUT_FILENO, skrap.as_ptr() as *const libc::c_void, skrap.len())
    };
    skriv_till_fd(libc::STDOUT_FILENO, "EFTER_SKRAPET_9b21\n");

    // Läsartråden är asynkron — ge den en tick att konsumera pipen.
    std::thread::sleep(std::time::Duration::from_millis(500));

    // SAFETY: saved_* är giltiga fd:n från dup ovan. Återställs FÖRE assertionerna,
    // annars hade ett misslyckat test skrivit sitt felmeddelande till loggfilen i
    // stället för till terminalen — sämsta möjliga plats för ett fel i loggningen.
    unsafe {
        libc::dup2(saved_out, libc::STDOUT_FILENO);
        libc::dup2(saved_err, libc::STDERR_FILENO);
        libc::close(saved_out);
        libc::close(saved_err);
    }

    let innehall = std::fs::read_to_string(&path).expect("loggfilen gick inte att läsa");
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        innehall.contains("MARKOR_STDOUT_7f3a"),
        "stdout fångades inte. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("MARKOR_STDERR_7f3a"),
        "stderr fångades inte — eprintln! gick förbi omdirigeringen. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("EFTER_SKRAPET_9b21"),
        "läsartråden överlevde inte ogiltig UTF-8 — allt efter skräpbyten tappades, \
         vilket i appen betyder att pipen fylls och println! blockerar. Loggen:\n{innehall}"
    );

    // Tidsstämpeln är hela skälet till pipe-lösningen: utan den går loggen inte att
    // korrelera mot `log show`, och det var den korrelationen som löste buggen som
    // gjorde modulen nödvändig.
    let markorrad = innehall
        .lines()
        .find(|l| l.contains("MARKOR_STDOUT_7f3a"))
        .expect("markörraden saknas");
    let klockslag = &markorrad[..markorrad.find(' ').unwrap_or(0)];
    assert!(
        klockslag.len() == 12 && klockslag.matches(':').count() == 2 && klockslag.contains('.'),
        "raden saknar tidsstämpel i formen HH:MM:SS.mmm — fick {klockslag:?} ur {markorrad:?}"
    );
}

/// Skriver rakt på filbeskrivaren, förbi Rusts strömlager och därmed förbi
/// testharnessets utdatafångst.
#[cfg(unix)]
fn skriv_till_fd(fd: i32, text: &str) {
    let b = text.as_bytes();
    // SAFETY: fd är 1 eller 2, b pekar på giltiga bytes med känd längd.
    unsafe { libc::write(fd, b.as_ptr() as *const libc::c_void, b.len()) };
}

/// Windows-motsvarigheten. Samma påståenden, samma ordning, samma skäl — bara
/// `GetStdHandle`/`SetStdHandle` i stället för `dup`/`dup2`.
///
/// 🔴 Det viktigaste testet är inte att det passerar utan att det FÄLLER när
/// omdirigeringen tas bort. Windows-armen ersatte en `#[cfg(not(unix))]`-stubbe
/// som returnerade `Ok(())` utan att göra någonting, och exakt det utfallet —
/// "allt gick bra, ingenting hände" — är det som inte får kunna passera här.
/// Verifierat 2026-09-04 genom att tillfälligt återinföra stubben: testet föll på
/// `stdout fångades inte`. Se `CLAUDE.md`, arbetsdisciplin regel 1.
#[cfg(windows)]
#[test]
fn loggfilen_fangar_bada_stromarna_med_tidsstampel_och_overlever_skrap() {
    use windows::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    let dir = std::env::temp_dir().join(format!("sagt-applog-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // SAFETY: konsolhandtagen är giltiga i ett testbinär. Till skillnad från unix
    // behövs ingen dup — SetStdHandle lagrar bara ett värde, så det räcker att
    // spara undan de gamla värdena och skriva tillbaka dem sedan.
    let saved_out = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }.expect("GetStdHandle stdout");
    let saved_err = unsafe { GetStdHandle(STD_ERROR_HANDLE) }.expect("GetStdHandle stderr");

    let path = desktop_lib::applog::init(&dir).expect("init misslyckades");
    skriv_till_std(STD_OUTPUT_HANDLE, "MARKOR_STDOUT_7f3a\n");
    skriv_till_std(STD_ERROR_HANDLE, "MARKOR_STDERR_7f3a\n");

    // 0xFF är aldrig giltig UTF-8, i någon position. Utan skyddet i `pump` är
    // detta ingen kosmetisk bugg utan en total hängning — se kommentaren där.
    // Windows anonyma pipe är dessutom MINDRE än unix 64 KB, så den fylls fortare.
    skriv_till_std_bytes(STD_OUTPUT_HANDLE, &[0xFF, 0xFE, 0xFF, b'\n']);
    skriv_till_std(STD_OUTPUT_HANDLE, "EFTER_SKRAPET_9b21\n");

    // Läsartråden är asynkron — ge den en tick att konsumera pipen.
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Återställs FÖRE assertionerna, av samma skäl som i unix-testet: annars hade
    // ett misslyckat test skrivit sitt felmeddelande till loggfilen i stället för
    // till terminalen — sämsta möjliga plats för ett fel i just loggningen.
    //
    // SAFETY: saved_* är de värden GetStdHandle gav ovan och är fortfarande giltiga.
    unsafe {
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, saved_out);
        let _ = SetStdHandle(STD_ERROR_HANDLE, saved_err);
    }

    // Läsartråden håller loggfilen öppen — skrivhandtaget stängs aldrig, så den får
    // aldrig EOF. Det är avsiktligt (se modulens doc-kommentar) och ofarligt här:
    // Rust öppnar filer med FILE_SHARE_READ, så den går att läsa samtidigt.
    let innehall = std::fs::read_to_string(&path).expect("loggfilen gick inte att läsa");
    // Av samma skäl kan katalogen inte alltid raderas — filen är fortfarande öppen.
    // Det är en temp-katalog per pid; misslyckas det är det utan följder.
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        innehall.contains("MARKOR_STDOUT_7f3a"),
        "stdout fångades inte. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("MARKOR_STDERR_7f3a"),
        "stderr fångades inte — eprintln! gick förbi omdirigeringen. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("EFTER_SKRAPET_9b21"),
        "läsartråden överlevde inte ogiltig UTF-8 — allt efter skräpbyten tappades, \
         vilket i appen betyder att pipen fylls och println! blockerar. Loggen:\n{innehall}"
    );

    let markorrad = innehall
        .lines()
        .find(|l| l.contains("MARKOR_STDOUT_7f3a"))
        .expect("markörraden saknas");
    let klockslag = &markorrad[..markorrad.find(' ').unwrap_or(0)];
    assert!(
        klockslag.len() == 12 && klockslag.matches(':').count() == 2 && klockslag.contains('.'),
        "raden saknar tidsstämpel i formen HH:MM:SS.mmm — fick {klockslag:?} ur {markorrad:?}"
    );
}

/// Skriver rakt på std-HANDTAGET, förbi Rusts strömlager och därmed förbi
/// testharnessets utdatafångst — samma skäl som `skriv_till_fd` på unix.
#[cfg(windows)]
fn skriv_till_std(id: windows::Win32::System::Console::STD_HANDLE, text: &str) {
    skriv_till_std_bytes(id, text.as_bytes());
}

#[cfg(windows)]
fn skriv_till_std_bytes(id: windows::Win32::System::Console::STD_HANDLE, bytes: &[u8]) {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;

    // 🔴 Ingen `expect`/`unwrap` i den här funktionen. Den anropas MELLAN
    // omdirigeringen och återställningen, så en panik härifrån hade skrivit sitt
    // eget felmeddelande in i loggfilen i stället för till terminalen — den sämsta
    // möjliga platsen för ett fel i just loggningen, och precis vad modulens
    // doc-kommentar varnar för. Unix-motsvarigheten `skriv_till_fd` har ingen
    // panikväg alls (den ignorerar `libc::write`s returvärde); den här degraderar
    // likadant och låter assertionerna efter återställningen rapportera felet, där
    // meddelandet faktiskt syns.
    let Ok(h) = (unsafe { windows::Win32::System::Console::GetStdHandle(id) }) else {
        return;
    };
    // 🔴 ManuallyDrop är inte städning utan en nödvändighet: File stänger sitt
    // handtag i Drop, och handtaget här ÄR processens std-handtag. Utan wrappern
    // hade första skrivningen rivit strömmen testet mäter.
    //
    // SAFETY: h är ett giltigt, öppet handtag, och ManuallyDrop garanterar att
    // ägandet aldrig övergår till File.
    let mut f = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(h.0) });
    let _ = f.write_all(bytes);
    let _ = f.flush();
}
