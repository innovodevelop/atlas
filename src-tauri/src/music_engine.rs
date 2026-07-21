// librespot audio engine — the piece that actually makes sound come out of
// Atlas. Runs on its own tokio runtime + thread (like the voice gateway):
// authenticates with the access token from our PKCE flow, builds a librespot
// Player, and drives it via a command channel. A TappingSink wraps librespot's
// real rodio/CoreAudio backend, forwards the decoded PCM to it, and taps a cheap
// RMS + 3-band envelope that's emitted as `music:level` (~30 fps) so the Sphere
// reacts to the real audio. Player events are emitted as `music:now_playing`.
//
// We drive the Player directly (load/play/pause/seek) rather than via Spotify
// Connect/Spirc — lower latency, no round trip to control our own device. A
// small local queue backs next/prev; richer playlist queueing is a follow-up.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use librespot_core::authentication::Credentials;
use librespot_core::config::SessionConfig;
use librespot_core::session::Session;
use librespot_core::spotify_uri::SpotifyUri;
use librespot_playback::audio_backend;
use librespot_playback::audio_backend::{Sink, SinkResult};
use librespot_playback::config::{AudioFormat, PlayerConfig};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::softmixer::SoftMixer;
use librespot_playback::mixer::{Mixer, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};

use crate::music::CLIENT_ID;

/// Commands from the (sync) Tauri command layer to the engine task.
pub enum EngineCmd {
    Load(String),
    Play,
    Pause,
    Next,
    Prev,
    Seek(u32),
    Volume(f32),
    Shutdown,
}

/// Handle stored in MusicState. Dropping it (or sending Shutdown) stops audio.
pub struct EngineHandle {
    pub tx: UnboundedSender<EngineCmd>,
    _thread: JoinHandle<()>,
}

impl EngineHandle {
    pub fn shutdown(&self) {
        let _ = self.tx.send(EngineCmd::Shutdown);
    }
}

/// Spawn the engine: connect to Spotify with `access_token`, build the Player,
/// and run the command/event loop. Blocks until the session is connected so
/// connection errors (bad token, not Premium) surface synchronously.
pub fn spawn(app: AppHandle, access_token: String) -> Result<EngineHandle, String> {
    let (tx, rx) = mpsc::unbounded_channel::<EngineCmd>();
    let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let playing = Arc::new(AtomicBool::new(false));

    let thread = std::thread::Builder::new()
        .name("atlas-music".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = init_tx.send(Err(format!("tokio runtime: {e}")));
                    return;
                }
            };
            rt.block_on(engine_main(app, access_token, rx, playing, init_tx));
        })
        .map_err(|e| e.to_string())?;

    // Propagate the connect result (or thread death) to the caller.
    init_rx
        .recv()
        .map_err(|_| "music engine thread exited during init".to_string())??;

    Ok(EngineHandle {
        tx,
        _thread: thread,
    })
}

