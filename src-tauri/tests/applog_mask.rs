//! Verifierar loggningen i det läge appen hamnar i när den startats från Start-menyn:
//! Windows svarar NULL på `GetStdHandle(STD_OUTPUT_HANDLE)` (se `applog::write_line`).
//! Appens utskrifter ska då nå loggen, och vakten ska INTE larma om stdout varje varv,
//! eftersom det inte går att ändra. Ett ändrat stderr ska den fortfarande rapportera.
//!
//! Egen fil och egen process: std-handtagen är processglobala (se `tests/applog.rs`).
//! Ett testbinär får aldrig skalets flagga, så läget tvingas fram med `Some(true)`.

#[cfg(windows)]
#[test]
fn maskerad_stdout_loggar_utan_falsklarm_men_stderr_bevakas() {
    use std::time::Duration;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    let dir = std::env::temp_dir().join(format!("sagt-applog-mask-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // SAFETY: konsolhandtagen är giltiga i ett testbinär; de återställs före assertionerna.
    let saved_out = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }.expect("GetStdHandle stdout");
    let saved_err = unsafe { GetStdHandle(STD_ERROR_HANDLE) }.expect("GetStdHandle stderr");

    let path = desktop_lib::applog::init_with_guard(&dir, Duration::from_millis(200), Some(true))
        .expect("init misslyckades");

    // Som efter en start från Start-menyn: stdout svarar NULL.
    // SAFETY: ett nollhandtag är ett giltigt argument.
    unsafe {
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, HANDLE(std::ptr::null_mut()));
    }
    desktop_lib::applog::write_line(format_args!("MASKERAD_VIA_WRITE_LINE_3f7a"), true, false);
    // Flera varv: vakten får inte larma om stdout.
    std::thread::sleep(Duration::from_millis(1200));

    // stderr ändras: det ska vakten se även i maskerat läge.
    unsafe {
        let _ = SetStdHandle(STD_ERROR_HANDLE, HANDLE(std::ptr::null_mut()));
    }
    std::thread::sleep(Duration::from_millis(1200));

    desktop_lib::applog::stop_guard();
    std::thread::sleep(Duration::from_millis(1000));
    // SAFETY: värdena från GetStdHandle ovan, fortfarande giltiga.
    unsafe {
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, saved_out);
        let _ = SetStdHandle(STD_ERROR_HANDLE, saved_err);
    }

    let innehall = std::fs::read_to_string(&path).expect("loggfilen gick inte att läsa");
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        innehall.contains("MASKERAD_VIA_WRITE_LINE_3f7a"),
        "appens utskrift nådde inte loggen med maskerad stdout. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("stdout maskeras av Windows"),
        "startraden om maskerad stdout saknas. Loggen:\n{innehall}"
    );
    let larm: Vec<&str> = innehall
        .lines()
        .filter(|l| l.contains("[applog] std-handtagen har ändrats"))
        .collect();
    assert!(
        !larm.is_empty() && larm.iter().all(|l| l.contains("stderr=0x0")),
        "vakten ska larma bara när stderr ändrats, inte om den maskerade stdout: {larm:?}"
    );
    assert!(
        larm.len() <= 2,
        "vakten larmade {} gånger; ett stderr-fel återställs vid första varvet: {larm:?}",
        larm.len()
    );
}
