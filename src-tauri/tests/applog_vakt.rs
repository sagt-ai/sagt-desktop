//! Verifierar att appens utskrifter når loggen även när stdout-handtaget är NULL, och
//! att vakten upptäcker och återställer ett ändrat handtag.
//!
//! Bakgrund: startas appen från Start-menyn svarar Windows NULL på
//! `GetStdHandle(STD_OUTPUT_HANDLE)`, och std:s `println!` tappade då all text (se
//! `applog::write_line`). Testet ställer stdout-handtaget på NULL för att återskapa
//! det, eftersom ett testbinär är ett konsolprogram och aldrig får skalets flagga.
//!
//! Egen fil, alltså egen process, av samma skäl som `tests/applog.rs`: std-handtagen är
//! processglobala, och två tester som pekar om dem i samma process trampar på varandra.
//! Därför ett test i flera faser i stället för flera tester.
//!
//! Testet skriver med WriteFile mot std-handtaget eller med `write_line`, inte med
//! `println!`, eftersom testharnessen fångar `println!` ovanför handtagslagret.

#[cfg(windows)]
#[test]
fn utskrifter_nar_loggen_med_null_stdout_och_vakten_aterstaller() {
    use std::time::Duration;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    let dir = std::env::temp_dir().join(format!("sagt-applog-vakt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // SAFETY: konsolhandtagen är giltiga i ett testbinär; de återställs före assertionerna.
    let saved_out = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }.expect("GetStdHandle stdout");
    let saved_err = unsafe { GetStdHandle(STD_ERROR_HANDLE) }.expect("GetStdHandle stderr");

    let path = desktop_lib::applog::init_with_guard(&dir, Duration::from_millis(200), Some(false))
        .expect("init misslyckades");

    // Fas 1: stdout-handtaget blir NULL, som när appen startats från Start-menyn.
    // SAFETY: ett nollhandtag är ett giltigt argument; skrivningar mot det misslyckas bara.
    unsafe {
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, HANDLE(std::ptr::null_mut()));
    }
    // Appens väg: ska nå loggen trots NULL-handtaget.
    desktop_lib::applog::write_line(format_args!("VIA_WRITE_LINE_51c2"), true, false);
    // Std-vägen: tappas så länge handtaget är NULL.
    skriv_till_std(STD_OUTPUT_HANDLE, "TAPPAD_MEDAN_NULL_51c2\n");

    // Fas 2: vakten ska ha sett NULL-handtaget och återställt det.
    std::thread::sleep(Duration::from_millis(1500));
    skriv_till_std(STD_OUTPUT_HANDLE, "EFTER_VAKTEN_51c2\n");
    std::thread::sleep(Duration::from_millis(500));

    // Vakten stoppas först, annars pekar den om handtagen till loggen igen inom ett
    // varv. Sedan återställs de före assertionerna, så att ett fel inte skrivs in i
    // loggfilen.
    desktop_lib::applog::stop_guard();
    std::thread::sleep(Duration::from_millis(1000));
    // SAFETY: värdena från GetStdHandle ovan, fortfarande giltiga.
    unsafe {
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, saved_out);
        let _ = SetStdHandle(STD_ERROR_HANDLE, saved_err);
    }
    // En stoppad vakt ska låta de återställda handtagen vara. Fem varv räcker.
    std::thread::sleep(Duration::from_millis(1000));
    // SAFETY: läser bara std-handtagstabellen.
    let efter_stopp = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }.map(|h| h.0 == saved_out.0);

    let innehall = std::fs::read_to_string(&path).expect("loggfilen gick inte att läsa");
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        innehall.contains("VIA_WRITE_LINE_51c2"),
        "appens utskrift nådde inte loggen när stdout-handtaget var NULL. Loggen:\n{innehall}"
    );
    assert!(
        !innehall.contains("TAPPAD_MEDAN_NULL_51c2"),
        "std-vägen nådde loggen trots NULL-handtaget, så fas 1 prövade ingenting. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("[applog] std-handtagen har ändrats"),
        "vakten såg inte NULL-handtaget. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("EFTER_VAKTEN_51c2"),
        "vakten återställde inte stdout. Loggen:\n{innehall}"
    );
    assert_eq!(
        efter_stopp.ok(),
        Some(true),
        "vakten pekade om handtagen trots att den stoppats"
    );
    // Varje rad är tidsstämpel + mellanslag + innehåll.
    let tomma: Vec<&str> = innehall
        .lines()
        .filter(|l| l.split_once(' ').map(|(_, rest)| rest.trim().is_empty()).unwrap_or(true))
        .collect();
    assert!(tomma.is_empty(), "tomma loggrader: {tomma:?}. Loggen:\n{innehall}");
}

/// Skriver rakt på std-handtaget, förbi Rusts strömlager och testharnessens fångst.
/// Ingen panikväg: den anropas medan std-handtagen är omdirigerade.
#[cfg(windows)]
fn skriv_till_std(id: windows::Win32::System::Console::STD_HANDLE, text: &str) {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    let Ok(h) = (unsafe { windows::Win32::System::Console::GetStdHandle(id) }) else {
        return;
    };
    if h.0.is_null() {
        return;
    }
    // SAFETY: handtaget ägs av processen; ManuallyDrop hindrar att det stängs här.
    let mut f = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(h.0) });
    let _ = f.write_all(text.as_bytes());
}
