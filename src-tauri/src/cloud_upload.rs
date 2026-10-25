//! Uppladdning av en inspelning till molnet: WAV kodas till Ogg Opus och skickas härifrån.
//!
//! Sessionsfilen är okomprimerad WAV (16 kHz, 16 bit), ungefär 220 MB per timme i stereo.
//! Molnet tar emot högst 31 MiB per anrop, vilket med WAV räcker till ungefär åtta minuter.
//! Opus med samma ljud tar en tiondel, så ett möte på över en timme ryms.
//!
//! Både kodningen och uppladdningen sker i Rust. Att läsa filen till webbvyn och skicka den
//! därifrån kostar flera gånger filens storlek i minne, eftersom innehållet då går över som en
//! lista med tal.
//!
//! Kanalerna i en sessionsfil är två olika talare (vänster = DU, höger = MÖTET), inte en
//! stereobild. Opus i stereoläge kodar mitt och sida och kan vid låg bitrate låta ljud från den
//! ena kanalen läcka in i den andra. Därför kodas varje kanal som en egen monoström i samma fil
//! (Opus multistream, kanalmappning 1, inga kopplade strömmar). Ingen kanal kan läcka in i den
//! andra, och en vanlig avkodare spelar filen som stereo.
//!
//! Kodningen läser WAV-filen i bitar och skriver Ogg-sidor löpande, så minnet är litet och
//! oberoende av mötets längd. Den lokala WAV-filen ändras inte: den lokala transkriberingen
//! läser den.

use std::ffi::c_int;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opusic_sys as ffi;
use tauri::{AppHandle, Manager};

/// Bitrate per kanal i testerna. I appen bestämmer servern bitraten (`choose_format`).
#[cfg(test)]
pub const OPUS_BITRATE_PER_CHANNEL: i32 = 32_000;

/// 20 ms per paket: Opus standardlängd för tal.
const FRAME_MS: u32 = 20;
/// Ogg räknar granulpositioner i 48 kHz oavsett indata (RFC 7845 §4).
const GRANULE_RATE: u64 = 48_000;
/// Övre gräns för ett paket per ström (libopus rekommenderar 1275 byte).
const MAX_PACKET_PER_STREAM: usize = 1500;
/// Paket per Ogg-sida, cirka en sekund.
const PACKETS_PER_PAGE: u64 = 50;
/// Samplingsfrekvenser Opus tar direkt, utan omsampling.
const OPUS_RATES: [u32; 5] = [8_000, 12_000, 16_000, 24_000, 48_000];
/// Prefix för fel som betyder att filen inte kan kodas. Anroparen skickar då WAV-filen
/// som förut.
pub const UNSUPPORTED: &str = "UNSUPPORTED:";
/// Prefix för fel där servern aldrig svarade.
pub const NETWORK: &str = "NETWORK:";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct EncodedAudio {
    pub channels: u16,
    pub sample_rate: u32,
    /// Längden i sekunder, räknad ur antalet sampel som faktiskt lästes.
    pub duration_secs: f64,
    pub bytes: u64,
}

struct Encoder(*mut ffi::OpusMSEncoder);

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { ffi::opus_multistream_encoder_destroy(self.0) }
    }
}

fn opus_err(code: c_int, what: &str) -> String {
    format!("Opus-kodningen misslyckades ({what}, kod {code})")
}

fn write_err(e: impl std::fmt::Display) -> String {
    format!("Kunde inte skriva Opus-filen: {e}")
}

/// OpusHead enligt RFC 7845 §5.1. Mono får mappning 0 (ingen tabell); två kanaler får
/// mappning 1 med en ström per kanal och inga kopplade strömmar.
fn opus_head(channels: u8, pre_skip: u16, input_rate: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(21 + channels as usize);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(channels);
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&input_rate.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    if channels == 1 {
        h.push(0);
    } else {
        h.push(1);
        h.push(channels); // antal strömmar
        h.push(0); // kopplade strömmar
        h.extend(0..channels); // kanal i avkodas ur ström i
    }
    h
}

/// OpusTags enligt RFC 7845 §5.2: bara leverantörssträngen. Inga kommentarer, så varken
/// filnamn eller mötesnamn följer med filen.
fn opus_tags() -> Vec<u8> {
    let vendor = b"sagt";
    let mut t = Vec::with_capacity(16 + vendor.len());
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor);
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

