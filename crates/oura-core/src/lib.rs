//! `oura-core` — the bridge the iOS app links against (UniFFI).
//!
//! The Swift side owns CoreBluetooth: it scans, connects, and hands this crate a
//! [`RingLink`] to write request frames with, then forwards every notification
//! frame to [`OuraCore::on_notification`]. Everything else — the auth handshake,
//! the history-event drain, SQLite persistence and the daily summary — is the same
//! Rust the CLI uses (`oura-link`, `oura-store`, `oura-analysis`).
//!
//! Every ring operation is **blocking**: call it from a background thread/Task,
//! never from the main thread or the CoreBluetooth queue.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use oura_link::transport::Transport;
use oura_link::OuraClient;
use oura_protocol::protocol::{self, feature, feature_mode};
use oura_store::storage::Store;
use tokio::sync::broadcast;

pub mod summary;

pub use summary::{DaySummary, Point, SleepNight, Summary};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum CoreError {
    #[error("the ring is not connected")]
    NotConnected,
    #[error("another ring operation is still running")]
    Busy,
    #[error("invalid auth key: {0}")]
    InvalidKey(String),
    #[error("{0}")]
    Ring(String),
    #[error("{0}")]
    Storage(String),
}

impl From<oura_link::Error> for CoreError {
    fn from(e: oura_link::Error) -> Self {
        CoreError::Ring(e.to_string())
    }
}

impl From<oura_store::Error> for CoreError {
    fn from(e: oura_store::Error) -> Self {
        CoreError::Storage(e.to_string())
    }
}

/// The write half of the BLE link, implemented in Swift over CoreBluetooth.
#[uniffi::export(with_foreign)]
pub trait RingLink: Send + Sync {
    /// Queue `data` as a write-with-response to the ring's write characteristic.
    /// Returns false if the ring is no longer connected.
    fn write(&self, data: Vec<u8>) -> bool;
}

/// Progress callbacks during a sync.
#[uniffi::export(with_foreign)]
pub trait SyncListener: Send + Sync {
    fn on_progress(&self, events_synced: u32, bytes_left: u32);
}

