//! TLS backend selection for danmaku WebSocket connections.
//!
//! Two backends are compiled in, because the sites disagree on what they will
//! negotiate:
//!
//! * **rustls** — used by every site except Douyu. This is the preferred path:
//!   no OpenSSL to link, and it refuses obsolete key exchanges by design.
//! * **native-tls** — used only by Douyu. Its danmaku proxy ports
//!   (`danmuproxy.douyu.com:8501..=8506`) offer nothing but static-RSA suites
//!   (`AES256-GCM-SHA384`, `AES128-GCM-SHA256`, `AES256-SHA`); they reject
//!   ECDHE and TLS 1.3 outright with a handshake_failure alert. rustls does not
//!   implement static RSA key exchange at all — it is not a toggle — so those
//!   connections must go through the system stack.
//!
//! Enabling tokio-tungstenite's `native-tls` feature has one sharp edge worth
//! knowing: passing `None` as the connector no longer means "use rustls", it
//! means "use native-tls". That is why every non-Douyu call site passes
//! [`rustls_connector()`] explicitly rather than `None` — otherwise the whole
//! app would quietly move onto OpenSSL.

use std::sync::{Arc, OnceLock};

use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_tungstenite::Connector;

use crate::error::{AppError, AppResult};

/// Process-wide rustls client config. Loading the platform root store touches
/// the filesystem, so it is built once and shared.
static RUSTLS_CONFIG: OnceLock<Result<Arc<ClientConfig>, String>> = OnceLock::new();

fn build_rustls_config() -> Result<Arc<ClientConfig>, String> {
    let mut roots = RootCertStore::empty();
    let loaded = rustls_native_certs::load_native_certs();

    if !loaded.errors.is_empty() {
        tracing::warn!(errors = ?loaded.errors, "native root certificate loading reported errors");
    }

    let total = loaded.certs.len();
    let (added, ignored) = roots.add_parsable_certificates(loaded.certs);
    tracing::debug!(added, ignored, total, "loaded native root certificates");

    if roots.is_empty() {
        return Err(format!(
            "no usable native root CA certificates found (errors: {:?})",
            loaded.errors
        ));
    }

    Ok(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

/// A rustls-backed connector for sites with a modern TLS stack.
///
/// Pass this rather than `None`; see the module comment for why `None` would
/// select native-tls instead.
pub fn rustls_connector() -> AppResult<Connector> {
    match RUSTLS_CONFIG.get_or_init(build_rustls_config) {
        Ok(config) => Ok(Connector::Rustls(config.clone())),
        Err(error) => Err(AppError::new(
            "danmaku_tls_init_failed",
            format!("TLS 初始化失败: {error}"),
        )
        .retryable()),
    }
}

/// The connector Douyu's danmaku endpoints need: native-tls.
///
/// `None` selects native-tls because tokio-tungstenite's `native-tls` feature
/// is enabled, and that backend wins over rustls when no connector is given.
/// Douyu depends on this rather than merely tolerating it — see the module
/// comment — so it is named here instead of appearing as a bare `None` at the
/// call sites, where it would read as "no preference".
///
/// The [`ASSERT_NATIVE_TLS_ENABLED`] check below turns the missing feature into
/// a compile error, so this cannot silently start meaning rustls.
pub fn native_tls_connector() -> Option<Connector> {
    let _ = ASSERT_NATIVE_TLS_ENABLED;
    None
}

/// Fails to compile if tokio-tungstenite's `native-tls` feature is switched
/// off, because `Connector::NativeTls` only exists behind it. Without this,
/// dropping that feature would leave `native_tls_connector()` returning a
/// `None` that quietly resolves to rustls, and Douyu danmaku would fail its
/// handshake on every port with no hint as to why.
///
/// Matching the variant does not name its payload type, which is how this
/// avoids a direct dependency on the `native-tls` crate.
const ASSERT_NATIVE_TLS_ENABLED: fn(&Connector) -> bool =
    |connector| matches!(connector, Connector::NativeTls(_));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_rustls_connector_from_the_platform_root_store() {
        let connector = rustls_connector().expect("platform root store should load");
        assert!(matches!(connector, Connector::Rustls(_)));
    }

    #[test]
    fn reuses_one_shared_client_config() {
        let (Ok(Connector::Rustls(first)), Ok(Connector::Rustls(second))) =
            (rustls_connector(), rustls_connector())
        else {
            panic!("expected two rustls connectors");
        };
        assert!(Arc::ptr_eq(&first, &second));
    }
}