/// Kodar `wav` till Ogg Opus i `out`, med `bitrate_per_channel` bit/s per kanal.
///
/// Kräver 16-bitars PCM med en eller två kanaler, i en samplingsfrekvens Opus tar direkt.
/// Sessionsfilerna är 16 kHz. Annat ger ett fel med prefixet [`UNSUPPORTED`].
pub fn encode_wav_to_opus(wav: &Path, out: &Path, bitrate_per_channel: i32) -> Result<EncodedAudio, String> {
    let file = File::open(wav).map_err(|e| format!("Kunde inte öppna ljudfilen: {e}"))?;
    let mut reader = hound::WavReader::new(BufReader::new(file))
        .map_err(|e| format!("{UNSUPPORTED} ljudfilen är inte en läsbar WAV: {e}"))?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(format!("{UNSUPPORTED} bara 16-bitars WAV kan kodas"));
    }
    if !(1..=2).contains(&spec.channels) {
        return Err(format!("{UNSUPPORTED} {} kanaler", spec.channels));
    }
    if !OPUS_RATES.contains(&spec.sample_rate) {
        return Err(format!("{UNSUPPORTED} {} Hz", spec.sample_rate));
    }
    let channels = spec.channels as usize;
    let rate = spec.sample_rate;
    let frame = (rate / 1000 * FRAME_MS) as usize; // sampel per kanal och paket
    let granule_per_frame = GRANULE_RATE / 1000 * FRAME_MS as u64;

    let mapping: Vec<u8> = (0..channels as u8).collect();
    let mut err: c_int = 0;
    let enc = Encoder(unsafe {
        ffi::opus_multistream_encoder_create(
            rate as i32,
            channels as c_int,
            channels as c_int, // en ström per kanal
            0,                 // inga kopplade strömmar
            mapping.as_ptr(),
            ffi::OPUS_APPLICATION_VOIP,
            &mut err,
        )
    });
    if err != ffi::OPUS_OK || enc.0.is_null() {
        return Err(opus_err(err, "skapa"));
    }
    let total_bitrate = bitrate_per_channel * channels as i32;
    let rc = unsafe { ffi::opus_multistream_encoder_ctl(enc.0, ffi::OPUS_SET_BITRATE_REQUEST, total_bitrate) };
    if rc != ffi::OPUS_OK {
        return Err(opus_err(rc, "bitrate"));
    }
    let rc = unsafe { ffi::opus_multistream_encoder_ctl(enc.0, ffi::OPUS_SET_SIGNAL_REQUEST, ffi::OPUS_SIGNAL_VOICE) };
    if rc != ffi::OPUS_OK {
        return Err(opus_err(rc, "signal"));
    }
    let mut lookahead: i32 = 0;
    let rc = unsafe {
        ffi::opus_multistream_encoder_ctl(enc.0, ffi::OPUS_GET_LOOKAHEAD_REQUEST, &mut lookahead as *mut i32)
    };
    if rc != ffi::OPUS_OK || lookahead < 0 {
        return Err(opus_err(rc, "lookahead"));
    }
    let lookahead = lookahead as u64;
    // Pre-skip anges i 48 kHz (RFC 7845 §4.2): så många sampel ska avkodaren kasta i början.
    let pre_skip = (lookahead * GRANULE_RATE / rate as u64) as u16;

    let out_file = File::create(out).map_err(|e| format!("Kunde inte skapa Opus-filen: {e}"))?;
    let mut writer = PacketWriter::new(BufWriter::new(out_file));
    // Serienumret identifierar strömmen i filen; det behöver bara vara konstant inom filen.
    let serial: u32 = 0x5341_4754;
    writer
        .write_packet(opus_head(channels as u8, pre_skip, rate), serial, PacketWriteEndInfo::EndPage, 0)
        .map_err(write_err)?;
    writer
        .write_packet(opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)
        .map_err(write_err)?;

    let mut samples = reader.samples::<i16>();
    let mut pcm = vec![0i16; frame * channels];
    let mut packet = vec![0u8; MAX_PACKET_PER_STREAM * channels];
    let mut input_frames: u64 = 0;
    let mut packets: u64 = 0;
    let mut input_done = false;
    // Kodaren ligger `lookahead` sampel efter indata. Efter sista sampel kodas nollor tills
    // allt verkligt ljud har passerat.
    let mut padding_left: u64 = 0;

    loop {
        let mut filled = 0usize;
        if !input_done {
            while filled < pcm.len() {
                match samples.next() {
                    Some(Ok(s)) => {
                        pcm[filled] = s;
                        filled += 1;
                    }
                    Some(Err(e)) => return Err(format!("Kunde inte läsa ljudfilen: {e}")),
                    None => {
                        input_done = true;
                        padding_left = lookahead;
                        break;
                    }
                }
            }
            // En ofullständig ram (sista kanalen saknas) räknas inte.
            input_frames += (filled / channels) as u64;
        }
        if input_done {
            if filled == 0 && padding_left == 0 {
                break;
            }
            let real = (filled / channels) as u64;
            padding_left = padding_left.saturating_sub(frame as u64 - real);
        }
        pcm[filled..].fill(0);

        let len = unsafe {
            ffi::opus_multistream_encode(enc.0, pcm.as_ptr(), frame as c_int, packet.as_mut_ptr(), packet.len() as i32)
        };
        if len < 0 {
            return Err(opus_err(len, "koda"));
        }
        packets += 1;

        let last = input_done && padding_left == 0;
        // Granulposition = sampel i 48 kHz till och med det här paketet, pre-skip inräknad.
        // Sista sidan anger exakt pre-skip + verklig längd, så att avkodaren skär bort
        // nollorna i slutet (RFC 7845 §4.4).
        let granule = if last {
            pre_skip as u64 + input_frames * GRANULE_RATE / rate as u64
        } else {
            packets * granule_per_frame
        };
        let info = if last {
            PacketWriteEndInfo::EndStream
        } else if packets % PACKETS_PER_PAGE == 0 {
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        writer
            .write_packet(packet[..len as usize].to_vec(), serial, info, granule)
            .map_err(write_err)?;
        if last {
            break;
        }
    }

    let mut inner = writer.into_inner();
    inner.flush().map_err(write_err)?;
    drop(inner);
    let bytes = std::fs::metadata(out).map(|m| m.len()).map_err(write_err)?;
    Ok(EncodedAudio {
        channels: channels as u16,
        sample_rate: rate,
        duration_secs: input_frames as f64 / rate as f64,
        bytes,
    })
}