/// One callback per beat while streaming live heart rate.
#[uniffi::export(with_foreign)]
pub trait HeartRateListener: Send + Sync {
    fn on_sample(&self, bpm: u16, ibi_ms: u16);
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct RingInfo {
    pub serial: String,
    pub hardware_id: String,
    pub firmware_version: String,
    pub api_version: String,
    pub mac: String,
    /// Whether this connection is authenticated with the app key.
    pub authenticated: bool,
    /// Battery level; only readable once authenticated.
    pub battery_percent: Option<u8>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct SyncReport {
    pub events_received: u32,
    pub new_events: u32,
    pub next_cursor: u32,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct LatestReadings {
    pub heart_rate_bpm: Option<u16>,
    pub spo2_percent: Option<u8>,
}

/// The last ring this database has seen, for display while disconnected.
#[derive(Clone, Debug, uniffi::Record)]
pub struct StoredDevice {
    pub serial: String,
    pub hardware_id: String,
    pub firmware_version: String,
    /// 0 if the ring has never been synced.
    pub last_sync_unix: i64,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct EventCount {
    pub name: String,
    pub count: u64,
}

/// A fresh random 16-byte auth key as hex. Save it (Keychain) *before* calling
/// [`OuraCore::install_key`], so a crash mid-pairing can't lose the only copy of a
/// key that is already live on the ring.
#[uniffi::export]
pub fn generate_auth_key() -> Result<String, CoreError> {
    let mut key = [0u8; 16];
    getrandom::getrandom(&mut key).map_err(|e| CoreError::InvalidKey(e.to_string()))?;
    Ok(hex::encode(key))
}

/// Whether `key_hex` is a well-formed 16-byte hex key.
#[uniffi::export]
pub fn is_valid_auth_key(key_hex: String) -> bool {
    parse_key(&key_hex).is_ok()
}

/// GATT service the ring advertises.
#[uniffi::export]
pub fn oura_service_uuid() -> String {
    protocol::OURA_SERVICE.to_string()
}

/// Characteristic protocol requests are written to.
#[uniffi::export]
pub fn oura_write_uuid() -> String {
    protocol::OURA_WRITE.to_string()
}

fn parse_key(key_hex: &str) -> Result<[u8; 16], CoreError> {
    let cleaned: String = key_hex.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = hex::decode(cleaned).map_err(|_| CoreError::InvalidKey("not valid hex".into()))?;
    bytes
        .try_into()
        .map_err(|_| CoreError::InvalidKey("must be exactly 16 bytes (32 hex characters)".into()))
}

/// [`Transport`] over the Swift-owned CoreBluetooth link.
struct BridgeTransport {
    link: Arc<dyn RingLink>,
    tx: broadcast::Sender<Vec<u8>>,
}

#[async_trait::async_trait]
impl Transport for BridgeTransport {
    async fn write(&self, data: &[u8]) -> oura_link::Result<()> {
        if self.link.write(data.to_vec()) {
            Ok(())
        } else {
            Err(oura_link::Error::Ble("ring disconnected".into()))
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.tx.subscribe()
    }
}

#[derive(uniffi::Object)]
pub struct OuraCore {
    runtime: tokio::runtime::Runtime,
    store: Mutex<Store>,
    tx: broadcast::Sender<Vec<u8>>,
    link: Mutex<Option<Arc<dyn RingLink>>>,
    /// Auth is per BLE connection; reset whenever the link changes.
    authenticated: AtomicBool,
    /// The protocol is strictly request/response: one operation at a time.
    operation: Mutex<()>,
}

impl OuraCore {
    fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn begin(&self) -> Result<(MutexGuard<'_, ()>, OuraClient<BridgeTransport>), CoreError> {
        let guard = self.operation.try_lock().map_err(|_| CoreError::Busy)?;
        let link = self
            .link
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(CoreError::NotConnected)?;
        let client = OuraClient::new(BridgeTransport {
            link,
            tx: self.tx.clone(),
        });
        Ok((guard, client))
    }

    async fn ensure_auth(
        &self,
        client: &OuraClient<BridgeTransport>,
        key_hex: &str,
    ) -> Result<(), CoreError> {
        if self.authenticated.load(Ordering::SeqCst) {
            return Ok(());
        }
        let key = parse_key(key_hex)?;
        client.authenticate(&key).await?;
        self.authenticated.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[uniffi::export]
impl OuraCore {
    /// Open (creating if needed) the SQLite database at `db_path`.
    #[uniffi::constructor]
    pub fn new(db_path: String) -> Result<Arc<Self>, CoreError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_time()
            .build()
            .map_err(|e| CoreError::Ring(format!("starting runtime: {e}")))?;
        let (tx, _) = broadcast::channel(1024);
        Ok(Arc::new(Self {
            runtime,
            store: Mutex::new(Store::open(db_path)?),
            tx,
            link: Mutex::new(None),
            authenticated: AtomicBool::new(false),
            operation: Mutex::new(()),
        }))
    }

    /// The ring is connected and its characteristics are subscribed.
    pub fn attach(&self, link: Arc<dyn RingLink>) {
        *self.link.lock().unwrap_or_else(|e| e.into_inner()) = Some(link);
        self.authenticated.store(false, Ordering::SeqCst);
    }

    /// The ring disconnected.
    pub fn detach(&self) {
        *self.link.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.authenticated.store(false, Ordering::SeqCst);
    }

    /// Forward one notification frame from any of the ring's notify characteristics.
    pub fn on_notification(&self, data: Vec<u8>) {
        // No receiver just means no request is in flight.
        let _ = self.tx.send(data);
    }

    /// Read device identity; with a key, also authenticate and read the battery.
    pub fn ring_info(&self, key_hex: Option<String>) -> Result<RingInfo, CoreError> {
        let (_guard, client) = self.begin()?;
        self.runtime.block_on(async {
            let info = client.firmware().await?;
            let serial = client.serial().await.unwrap_or_else(|_| "unknown".into());
            let hardware_id = client.hardware_id().await.unwrap_or_default();
            let mut battery_percent = None;
            if let Some(key) = &key_hex {
                self.ensure_auth(&client, key).await?;
                battery_percent = client.battery().await.ok().map(|b| b.percent);
            }
            let hw = (!hardware_id.is_empty()).then_some(hardware_id.as_str());
            self.store().upsert_device(&serial, hw, Some(&info))?;
            Ok(RingInfo {
                serial,
                hardware_id,
                firmware_version: info.firmware_version,
                api_version: info.api_version,
                mac: info.mac,
                authenticated: self.authenticated.load(Ordering::SeqCst),
                battery_percent,
            })
        })
    }

    /// Install `key_hex` on a factory-reset ring and verify it authenticates.
    /// Fails on a ring that already has a key (one onboarded by the official app).
    pub fn install_key(&self, key_hex: String) -> Result<(), CoreError> {
        let key = parse_key(&key_hex)?;
        let (_guard, client) = self.begin()?;
        self.runtime.block_on(async {
            client.set_auth_key(&key).await?;
            client.authenticate(&key).await?;
            self.authenticated.store(true, Ordering::SeqCst);
            Ok(())
        })
    }

    /// Turn on automatic daytime heart-rate and SpO2 measurement. Both are off
    /// after a key-only pairing.
    pub fn enable_measurements(&self, key_hex: String) -> Result<(), CoreError> {
        let (_guard, client) = self.begin()?;
        self.runtime.block_on(async {
            self.ensure_auth(&client, &key_hex).await?;
            client
                .set_feature_mode(feature::DAYTIME_HR, feature_mode::AUTOMATIC)
                .await?;
            client
                .set_feature_mode(feature::SPO2, feature_mode::AUTOMATIC)
                .await?;
            Ok(())
        })
    }

    /// Drain new history events from the ring into the database. Each batch and
    /// its cursor are committed together, so an interrupted sync resumes.
    pub fn sync(
        &self,
        key_hex: String,
        set_ring_clock: bool,
        listener: Arc<dyn SyncListener>,
    ) -> Result<SyncReport, CoreError> {
        let (_guard, client) = self.begin()?;
        self.runtime.block_on(async {
            self.ensure_auth(&client, &key_hex).await?;
            client.setup_app_stream().await?;
            if set_ring_clock {
                client.sync_time_app().await?;
            }

            let serial = client.serial().await.unwrap_or_else(|_| "unknown".into());
            let info = client.firmware().await.ok();
            let cursor = {
                let store = self.store();
                store.upsert_device(&serial, None, info.as_ref())?;
                store.cursor(&serial)?
            };

            let pending = RefCell::new(Vec::new());
            let storage_error = RefCell::new(None);
            let mut new_events = 0u32;
            let outcome = client
                .drain_events(
                    cursor,
                    |event| {
                        pending.borrow_mut().push(event.clone());
                        true
                    },
                    |progress| {
                        let batch = std::mem::take(&mut *pending.borrow_mut());
                        match self
                            .store()
                            .commit_batch(&serial, &batch, progress.next_cursor)
                        {
                            Ok(inserted) => new_events += inserted,
                            Err(e) => {
                                *storage_error.borrow_mut() = Some(e);
                                return false;
                            }
                        }
                        listener.on_progress(progress.events_synced, progress.bytes_left);
                        true
                    },
                )
                .await;
            if let Some(e) = storage_error.into_inner() {
                return Err(e.into());
            }
            let outcome = outcome?;
            Ok(SyncReport {
                events_received: outcome.events_synced,
                new_events,
                next_cursor: outcome.next_cursor,
            })
        })
    }

    /// The ring's latest cached heart rate / SpO2 (meaningful only while worn).
    pub fn latest(&self, key_hex: String) -> Result<LatestReadings, CoreError> {
        let (_guard, client) = self.begin()?;
        self.runtime.block_on(async {
            self.ensure_auth(&client, &key_hex).await?;
            let serial = client.serial().await.unwrap_or_else(|_| "unknown".into());
            let hr = client.feature_latest(feature::DAYTIME_HR).await.ok();
            let spo2 = client.feature_latest(feature::SPO2).await.ok();
            let readings = LatestReadings {
                heart_rate_bpm: hr
                    .and_then(|v| v.bpm)
                    .or_else(|| spo2.as_ref().and_then(|v| v.bpm)),
                spo2_percent: spo2.and_then(|v| v.spo2_percent),
            };
            let store = self.store();
            if let Some(bpm) = readings.heart_rate_bpm {
                let _ = store.insert_reading(&serial, "heart_rate", bpm as f64, "bpm");
            }
            if let Some(pct) = readings.spo2_percent {
                let _ = store.insert_reading(&serial, "spo2", pct as f64, "%");
            }
            Ok(readings)
        })
    }

    /// Stream live heart rate for `seconds` (the ring must be worn). Blocks until
    /// the time is up; the ring is put back in automatic mode afterwards.
    pub fn live_heart_rate(
        &self,
        key_hex: String,
        seconds: u32,
        listener: Arc<dyn HeartRateListener>,
    ) -> Result<(), CoreError> {
        let (_guard, client) = self.begin()?;
        self.runtime.block_on(async {
            self.ensure_auth(&client, &key_hex).await?;
            client
                .live_heart_rate(Duration::from_secs(seconds as u64), false, |sample| {
                    listener.on_sample(sample.bpm, sample.ibi_ms)
                })
                .await?;
            Ok(())
        })
    }

    /// Daily summary of everything synced so far (offline; no ring needed).
    /// `tz_offset_seconds` is the local offset from UTC used to split days.
    pub fn summary(&self, tz_offset_seconds: i32, days: u32) -> Result<Summary, CoreError> {
        summary::build_summary(&self.store(), tz_offset_seconds, days)
    }

    /// The most recently seen ring, from the database.
    pub fn stored_device(&self) -> Result<Option<StoredDevice>, CoreError> {
        Ok(self.store().device_info()?.map(
            |(serial, hardware_id, firmware_version, _, _, _, last_sync_unix, _)| StoredDevice {
                serial,
                hardware_id,
                firmware_version,
                last_sync_unix,
            },
        ))
    }

    /// Stored event counts by type, largest first (all rings).
    pub fn event_counts(&self) -> Result<Vec<EventCount>, CoreError> {
        let store = self.store();
        let mut totals: Vec<EventCount> = Vec::new();
        for serial in store.device_serials()? {
            for (name, count) in store.event_counts(&serial)? {
                match totals.iter_mut().find(|c| c.name == name) {
                    Some(existing) => existing.count += count as u64,
                    None => totals.push(EventCount {
                        name,
                        count: count as u64,
                    }),
                }
            }
        }
        totals.sort_by_key(|c| std::cmp::Reverse(c.count));
        Ok(totals)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoListener;
    impl SyncListener for NoListener {
        fn on_progress(&self, _: u32, _: u32) {}
    }

    /// Answers the two-step auth handshake and nothing else.
    struct ScriptedRing {
        core: std::sync::Weak<OuraCore>,
        writes: Mutex<Vec<Vec<u8>>>,
    }

    impl RingLink for ScriptedRing {
        fn write(&self, data: Vec<u8>) -> bool {
            self.writes.lock().unwrap().push(data.clone());
            let Some(core) = self.core.upgrade() else {
                return false;
            };
            if data == protocol::req_auth_nonce() {
                let mut frame = vec![0x2f, 0x10, 0x2c];
                frame.extend([7u8; 15]);
                core.on_notification(frame);
            } else if data.get(2) == Some(&0x2d) {
                core.on_notification(vec![0x2f, 0x02, 0x2e, 0x00]);
            }
            true
        }
    }

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("oura-core-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn keys_are_validated() {
        let key = generate_auth_key().unwrap();
        assert_eq!(key.len(), 32);
        assert!(is_valid_auth_key(key));
        assert!(is_valid_auth_key(
            " 00112233445566778899aabbccddeeff\n".into()
        ));
        assert!(!is_valid_auth_key("0011".into()));
        assert!(!is_valid_auth_key(
            "zz112233445566778899aabbccddeeff".into()
        ));
    }

    #[test]
    fn operations_need_a_connected_ring() {
        let core = OuraCore::new(temp_db("offline")).unwrap();
        let err = core
            .sync("00".repeat(16), false, Arc::new(NoListener))
            .unwrap_err();
        assert!(matches!(err, CoreError::NotConnected));
        // Offline reads still work.
        assert!(core.summary(0, 7).unwrap().days.is_empty());
        assert!(core.stored_device().unwrap().is_none());
    }

    #[test]
    fn authenticates_through_the_foreign_link() {
        let core = OuraCore::new(temp_db("auth")).unwrap();
        let ring = Arc::new(ScriptedRing {
            core: Arc::downgrade(&core),
            writes: Mutex::new(Vec::new()),
        });
        core.attach(ring.clone());

        let (_guard, client) = core.begin().unwrap();
        core.runtime
            .block_on(core.ensure_auth(&client, &"ab".repeat(16)))
            .unwrap();
        assert!(core.authenticated.load(Ordering::SeqCst));
        assert_eq!(ring.writes.lock().unwrap().len(), 2);
        // A second operation while one is in flight is refused, not interleaved.
        assert!(matches!(core.begin(), Err(CoreError::Busy)));

        core.detach();
        assert!(!core.authenticated.load(Ordering::SeqCst));
    }
}
