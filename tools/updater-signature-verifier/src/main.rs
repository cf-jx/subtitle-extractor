use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::{self, File};
use std::io::Read;

fn decode_base64_utf8(value: &str, label: &str) -> Result<String, Box<dyn std::error::Error>> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|error| format!("{label} is not valid standard Base64: {error}"))?;
    String::from_utf8(decoded)
        .map_err(|error| format!("{label} does not decode to UTF-8: {error}").into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let encoded_public_key = args
        .next()
        .ok_or("missing encoded updater public key")?
        .into_string()
        .map_err(|_| "encoded updater public key is not valid UTF-8")?;
    let artifact_path = args.next().ok_or("missing updater artifact path")?;
    let signature_path = args.next().ok_or("missing signature path")?;
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }

    let public_key = PublicKey::decode(&decode_base64_utf8(
        &encoded_public_key,
        "updater public key",
    )?)?;

    let encoded_signature = fs::read_to_string(&signature_path)?;
    let signature = Signature::decode(&decode_base64_utf8(
        encoded_signature.trim(),
        "updater signature",
    )?)?;
    let mut verifier = public_key.verify_stream(&signature)?;
    let mut artifact = File::open(&artifact_path)?;
    let mut buffer = vec![0_u8; 1024 * 1024];

    loop {
        let bytes_read = artifact.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        verifier.update(&buffer[..bytes_read]);
    }

    verifier.finalize()?;
    println!(
        "Updater signature verified: {}",
        artifact_path.to_string_lossy()
    );
    Ok(())
}
