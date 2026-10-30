use blue_tanuki_protocol_rust_conformance::{
    canonicalize_boundary_exchange, BoundaryExchangeFailure,
};
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

const IPC_VERSION: &str = "blue-tanuki.runtime-kernel-ipc.v1";
const REQUEST_CONTRACT_VERSION: &str = "blue-tanuki.runtime-kernel-request.v1";
const MAX_FRAME_BYTES: usize = 1_048_576;
const MAX_INPUT_BYTES: usize = 65_536;
const MAX_TTL_MILLIS: i64 = 300_000;

struct AuthenticatedMessage {
    session_id: String,
    sequence: i64,
    message_kind: String,
    payload: Value,
    issued_at_utc: String,
    unsigned_digest: String,
}

struct Response {
    payload: Value,
    stop_after_reply: bool,
}

pub fn run() -> Result<(), &'static str> {
    let key_text = std::env::var("BLUE_TANUKI_RUNTIME_KERNEL_SESSION_KEY")
        .map_err(|_| "missing_session_key")?;
    let key = decode_hex(&key_text).ok_or("invalid_session_key")?;
    if key.len() != 32 {
        return Err("invalid_session_key");
    }

    let session_id =
        std::env::var("BLUE_TANUKI_RUNTIME_KERNEL_SESSION_ID").map_err(|_| "missing_session_id")?;
    if session_id.is_empty() || session_id.len() > 128 || !session_id.is_ascii() {
        return Err("invalid_session_id");
    }

    let database_path = std::env::var("BLUE_TANUKI_RUNTIME_KERNEL_SHADOW_DB")
        .map_err(|_| "missing_shadow_database")?;
    let mut connection =
        Connection::open(database_path).map_err(|_| "shadow_database_open_failed")?;
    initialize_shadow_database(&mut connection, &session_id)?;

    let ready = sign_message(
        &key,
        &session_id,
        0,
        "runtime_kernel_ready",
        json!({
            "status": "ready",
            "kernel": "blue-tanuki-runtime-kernel-shadow",
            "capability": "shadow_only",
            "effect_capability": false,
            "memory_writer": false,
            "canonicalization_version": "blue-tanuki.jcs-safe-integer.v1"
        }),
    )?;
    write_frame(&ready).map_err(|_| "ready_write_failed")?;

    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    while let Some(frame) = read_frame(&mut reader).map_err(|_| "invalid_frame")? {
        let message = authenticate_message(&frame, &key).map_err(|_| "authentication_failed")?;
        if message.session_id != session_id {
            return Err("session_mismatch");
        }
        let response = process_message(&mut connection, &session_id, &message)?;
        let response_kind = if message.message_kind == "shutdown" {
            "shutdown_result"
        } else {
            "decision_result"
        };
        let signed = sign_message(
            &key,
            &session_id,
            message.sequence,
            response_kind,
            response.payload,
        )?;
        write_frame_to(&mut writer, &signed).map_err(|_| "response_write_failed")?;
        if response.stop_after_reply {
            return Ok(());
        }
    }

    mark_stopped(&mut connection, &session_id)?;
    Ok(())
}

fn initialize_shadow_database(
    connection: &mut Connection,
    session_id: &str,
) -> Result<(), &'static str> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS runtime_kernel_shadow_sessions (
                session_id TEXT PRIMARY KEY,
                last_sequence INTEGER NOT NULL,
                shadow_revision INTEGER NOT NULL,
                stopped INTEGER NOT NULL CHECK (stopped IN (0, 1))
            );
            CREATE TABLE IF NOT EXISTS runtime_kernel_shadow_receipts (
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                request_digest TEXT NOT NULL,
                decision TEXT NOT NULL,
                reason TEXT NOT NULL,
                shadow_revision INTEGER NOT NULL,
                issued_at_utc TEXT NOT NULL,
                PRIMARY KEY (session_id, sequence),
                FOREIGN KEY (session_id)
                    REFERENCES runtime_kernel_shadow_sessions(session_id)
            );",
        )
        .map_err(|_| "shadow_database_schema_failed")?;

    let inserted = connection
        .execute(
            "INSERT OR IGNORE INTO runtime_kernel_shadow_sessions
                (session_id, last_sequence, shadow_revision, stopped)
             VALUES (?1, 0, 0, 0)",
            params![session_id],
        )
        .map_err(|_| "shadow_session_create_failed")?;
    if inserted != 1 {
        return Err("session_reuse_not_allowed");
    }
    Ok(())
}