/// Längden i sekunder ur filens storlek och huvudets format, utan att läsa ljudet. Huvudets
/// egen längd kan vara en platshållare i en fil som inte stängts ordentligt.
fn wav_duration_from_size(wav: &Path) -> Result<f64, String> {
    let reader = hound::WavReader::open(wav).map_err(|e| format!("{UNSUPPORTED} ljudfilen är inte en läsbar WAV: {e}"))?;
    let spec = reader.spec();
    let byte_rate = spec.sample_rate as u64 * spec.channels as u64 * (spec.bits_per_sample as u64 / 8);
    if byte_rate == 0 {
        return Err(format!("{UNSUPPORTED} ogiltigt WAV-huvud"));
    }
    let len = std::fs::metadata(wav).map_err(|e| e.to_string())?.len();
    // 44 byte är standardhuvudets storlek; ett längre huvud ger en marginell överskattning.
    Ok(len.saturating_sub(44) as f64 / byte_rate as f64)
}

/// Hur gammal en kvarlämnad fil i upload_temp måste vara för att städas bort.
const STALE_UPLOAD_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Raderar `.opus`-filer i `dir` som är äldre än `age`. Yngre filer kan tillhöra en
/// uppladdning som pågår.
fn remove_stale_uploads(dir: &Path, age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("opus") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|e| e > age);
        if old {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Bara https, eller http mot den egna datorn (lokal utveckling). En token ska aldrig gå
/// okrypterat över nätet.
fn allowed_url(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => match u.scheme() {
            "https" => true,
            "http" => matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]")),
            _ => false,
        },
        Err(_) => false,
    }
}