async fn engine_main(
    app: AppHandle,
    access_token: String,
    mut rx: UnboundedReceiver<EngineCmd>,
    playing: Arc<AtomicBool>,
    init_tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let mut session_config = SessionConfig::default();
    session_config.client_id = CLIENT_ID.to_string();
    let session = Session::new(session_config, None);

    if let Err(e) = session
        .connect(Credentials::with_access_token(access_token), false)
        .await
    {
        let _ = init_tx.send(Err(format!("Spotify connect failed: {e}")));
        return;
    }

    let mixer = match SoftMixer::open(MixerConfig::default()) {
        Ok(m) => m,
        Err(e) => {
            let _ = init_tx.send(Err(format!("mixer: {e}")));
            return;
        }
    };
    let volume_getter = mixer.get_soft_volume();

    let backend = match audio_backend::find(None) {
        Some(b) => b,
        None => {
            let _ = init_tx.send(Err("no audio backend available".into()));
            return;
        }
    };

    let mut player_config = PlayerConfig::default();
    // Periodic position updates so the scrubber tracks playback.
    player_config.position_update_interval = Some(Duration::from_millis(500));

    let sink_app = app.clone();
    let player = Player::new(player_config, session, volume_getter, move || {
        Box::new(TappingSink::new(
            backend(None, AudioFormat::default()),
            sink_app,
        ))
    });

    let mut events = player.get_player_event_channel();

    // Connected — unblock the caller.
    let _ = init_tx.send(Ok(()));

    // Local queue backing next/prev (single track until playlist queueing lands).
    let mut queue: Vec<SpotifyUri> = Vec::new();
    let mut index: usize = 0;

    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(EngineCmd::Load(uri)) => match SpotifyUri::from_uri(&uri) {
                    Ok(u) => { queue = vec![u.clone()]; index = 0; player.load(u, true, 0); }
                    Err(e) => log::warn!("[music] bad Spotify URI '{uri}': {e:?}"),
                },
                Some(EngineCmd::Play) => player.play(),
                Some(EngineCmd::Pause) => player.pause(),
                Some(EngineCmd::Seek(ms)) => player.seek(ms),
                Some(EngineCmd::Volume(v)) => {
                    mixer.set_volume((v.clamp(0.0, 1.0) * u16::MAX as f32) as u16);
                }
                Some(EngineCmd::Next) => {
                    if index + 1 < queue.len() {
                        index += 1;
                        player.load(queue[index].clone(), true, 0);
                    }
                }
                Some(EngineCmd::Prev) => {
                    if index > 0 {
                        index -= 1;
                        player.load(queue[index].clone(), true, 0);
                    }
                }
                Some(EngineCmd::Shutdown) | None => { player.stop(); break; }
            },
            ev = events.recv() => match ev {
                Some(PlayerEvent::EndOfTrack { .. }) => {
                    // Auto-advance within the queue.
                    if index + 1 < queue.len() {
                        index += 1;
                        player.load(queue[index].clone(), true, 0);
                    } else {
                        playing.store(false, Ordering::Relaxed);
                        emit_now_playing(&app, false, None);
                    }
                }
                Some(PlayerEvent::Playing { position_ms, .. }) => {
                    playing.store(true, Ordering::Relaxed);
                    emit_now_playing(&app, true, Some(position_ms));
                }
                Some(PlayerEvent::Paused { position_ms, .. }) => {
                    playing.store(false, Ordering::Relaxed);
                    emit_now_playing(&app, false, Some(position_ms));
                }
                Some(PlayerEvent::Seeked { position_ms, .. })
                | Some(PlayerEvent::PositionChanged { position_ms, .. }) => {
                    emit_now_playing(&app, playing.load(Ordering::Relaxed), Some(position_ms));
                }
                Some(PlayerEvent::TrackChanged { .. }) => {
                    // Metadata refresh — the webview re-pulls full details.
                    emit_now_playing(&app, playing.load(Ordering::Relaxed), None);
                }
                Some(PlayerEvent::Unavailable { .. }) => {
                    log::warn!("[music] track unavailable");
                }
                Some(_) => {}
                None => break,
            },
        }
    }
}

fn emit_now_playing(app: &AppHandle, is_playing: bool, position_ms: Option<u32>) {
    let _ = app.emit(
        "music:now_playing",
        serde_json::json!({ "is_playing": is_playing, "position_ms": position_ms }),
    );
}

// ---------------------------------------------------------------------------
// Tapping sink: forwards PCM to the real backend and emits an audio level.

struct TappingSink {
    inner: Box<dyn Sink>,
    app: AppHandle,
    last_emit: Instant,
    /// One-pole low-pass envelope state for the crude band split.
    lp: f64,
}

impl TappingSink {
    fn new(inner: Box<dyn Sink>, app: AppHandle) -> Self {
        Self {
            inner,
            app,
            last_emit: Instant::now(),
            lp: 0.0,
        }
    }
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

impl Sink for TappingSink {
    fn start(&mut self) -> SinkResult<()> {
        self.inner.start()
    }

    fn stop(&mut self) -> SinkResult<()> {
        self.inner.stop()
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        if let AudioPacket::Samples(ref samples) = packet {
            if !samples.is_empty() {
                // Overall loudness (RMS) + a cheap 3-band split via a one-pole
                // low-pass envelope. Not an FFT — just enough for the visualizer.
                let n = samples.len() as f64;
                let mut lp = self.lp;
                let (mut sumsq, mut low_e, mut high_e) = (0.0f64, 0.0f64, 0.0f64);
                for &x in samples.iter() {
                    sumsq += x * x;
                    lp += 0.02 * (x - lp);
                    low_e += lp * lp;
                    let hp = x - lp;
                    high_e += hp * hp;
                }
                self.lp = lp;
                let amp = (sumsq / n).sqrt();
                let low = (low_e / n).sqrt();
                let high = (high_e / n).sqrt();
                let mid = (amp - (low + high) / 2.0).max(0.0);

                if self.last_emit.elapsed() >= Duration::from_millis(33) {
                    self.last_emit = Instant::now();
                    let _ = self.app.emit(
                        "music:level",
                        serde_json::json!({
                            "amp": clamp01(amp),
                            "bands": [clamp01(low * 2.0), clamp01(mid * 2.0), clamp01(high * 2.0)],
                        }),
                    );
                }
            }
        }
        self.inner.write(packet, converter)
    }
}