fn authenticate_message(
    raw: &[u8],
    key: &[u8],
) -> Result<AuthenticatedMessage, BoundaryExchangeFailure> {
    let canonical = canonicalize_boundary_exchange(raw)?;
    let mut envelope: Value = serde_json::from_slice(&canonical)
        .map_err(|_| BoundaryExchangeFailure::SchemaValidationFailed)?;
    let object = envelope
        .get_mut("content")
        .and_then(Value::as_object_mut)
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;
    if object.len() != 7 {
        return Err(BoundaryExchangeFailure::SchemaValidationFailed);
    }

    let mac_hex = object
        .remove("mac")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;
    let unsigned = canonicalize_boundary_exchange(
        &serde_json::to_vec(&envelope)
            .map_err(|_| BoundaryExchangeFailure::SchemaValidationFailed)?,
    )?;
    let provided_mac =
        decode_hex(&mac_hex).ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;
    let mut verifier = <HmacSha256 as KeyInit>::new_from_slice(key)
        .map_err(|_| BoundaryExchangeFailure::SchemaValidationFailed)?;
    verifier.update(&unsigned);
    verifier
        .verify_slice(&provided_mac)
        .map_err(|_| BoundaryExchangeFailure::SchemaValidationFailed)?;

    let root = envelope
        .as_object()
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;
    let issued_at_utc = root
        .get("issued_at_utc")
        .and_then(Value::as_str)
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?
        .to_owned();
    let content = root
        .get("content")
        .and_then(Value::as_object)
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;
    let protocol_version = string_field(content, "protocol_version")?;
    let direction = string_field(content, "direction")?;
    if protocol_version != IPC_VERSION || direction != "parent_to_kernel" {
        return Err(BoundaryExchangeFailure::SchemaValidationFailed);
    }
    let session_id = string_field(content, "session_id")?.to_owned();
    let sequence = integer_field(content, "sequence")?;
    let message_kind = string_field(content, "message_kind")?.to_owned();
    let payload = content
        .get("payload")
        .cloned()
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;

    Ok(AuthenticatedMessage {
        session_id,
        sequence,
        message_kind,
        payload,
        issued_at_utc,
        unsigned_digest: sha256_hex(&unsigned),
    })
}

fn process_message(
    connection: &mut Connection,
    session_id: &str,
    message: &AuthenticatedMessage,
) -> Result<Response, &'static str> {
    let (last_sequence, revision, stopped) = connection
        .query_row(
            "SELECT last_sequence, shadow_revision, stopped
             FROM runtime_kernel_shadow_sessions WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| "shadow_session_read_failed")?
        .ok_or("shadow_session_missing")?;

    if stopped != 0 {
        return Ok(rejected_response("session_stopped", revision, Value::Null));
    }
    if message.sequence != last_sequence + 1 {
        let reason = if message.sequence <= last_sequence {
            "replayed_or_duplicate_sequence"
        } else {
            "sequence_gap"
        };
        return Ok(rejected_response(reason, revision, Value::Null));
    }

    let (accepted, reason, payload, next_revision, stop_after_reply) =
        match message.message_kind.as_str() {
            "decision_request" => {
                let reason = validate_decision_request(&message.payload, revision);
                let accepted = reason.is_none();
                let next_revision = if accepted {
                    revision.saturating_add(1)
                } else {
                    revision
                };
                let reason = reason.unwrap_or("shadow_observed");
                (
                    accepted,
                    reason,
                    decision_payload(&message.payload, reason, next_revision),
                    next_revision,
                    false,
                )
            }
            "shutdown" => (
                true,
                "safe_stop_acknowledged",
                json!({
                    "accepted_for_shadow": true,
                    "reason": "safe_stop_acknowledged",
                    "decision": "hold",
                    "shadow_revision": revision,
                    "memory_revision": 0,
                    "effect_started": false,
                    "m_written": false,
                    "used_for_authority": false,
                    "may_execute": false
                }),
                revision,
                true,
            ),
            _ => (
                false,
                "unsupported_message_kind",
                decision_payload(&Value::Null, "unsupported_message_kind", revision),
                revision,
                false,
            ),
        };

    let decision = if accepted { "hold" } else { "reject" };
    persist_receipt(
        connection,
        session_id,
        message,
        decision,
        reason,
        next_revision,
        message.sequence,
        next_revision,
        stop_after_reply,
    )?;

    Ok(Response {
        payload,
        stop_after_reply,
    })
}