fn canonical_app_data(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunde inte bestämma datakatalog: {e}"))?;
    std::fs::canonicalize(&app_data).map_err(|e| format!("Kunde inte normalisera datakatalog: {e}"))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CloudUploadResult {
    /// "sent" när servern svarade, "blocked_size" eller "blocked_duration" när filen inte skickades.
    pub outcome: String,
    /// HTTP-status, 0 när inget skickades.
    pub status: u16,
    /// Serverns svar som text.
    pub body: String,
    pub format: String,
    pub size_bytes: u64,
    pub duration_secs: f64,
    pub channels: u16,
    /// Bitraten per kanal när filen skickades som Opus, 0 för WAV.
    pub opus_bitrate: u32,
}

/// Kodar en inspelning till Opus och skickar den som multipart till `url`.
///
/// `fields` är formulärfälten utöver filen. `max_bytes` och `max_minutes` är molnets tak; en
/// fil över något av dem skickas inte, och utfallet säger vilket tak som nåddes. Den kodade
/// filen raderas efteråt i alla utfall.
///
/// Fel med prefixet [`UNSUPPORTED`] betyder att filen inte kunde kodas, och [`NETWORK`] att
/// servern aldrig svarade.
///
/// `opus_bitrate_per_channel` och `wav_when_fits` kommer från servern (se `choose_format`).
///
/// JS anropar med camelCase-nycklar: `invoke("upload_cloud_audio", { path, url, token, fields,
/// maxBytes, maxMinutes, opusBitratePerChannel, wavWhenFits })`.
#[tauri::command]
pub async fn upload_cloud_audio(
    app: AppHandle,
    path: String,
    url: String,
    token: String,
    fields: Vec<(String, String)>,
    max_bytes: u64,
    max_minutes: Option<f64>,
    opus_bitrate_per_channel: u32,
    wav_when_fits: bool,
) -> Result<CloudUploadResult, String> {
    if !allowed_url(&url) {
        return Err("Ogiltig serveradress.".to_string());
    }
    // Sökvägsvakt (samma som när filen läses för uppladdning): bara filer under appens datakatalog.
    let requested = std::fs::canonicalize(&path).map_err(|e| format!("Ogiltig sökväg: {e}"))?;
    let app_data = canonical_app_data(&app)?;
    if !requested.starts_with(&app_data) {
        return Err("Åtkomst nekad: sökvägen ligger utanför appens datakatalog.".to_string());
    }

    // Ett huvud som anger kortare längd än filen (avbruten inspelning) skulle få både
    // kodaren och serverns WAV-läsare att tyst läsa för lite. Hellre ett fel än ett halvt möte.
    check_wav_complete(&requested)?;

    // Längdtaket prövas före kodningen, så att ett för långt möte inte kodas förgäves.
    let estimated = wav_duration_from_size(&requested)?;
    let wav_size = std::fs::metadata(&requested).map_err(|e| e.to_string())?.len();
    if let Some(max) = max_minutes {
        if estimated / 60.0 > max {
            return Ok(CloudUploadResult {
                outcome: "blocked_duration".into(),
                status: 0,
                body: String::new(),
                format: "wav".into(),
                size_bytes: wav_size,
                duration_secs: estimated,
                channels: 0,
                opus_bitrate: 0,
            });
        }
    }

    let stem = requested.file_stem().and_then(|s| s.to_str()).unwrap_or("session").to_string();
    match choose_format(opus_bitrate_per_channel, wav_when_fits, wav_size, max_bytes)? {
        UploadFormat::Wav => {
            let channels = hound::WavReader::open(&requested).map(|r| r.spec().channels).unwrap_or(0);
            let base = CloudUploadResult {
                outcome: "blocked_size".into(),
                status: 0,
                body: String::new(),
                format: "wav".into(),
                size_bytes: wav_size,
                duration_secs: estimated,
                channels,
                opus_bitrate: 0,
            };
            if wav_size > max_bytes {
                return Ok(base);
            }
            // Filen är högst taket (31 MiB) och läses därför hel; det tar inget nämnvärt minne.
            let bytes = std::fs::read(&requested).map_err(|e| format!("Kunde inte läsa ljudfilen: {e}"))?;
            let (status, body) = send_multipart(&url, &token, fields, bytes, format!("{stem}.wav"), "audio/wav").await?;
            Ok(CloudUploadResult { outcome: "sent".into(), status, body, ..base })
        }
        UploadFormat::Opus(bitrate) => {
            // Egen katalog under appdata. Rester från en avbruten körning städas först, men
            // bara filer äldre än ett dygn: en annan uppladdning kan pågå samtidigt (autosynk
            // medan en inspelning synkas från listan), och dess fil får inte försvinna under den.
            let out_dir = app_data.join("upload_temp");
            std::fs::create_dir_all(&out_dir).map_err(|e| format!("Kunde inte skapa katalog: {e}"))?;
            remove_stale_uploads(&out_dir, STALE_UPLOAD_AGE);
            let stamp = SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_micros();
            let out_path = out_dir.join(format!("upload_{stamp}.opus"));
            // Filnamnet följer med till servern och visas i webbens lista: sessionens namn.
            let result = encode_and_send(
                requested, out_path.clone(), format!("{stem}.opus"), bitrate, url, token, fields, max_bytes,
            )
            .await;
            let _ = std::fs::remove_file(&out_path);
            result
        }
    }
}

/// Hur filen skickas.
#[derive(Debug, PartialEq)]
enum UploadFormat {
    Wav,
    Opus(i32),
}

/// Tillåtna bitrater per kanal, samma som serverns kontroll vid uppstart.
const OPUS_BITRATE_RANGE: (u32, u32) = (6_000, 128_000);

/// Formatvalet, styrt av servern. Bitrate 0 betyder alltid WAV. Med `wav_when_fits` skickas
/// WAV när filen ryms under taket och Opus bara när den inte gör det. En bitrate utanför
/// intervallet är ett fel och klampas inte tyst: klienten tolkar redan serverns svar strikt,
/// så ett ogiltigt värde här är ett programfel.
fn choose_format(bitrate: u32, wav_when_fits: bool, wav_size: u64, max_bytes: u64) -> Result<UploadFormat, String> {
    if bitrate == 0 {
        return Ok(UploadFormat::Wav);
    }
    if !(OPUS_BITRATE_RANGE.0..=OPUS_BITRATE_RANGE.1).contains(&bitrate) {
        return Err(format!(
            "Ogiltig bitrate {bitrate} (0 eller {}–{}).",
            OPUS_BITRATE_RANGE.0, OPUS_BITRATE_RANGE.1
        ));
    }
    if wav_when_fits && wav_size <= max_bytes {
        return Ok(UploadFormat::Wav);
    }
    Ok(UploadFormat::Opus(bitrate as i32))
}

/// Fel om WAV-huvudet anger mer än en sekund kortare längd än filen innehåller. Ett sådant
/// huvud blir kvar när en inspelning avbryts innan filen stängts.
fn check_wav_complete(wav: &Path) -> Result<(), String> {
    let reader = hound::WavReader::open(wav)
        .map_err(|e| format!("{UNSUPPORTED} ljudfilen är inte en läsbar WAV: {e}"))?;
    let spec = reader.spec();
    let bytes_per_sample = (spec.bits_per_sample as u64 / 8).max(1);
    let header_samples = reader.len() as u64;
    let file_len = std::fs::metadata(wav).map_err(|e| e.to_string())?.len();
    let size_samples = file_len.saturating_sub(44) / bytes_per_sample;
    let one_second = (spec.sample_rate as u64 * spec.channels as u64).max(1);
    if size_samples > header_samples + one_second {
        return Err(format!(
            "Inspelningsfilen är ofullständig: huvudet anger {:.0} s men filen innehåller {:.0} s, så den kan inte skickas som den är.",
            header_samples as f64 / one_second as f64,
            size_samples as f64 / one_second as f64,
        ));
    }
    Ok(())
}

async fn send_multipart(
    url: &str,
    token: &str,
    fields: Vec<(String, String)>,
    bytes: Vec<u8>,
    file_name: String,
    mime: &str,
) -> Result<(u16, String), String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new().part("file", part);
    for (k, v) in fields {
        form = form.text(k, v);
    }
    // Kryptoleverantören för TLS installeras en gång per process; ett andra anrop är ofarligt.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("{NETWORK} {e}"))?;
    let response = client
        .post(url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("{NETWORK} {e}"))?;
    let status = response.status().as_u16();
    Ok((status, response.text().await.unwrap_or_default()))
}

