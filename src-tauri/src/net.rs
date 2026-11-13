//! HTTP-клиенты. На Windows — системный TLS (как в браузере), на Android — rustls (ring) с корневыми
//! сертификатами Mozilla: так не нужно собирать OpenSSL и подключать Java-проверку сертификатов.

pub fn builder() -> reqwest::ClientBuilder {
    let b = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    let b = b.tls_backend_preconfigured(tls_config());
    b
}

#[cfg(target_os = "android")]
fn tls_config() -> rustls::ClientConfig {
    use std::sync::Arc;
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("версии TLS")
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    cfg
}