fn validate_decision_request(payload: &Value, current_revision: i64) -> Option<&'static str> {
    let Some(object) = payload.as_object() else {
        return Some("request_shape_rejected");
    };
    if object.len() != 10 {
        return Some("request_shape_rejected");
    }
    if string_value(object.get("contract_version")) != Some(REQUEST_CONTRACT_VERSION) {
        return Some("contract_version_rejected");
    }

    let source_id = string_value(object.get("source_id"));
    let target_id = string_value(object.get("target_id"));
    let goal_id = string_value(object.get("goal_id"));
    if !valid_identifier(source_id) || !valid_identifier(target_id) || !valid_identifier(goal_id) {
        return Some("identity_rejected");
    }

    let goal_version = integer_value(object.get("goal_version"));
    if !goal_version.is_some_and(|value| value > 0 && value <= 9_007_199_254_740_991) {
        return Some("goal_version_rejected");
    }

    let expected_revision = integer_value(object.get("expected_revision"));
    if expected_revision != Some(current_revision) {
        return Some("expected_revision_mismatch");
    }

    let input_text = string_value(object.get("input_text"));
    if !input_text.is_some_and(|value| value.len() <= MAX_INPUT_BYTES) {
        return Some("input_size_rejected");
    }
    let digest = string_value(object.get("content_digest"));
    if !digest.is_some_and(|value| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Some("content_digest_rejected");
    }
    let actual_digest = sha256_hex(input_text.unwrap().as_bytes());
    if digest != Some(actual_digest.as_str()) {
        return Some("content_digest_mismatch");
    }

    let expires_at = string_value(object.get("expires_at_utc")).and_then(parse_utc_millis);
    let now = current_unix_millis();
    let Some(expires_at) = expires_at else {
        return Some("expiry_rejected");
    };
    if expires_at <= now {
        return Some("request_expired");
    }
    if expires_at.saturating_sub(now) > MAX_TTL_MILLIS {
        return Some("expiry_window_rejected");
    }

    let Some(budget) = object.get("budget").and_then(Value::as_object) else {
        return Some("budget_rejected");
    };
    if budget.len() != 1 || integer_value(budget.get("max_steps")) != Some(1) {
        return Some("budget_rejected");
    }

    None
}

fn decision_payload(payload: &Value, reason: &str, shadow_revision: i64) -> Value {
    let object = payload.as_object();
    json!({
        "accepted_for_shadow": reason == "shadow_observed",
        "reason": reason,
        "decision": "hold",
        "source_id": object.and_then(|value| value.get("source_id")).and_then(Value::as_str),
        "target_id": object.and_then(|value| value.get("target_id")).and_then(Value::as_str),
        "goal_id": object.and_then(|value| value.get("goal_id")).and_then(Value::as_str),
        "goal_version": object.and_then(|value| value.get("goal_version")).and_then(Value::as_i64),
        "contract_version": object.and_then(|value| value.get("contract_version")).and_then(Value::as_str),
        "content_digest": object.and_then(|value| value.get("content_digest")).and_then(Value::as_str),
        "expires_at_utc": object.and_then(|value| value.get("expires_at_utc")).and_then(Value::as_str),
        "expected_revision": object.and_then(|value| value.get("expected_revision")).and_then(Value::as_i64),
        "shadow_revision": shadow_revision,
        "memory_revision": 0,
        "effect_started": false,
        "m_written": false,
        "used_for_authority": false,
        "may_execute": false
    })
}