#[allow(clippy::too_many_arguments)]
async fn encode_and_send(
    wav: PathBuf,
    out_path: PathBuf,
    file_name: String,
    bitrate: i32,
    url: String,
    token: String,
    fields: Vec<(String, String)>,
    max_bytes: u64,
) -> Result<CloudUploadResult, String> {
    let out_worker = out_path.clone();
    let encoded = tauri::async_runtime::spawn_blocking(move || encode_wav_to_opus(&wav, &out_worker, bitrate))
        .await
        .map_err(|e| format!("Kodningen avbröts: {e}"))??;

    let base = CloudUploadResult {
        outcome: "blocked_size".into(),
        status: 0,
        body: String::new(),
        format: "opus".into(),
        size_bytes: encoded.bytes,
        duration_secs: encoded.duration_secs,
        channels: encoded.channels,
        opus_bitrate: bitrate as u32,
    };
    // Den kodade filen prövas också mot taket: en bitrate som är för hög för mötets längd ska
    // ge ett sant storleksfel här, inte ett 413 från servern efter uppladdningen.
    if encoded.bytes > max_bytes {
        return Ok(base);
    }
    let bytes = std::fs::read(&out_path).map_err(|e| format!("Kunde inte läsa Opus-filen: {e}"))?;
    let (status, body) = send_multipart(&url, &token, fields, bytes, file_name, "audio/ogg").await?;
    Ok(CloudUploadResult { outcome: "sent".into(), status, body, ..base })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sagt-opus-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// Stereo-WAV: tonen i vänster kanal, tystnad i höger. `seconds` behöver inte gå jämnt upp i ramar.
    fn write_wav(path: &Path, channels: u16, rate: u32, bits: u16, seconds: f64) {
        let spec = hound::WavSpec { channels, sample_rate: rate, bits_per_sample: bits, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        let n = (rate as f64 * seconds) as usize;
        for i in 0..n {
            let t = i as f64 / rate as f64;
            let v = ((t * 440.0 * std::f64::consts::TAU).sin() * 8000.0) as i32;
            for c in 0..channels {
                let s = if c == 0 { v } else { 0 };
                if bits == 16 { w.write_sample(s as i16).unwrap() } else { w.write_sample(s).unwrap() }
            }
        }
        w.finalize().unwrap();
    }

    struct Parsed {
        head: Vec<u8>,
        tags: Vec<u8>,
        audio_packets: usize,
        last_granule: u64,
        granules_monotonic: bool,
        last_is_eos: bool,
    }

    fn parse(path: &Path) -> Parsed {
        let data = std::fs::read(path).unwrap();
        let mut r = ogg::reading::PacketReader::new(Cursor::new(data));
        let head = r.read_packet_expected().unwrap().data;
        let tags = r.read_packet_expected().unwrap().data;
        let (mut n, mut last, mut mono, mut eos) = (0, 0u64, true, false);
        let mut prev = 0u64;
        while let Some(p) = r.read_packet().unwrap() {
            n += 1;
            let g = p.absgp_page();
            if g < prev { mono = false; }
            prev = g;
            last = g;
            eos = p.last_in_stream();
        }
        Parsed { head, tags, audio_packets: n, last_granule: last, granules_monotonic: mono, last_is_eos: eos }
    }

    #[test]
    fn stereo_blir_tva_okopplade_monostrommar() {
        let (wav, out) = (tmp("s.wav"), tmp("s.opus"));
        write_wav(&wav, 2, 16_000, 16, 3.013);
        let e = encode_wav_to_opus(&wav, &out, 24_000).unwrap();
        assert_eq!(e.channels, 2);
        assert!((e.duration_secs - 3.013).abs() < 1e-3, "{}", e.duration_secs);

        let p = parse(&out);
        assert_eq!(&p.head[..8], b"OpusHead");
        assert_eq!(p.head[9], 2, "kanaler");
        assert_eq!(u32::from_le_bytes(p.head[12..16].try_into().unwrap()), 16_000);
        // Mappning 1, två strömmar, noll kopplade, kanal i ur ström i.
        assert_eq!(&p.head[18..], &[1, 2, 0, 0, 1]);
        assert_eq!(&p.tags[..8], b"OpusTags");
        assert!(p.last_is_eos && p.granules_monotonic);
        // Sista granulen = pre-skip + verklig längd i 48 kHz: avkodaren skär bort utfyllnaden.
        let pre_skip = u16::from_le_bytes(p.head[10..12].try_into().unwrap()) as u64;
        assert_eq!(p.last_granule, pre_skip + (16_000.0 * 3.013) as u64 * 3);
        // Alla verkliga sampel plus kodarens fördröjning måste ha kodats.
        assert!(p.audio_packets as u64 * 960 >= p.last_granule);
    }

    #[test]
    fn mono_far_mappning_noll() {
        let (wav, out) = (tmp("m.wav"), tmp("m.opus"));
        write_wav(&wav, 1, 16_000, 16, 1.0);
        let e = encode_wav_to_opus(&wav, &out, 24_000).unwrap();
        assert_eq!(e.channels, 1);
        let p = parse(&out);
        assert_eq!(p.head.len(), 19, "ingen mappningstabell för mono");
        assert_eq!(p.head[18], 0);
    }

    #[test]
    fn tom_fil_ger_giltig_strom() {
        let (wav, out) = (tmp("e.wav"), tmp("e.opus"));
        write_wav(&wav, 2, 16_000, 16, 0.0);
        let e = encode_wav_to_opus(&wav, &out, 24_000).unwrap();
        assert_eq!(e.duration_secs, 0.0);
        let p = parse(&out);
        let pre_skip = u16::from_le_bytes(p.head[10..12].try_into().unwrap()) as u64;
        assert_eq!(p.last_granule, pre_skip);
        assert!(p.last_is_eos);
    }

    #[test]
    fn tio_minuter_ryms_langt_under_taket() {
        // 2 × 32 kbit/s ≈ 28,8 MB/h som tak; tonen ger nära taket. Tio minuter ska ge under 5 MB.
        let (wav, out) = (tmp("l.wav"), tmp("l.opus"));
        write_wav(&wav, 2, 16_000, 16, 600.0);
        let e = encode_wav_to_opus(&wav, &out, OPUS_BITRATE_PER_CHANNEL).unwrap();
        assert!(e.bytes < 5_000_000, "{} byte", e.bytes);
        assert!(e.bytes > 500_000, "{} byte: misstänkt litet, kodades ljudet?", e.bytes);
    }

    #[test]
    fn format_som_inte_kan_kodas_ger_unsupported() {
        let out = tmp("x.opus");
        for (name, ch, rate, bits) in [("a.wav", 2u16, 44_100u32, 16u16), ("b.wav", 2, 16_000, 24), ("c.wav", 3, 16_000, 16)] {
            let wav = tmp(name);
            write_wav(&wav, ch, rate, bits, 0.1);
            let err = encode_wav_to_opus(&wav, &out, 24_000).unwrap_err();
            assert!(err.starts_with(UNSUPPORTED), "{name}: {err}");
        }
        let junk = tmp("junk.wav");
        std::fs::write(&junk, b"inte en wav-fil alls").unwrap();
        assert!(encode_wav_to_opus(&junk, &out, 24_000).unwrap_err().starts_with(UNSUPPORTED));
    }

    #[test]
    fn langd_ur_storlek_ser_igenom_platshallare() {
        let wav = tmp("p.wav");
        write_wav(&wav, 2, 16_000, 16, 2.0);
        // Sätt data-blockets storlek till 0, som i en fil som aldrig stängdes.
        let mut b = std::fs::read(&wav).unwrap();
        b[40..44].copy_from_slice(&0u32.to_le_bytes());
        std::fs::write(&wav, &b).unwrap();
        assert!((wav_duration_from_size(&wav).unwrap() - 2.0).abs() < 1e-3);
    }

    #[test]
    fn stadningen_ror_inte_en_pagaende_uppladdning() {
        let dir = tmp("stale");
        std::fs::create_dir_all(&dir).unwrap();
        let pagaende = dir.join("upload_1.opus");
        let annat = dir.join("annat.wav");
        std::fs::write(&pagaende, b"x").unwrap();
        std::fs::write(&annat, b"x").unwrap();
        // En ny fil överlever med dygnsgränsen.
        remove_stale_uploads(&dir, STALE_UPLOAD_AGE);
        assert!(pagaende.exists(), "en pågående uppladdnings fil raderades");
        // Negativt prov: med gränsen noll är samma fil gammal och raderas, så funktionen
        // gör faktiskt något. Andra filtyper rörs aldrig.
        std::thread::sleep(std::time::Duration::from_millis(20));
        remove_stale_uploads(&dir, std::time::Duration::ZERO);
        assert!(!pagaende.exists());
        assert!(annat.exists());
    }

    #[test]
    fn formatvalet_foljer_servern() {
        let tak = 31 * 1024 * 1024;
        // 0 = alltid WAV, även när filen inte ryms (då blir det ett storleksfel senare).
        assert_eq!(choose_format(0, false, 10, tak), Ok(UploadFormat::Wav));
        assert_eq!(choose_format(0, true, tak + 1, tak), Ok(UploadFormat::Wav));
        // Opus bara när WAV inte ryms.
        assert_eq!(choose_format(24_000, true, tak, tak), Ok(UploadFormat::Wav));
        assert_eq!(choose_format(24_000, true, tak + 1, tak), Ok(UploadFormat::Opus(24_000)));
        // Alltid Opus.
        assert_eq!(choose_format(16_000, false, 10, tak), Ok(UploadFormat::Opus(16_000)));
        // Utanför intervallet är ett fel, ingen tyst klamp.
        assert!(choose_format(5_999, false, 10, tak).is_err());
        assert!(choose_format(128_001, true, tak + 1, tak).is_err());
        assert_eq!(choose_format(6_000, false, 10, tak), Ok(UploadFormat::Opus(6_000)));
        assert_eq!(choose_format(128_000, false, 10, tak), Ok(UploadFormat::Opus(128_000)));
    }

    #[test]
    fn bitraten_nar_kodaren() {
        // Negativt prov mot en parameter som aldrig når fram: samma fil, olika bitrate,
        // ska ge tydligt olika storlek.
        let wav = tmp("bitrate.wav");
        write_wav(&wav, 2, 16_000, 16, 60.0);
        let lag = encode_wav_to_opus(&wav, &tmp("bitrate16.opus"), 16_000).unwrap().bytes;
        let hog = encode_wav_to_opus(&wav, &tmp("bitrate48.opus"), 48_000).unwrap().bytes;
        assert!(hog as f64 > lag as f64 * 1.8, "16k {lag} byte, 48k {hog} byte");
    }

    #[test]
    fn ofullstandigt_huvud_fangas() {
        let wav = tmp("o.wav");
        write_wav(&wav, 2, 16_000, 16, 3.0);
        assert!(check_wav_complete(&wav).is_ok());
        let mut b = std::fs::read(&wav).unwrap();
        b[40..44].copy_from_slice(&0u32.to_le_bytes());
        std::fs::write(&wav, &b).unwrap();
        let err = check_wav_complete(&wav).unwrap_err();
        assert!(err.contains("ofullständig"), "{err}");
        // En halv sekund kort är inom marginalen (avrundning i slutet av en inspelning).
        let wav2 = tmp("o2.wav");
        write_wav(&wav2, 2, 16_000, 16, 3.0);
        let mut b2 = std::fs::read(&wav2).unwrap();
        let short = (3.0_f64 * 16_000.0 * 2.0 * 2.0 - 16_000.0 * 2.0) as u32; // 0,5 s kort
        b2[40..44].copy_from_slice(&short.to_le_bytes());
        std::fs::write(&wav2, &b2).unwrap();
        assert!(check_wav_complete(&wav2).is_ok());
    }

    #[test]
    fn token_gar_bara_krypterat_eller_lokalt() {
        assert!(allowed_url("https://api.sagt.ai/api/v1/jobs"));
        assert!(allowed_url("http://localhost:8080/api/v1/jobs"));
        assert!(allowed_url("http://127.0.0.1:8000/api/v1/jobs"));
        assert!(!allowed_url("http://api.sagt.ai/api/v1/jobs"));
        assert!(!allowed_url("http://localhost.evil.example/api"));
        assert!(!allowed_url("file:///C:/Windows"));
        assert!(!allowed_url("inte en url"));
    }
}