fn rejected_response(reason: &str, revision: i64, extra: Value) -> Response {
    Response {
        payload: json!({
            "accepted_for_shadow": false,
            "reason": reason,
            "decision": "hold",
            "shadow_revision": revision,
            "memory_revision": 0,
            "effect_started": false,
            "m_written": false,
            "used_for_authority": false,
            "may_execute": false,
            "details": extra
        }),
        stop_after_reply: false,
    }
}

#[allow(clippy::too_many_arguments)]
fn persist_receipt(
    connection: &mut Connection,
    session_id: &str,
    message: &AuthenticatedMessage,
    decision: &str,
    reason: &str,
    shadow_revision: i64,
    last_sequence: i64,
    next_revision: i64,
    stopped: bool,
) -> Result<(), &'static str> {
    let transaction = connection
        .transaction()
        .map_err(|_| "shadow_transaction_begin_failed")?;
    update_session(
        &transaction,
        session_id,
        last_sequence,
        next_revision,
        stopped,
    )?;
    transaction
        .execute(
            "INSERT INTO runtime_kernel_shadow_receipts
                (session_id, sequence, request_digest, decision, reason,
                 shadow_revision, issued_at_utc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                session_id,
                message.sequence,
                message.unsigned_digest,
                decision,
                reason,
                shadow_revision,
                message.issued_at_utc,
            ],
        )
        .map_err(|_| "shadow_receipt_write_failed")?;
    transaction
        .commit()
        .map_err(|_| "shadow_transaction_commit_failed")
}

fn update_session(
    transaction: &Transaction<'_>,
    session_id: &str,
    last_sequence: i64,
    revision: i64,
    stopped: bool,
) -> Result<(), &'static str> {
    transaction
        .execute(
            "UPDATE runtime_kernel_shadow_sessions
             SET last_sequence = ?2, shadow_revision = ?3, stopped = ?4
             WHERE session_id = ?1",
            params![
                session_id,
                last_sequence,
                revision,
                if stopped { 1_i64 } else { 0_i64 }
            ],
        )
        .map_err(|_| "shadow_session_update_failed")?;
    Ok(())
}

fn mark_stopped(connection: &mut Connection, session_id: &str) -> Result<(), &'static str> {
    connection
        .execute(
            "UPDATE runtime_kernel_shadow_sessions SET stopped = 1 WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|_| "shadow_session_stop_failed")?;
    Ok(())
}

fn sign_message(
    key: &[u8],
    session_id: &str,
    sequence: i64,
    message_kind: &str,
    payload: Value,
) -> Result<Vec<u8>, &'static str> {
    let issued_at_utc = current_utc_timestamp();
    let mut content = Map::new();
    content.insert("protocol_version".into(), json!(IPC_VERSION));
    content.insert("direction".into(), json!("kernel_to_parent"));
    content.insert("session_id".into(), json!(session_id));
    content.insert("sequence".into(), json!(sequence));
    content.insert("message_kind".into(), json!(message_kind));
    content.insert("payload".into(), payload);

    let unsigned_envelope = json!({
        "schema_version": "blue-tanuki.boundary-exchange.v1",
        "canonicalization_version": "blue-tanuki.jcs-safe-integer.v1",
        "issued_at_utc": issued_at_utc,
        "content": content
    });
    let unsigned = canonicalize_boundary_exchange(
        &serde_json::to_vec(&unsigned_envelope).map_err(|_| "response_serialization_failed")?,
    )
    .map_err(|_| "response_canonicalization_failed")?;
    let mut signer =
        <HmacSha256 as KeyInit>::new_from_slice(key).map_err(|_| "response_signer_failed")?;
    signer.update(&unsigned);
    let mac = signer.finalize().into_bytes();
    content.insert("mac".into(), json!(encode_hex(&mac)));

    let signed_envelope = json!({
        "schema_version": "blue-tanuki.boundary-exchange.v1",
        "canonicalization_version": "blue-tanuki.jcs-safe-integer.v1",
        "issued_at_utc": issued_at_utc,
        "content": content
    });
    canonicalize_boundary_exchange(
        &serde_json::to_vec(&signed_envelope).map_err(|_| "response_serialization_failed")?,
    )
    .map_err(|_| "response_canonicalization_failed")
}

fn write_frame(frame: &[u8]) -> io::Result<()> {
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    write_frame_to(&mut writer, frame)
}

fn write_frame_to(writer: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unterminated frame",
                ))
            };
        }
        let frame_end = available.iter().position(|byte| *byte == b'\n');
        let consumed = frame_end.map_or(available.len(), |index| index + 1);
        if frame.len().saturating_add(consumed) > MAX_FRAME_BYTES + 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        if let Some(end) = frame_end {
            frame.extend_from_slice(&available[..end]);
            reader.consume(consumed);
            if frame.is_empty() {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "empty frame"));
            }
            return Ok(Some(frame));
        }
        frame.extend_from_slice(available);
        reader.consume(consumed);
    }
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, BoundaryExchangeFailure> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)
}

fn integer_field(object: &Map<String, Value>, key: &str) -> Result<i64, BoundaryExchangeFailure> {
    object
        .get(key)
        .and_then(Value::as_i64)
        .ok_or(BoundaryExchangeFailure::SchemaValidationFailed)
}

fn string_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn integer_value(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn valid_identifier(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    encode_hex(&Sha256::digest(bytes))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    bytes
        .chunks_exact(2)
        .map(|pair| Some((hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?))
        .collect()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parse_utc_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit() {
            return None;
        }
    }
    let year = decimal(&bytes[0..4])? as i64;
    let month = decimal(&bytes[5..7])? as i64;
    let day = decimal(&bytes[8..10])? as i64;
    let hour = decimal(&bytes[11..13])? as i64;
    let minute = decimal(&bytes[14..16])? as i64;
    let second = decimal(&bytes[17..19])? as i64;
    let millis = decimal(&bytes[20..23])? as i64;
    if year < 1 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > days[(month - 1) as usize] || millis > 999 {
        return None;
    }
    let days_since_epoch = days_from_civil(year, month, day);
    Some((((days_since_epoch * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}

fn decimal(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0u32, |value, digit| {
        if !digit.is_ascii_digit() {
            return None;
        }
        Some(value * 10 + u32::from(*digit - b'0'))
    })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn current_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(i64::MAX as u128) as i64
        })
}

fn current_utc_timestamp() -> String {
    let now = current_unix_millis();
    let days = now.div_euclid(86_400_000);
    let millis_of_day = now.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    let hour = millis_of_day / 3_600_000;
    let minute = (millis_of_day % 3_600_000) / 60_000;
    let second = (millis_of_day % 60_000) / 1_000;
    let millis = millis_of_day % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::{current_utc_timestamp, days_from_civil, parse_utc_millis};

    #[test]
    fn timestamp_round_trip_epoch_and_leap_day() {
        assert_eq!(parse_utc_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            days_from_civil(2024, 2, 29),
            days_from_civil(2024, 1, 1) + 59
        );
        assert_eq!(parse_utc_millis("2023-02-29T00:00:00.000Z"), None);
        assert_eq!(
            parse_utc_millis("2024-02-29T00:00:00.000Z"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn emitted_timestamp_matches_boundary_profile() {
        let timestamp = current_utc_timestamp();
        assert_eq!(timestamp.len(), 24);
        assert!(parse_utc_millis(&timestamp).is_some());
    }
}
