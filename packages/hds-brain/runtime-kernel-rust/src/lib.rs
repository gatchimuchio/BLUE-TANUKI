use blue_tanuki_protocol_rust_conformance::{
    canonicalize_boundary_exchange, BoundaryExchangeFailure,
};
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

const IPC_VERSION: &str = "blue-tanuki.runtime-kernel-ipc.v1";
const REQUEST_CONTRACT_VERSION: &str = "blue-tanuki.runtime-kernel-request.v7";
const J_PROJECTION_SCHEMA_VERSION: &str = "blue-tanuki.hds-runtime-j-projection.v12";
const J_PROJECTION_SCALE: i64 = 1_000_000;
const MAX_J_PROJECTION_AXES: usize = 128;
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

struct JProjectionComparison {
    comparison_kind: &'static str,
    comparison_status: &'static str,
    typescript_decision: String,
    typescript_policy_rule_id: String,
    typescript_policy_rule_axis: Option<String>,
    runtime_kernel_j_decision: &'static str,
    rule_id: &'static str,
    rule_axis: Option<String>,
    purpose_binding_matches: Option<bool>,
    current_goal_purpose_binding_status: &'static str,
    purpose_binding_current_matches: Option<bool>,
    plan_step_adoption: JPlanStepAdoptionComparison,
    policy_decision_matches: bool,
    policy_rule_matches: bool,
    lifecycle_matches: bool,
    memory_transition_kind: Option<&'static str>,
    memory_reference_review_matches: Option<bool>,
    memory_revision_matches: Option<bool>,
    memory_transition_matches: Option<bool>,
    residual_status: Option<&'static str>,
    residual_status_matches: Option<bool>,
}

struct JPlanStepAdoptionComparison {
    matches: Option<bool>,
    comparable: bool,
    receipt: Value,
}

struct JMemoryTransitionComparison {
    kind: &'static str,
    matches: bool,
    reference_review_matches: Option<bool>,
    memory_revision_matches: Option<bool>,
    residual_status: &'static str,
    residual_status_matches: bool,
}

#[derive(PartialEq, Eq)]
struct GoalPurposeBinding {
    goal_id_digest: String,
    purpose_version: i64,
    purpose_digest: String,
}

fn projection_comparison_status(
    matches: bool,
    current_goal_purpose_binding_status: &str,
    plan_step_adoption: &JPlanStepAdoptionComparison,
) -> &'static str {
    if !matches {
        "mismatched"
    } else if current_goal_purpose_binding_status == "ledger_unavailable"
        || !plan_step_adoption.comparable
    {
        "not_comparable"
    } else {
        "matched"
    }
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
                if let Some(reason) = validate_decision_request(&message.payload, revision) {
                    (
                        false,
                        reason,
                        decision_payload(&message.payload, reason, revision, None),
                        revision,
                        false,
                    )
                } else {
                    let input_text = message
                        .payload
                        .as_object()
                        .and_then(|object| object.get("input_text"))
                        .and_then(Value::as_str)
                        .ok_or("validated_input_missing")?;
                    let payload = message
                        .payload
                        .as_object()
                        .ok_or("validated_payload_missing")?;
                    let goal_id =
                        string_value(payload.get("goal_id")).ok_or("validated_goal_id_missing")?;
                    let goal_version = integer_value(payload.get("goal_version"))
                        .ok_or("validated_goal_version_missing")?;
                    match evaluate_runtime_kernel_j_projection(input_text, goal_id, goal_version) {
                        Ok(comparison) => {
                            let reason = match comparison.comparison_status {
                                "matched" => "shadow_projection_matched",
                                "mismatched" => "shadow_projection_mismatched",
                                _ => "shadow_projection_not_comparable",
                            };
                            let next_revision = revision.saturating_add(1);
                            (
                                true,
                                reason,
                                decision_payload(
                                    &message.payload,
                                    reason,
                                    next_revision,
                                    Some(&comparison),
                                ),
                                next_revision,
                                false,
                            )
                        }
                        Err(reason) => (
                            false,
                            reason,
                            decision_payload(&message.payload, reason, revision, None),
                            revision,
                            false,
                        ),
                    }
                }
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
                decision_payload(&Value::Null, "unsupported_message_kind", revision, None),
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

fn decision_payload(
    payload: &Value,
    reason: &str,
    shadow_revision: i64,
    comparison: Option<&JProjectionComparison>,
) -> Value {
    let object = payload.as_object();
    let accepted = matches!(
        reason,
        "shadow_projection_matched"
            | "shadow_projection_mismatched"
            | "shadow_projection_not_comparable"
    );
    json!({
        "accepted_for_shadow": accepted,
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
        "comparison_status": comparison.map(|result| result.comparison_status),
        "comparison_kind": comparison.map(|result| result.comparison_kind),
        "typescript_decision": comparison.map(|result| result.typescript_decision.as_str()),
        "typescript_policy_rule_id": comparison.map(|result| result.typescript_policy_rule_id.as_str()),
        "typescript_policy_rule_axis": comparison.and_then(|result| result.typescript_policy_rule_axis.as_deref()),
        "runtime_kernel_j_decision": comparison.map(|result| result.runtime_kernel_j_decision),
        "rule_id": comparison.map(|result| result.rule_id),
        "rule_axis": comparison.and_then(|result| result.rule_axis.as_deref()),
        "policy_decision_matches": comparison.map(|result| result.policy_decision_matches),
        "purpose_binding_matches": comparison.map(|result| result.purpose_binding_matches),
        "current_goal_purpose_binding_status": comparison.map(|result| result.current_goal_purpose_binding_status),
        "purpose_binding_current_matches": comparison.map(|result| result.purpose_binding_current_matches),
        "plan_step_adoption": comparison.map(|result| result.plan_step_adoption.receipt.clone()),
        "policy_rule_matches": comparison.map(|result| result.policy_rule_matches),
        "lifecycle_matches": comparison.map(|result| result.lifecycle_matches),
        "memory_transition_kind": comparison.and_then(|result| result.memory_transition_kind),
        "memory_reference_review_matches": comparison.and_then(|result| result.memory_reference_review_matches),
        "memory_revision_matches": comparison.and_then(|result| result.memory_revision_matches),
        "memory_transition_matches": comparison.and_then(|result| result.memory_transition_matches),
        "residual_status": comparison.and_then(|result| result.residual_status),
        "residual_status_matches": comparison.and_then(|result| result.residual_status_matches),
        "memory_revision": 0,
        "effect_started": false,
        "m_written": false,
        "used_for_authority": false,
        "may_execute": false
    })
}

fn parse_goal_purpose_binding(
    value: &Value,
    rejection: &'static str,
) -> Result<Option<GoalPurposeBinding>, &'static str> {
    match value {
        Value::Null => Ok(None),
        Value::Object(binding) => {
            if binding.len() != 3 {
                return Err(rejection);
            }
            let goal_id_digest = string_value(binding.get("goal_id_digest"))
                .filter(|value| is_lowercase_sha256(value))
                .ok_or(rejection)?
                .to_owned();
            let purpose_version = integer_value(binding.get("purpose_version"))
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                .ok_or(rejection)?;
            let purpose_digest = string_value(binding.get("purpose_digest"))
                .filter(|value| is_lowercase_sha256(value))
                .ok_or(rejection)?
                .to_owned();
            Ok(Some(GoalPurposeBinding {
                goal_id_digest,
                purpose_version,
                purpose_digest,
            }))
        }
        _ => Err(rejection),
    }
}

fn evaluate_runtime_kernel_j_projection(
    input_text: &str,
    request_goal_id: &str,
    request_goal_version: i64,
) -> Result<JProjectionComparison, &'static str> {
    let projection: Value =
        serde_json::from_str(input_text).map_err(|_| "projection_json_rejected")?;
    let object = projection.as_object().ok_or("projection_shape_rejected")?;
    let has_resume_transition = object.contains_key("resume_transition");
    let has_memory_transition = object.contains_key("memory_transition");
    let has_self_health_gate = object.contains_key("self_health_gate");
    let expected_projection_fields =
        9 + if has_resume_transition || has_memory_transition {
            1
        } else {
            0
        } + if has_self_health_gate { 1 } else { 0 };
    if has_resume_transition && has_memory_transition
        || has_self_health_gate && has_memory_transition
        || object.len() != expected_projection_fields
        || string_value(object.get("schema_version")) != Some(J_PROJECTION_SCHEMA_VERSION)
    {
        return Err("projection_schema_rejected");
    }
    let self_health_failed_precondition_count = if has_self_health_gate {
        let gate = object
            .get("self_health_gate")
            .and_then(Value::as_object)
            .filter(|gate| gate.len() == 4)
            .ok_or("projection_self_health_gate_rejected")?;
        if integer_value(gate.get("failed_precondition_count"))
            .filter(|count| (1..=7).contains(count))
            .is_none()
            || gate.get("command_execution_allowed") != Some(&Value::Bool(false))
            || gate.get("downstream_execution_allowed") != Some(&Value::Bool(false))
            || gate.get("used_for_authority") != Some(&Value::Bool(false))
        {
            return Err("projection_self_health_gate_rejected");
        }
        integer_value(gate.get("failed_precondition_count"))
    } else {
        None
    };
    let purpose_binding_value = object
        .get("purpose_binding")
        .ok_or("projection_purpose_binding_rejected")?;
    let purpose_binding =
        parse_goal_purpose_binding(purpose_binding_value, "projection_purpose_binding_rejected")?;
    let purpose_binding_matches = purpose_binding.as_ref().map(|binding| {
        let expected_goal_id = format!("goal-{}", binding.goal_id_digest);
        binding.purpose_version == request_goal_version && request_goal_id == expected_goal_id
    });

    let current_binding_projection = object
        .get("current_goal_purpose_binding")
        .and_then(Value::as_object)
        .filter(|binding| binding.len() == 2)
        .ok_or("projection_current_purpose_binding_rejected")?;
    let current_binding_status = string_value(current_binding_projection.get("status"))
        .ok_or("projection_current_purpose_binding_rejected")?;
    let current_binding = parse_goal_purpose_binding(
        current_binding_projection
            .get("binding")
            .ok_or("projection_current_purpose_binding_rejected")?,
        "projection_current_purpose_binding_rejected",
    )?;
    let (current_goal_purpose_binding_status, purpose_binding_current_matches) =
        match current_binding_status {
            "not_bound" if purpose_binding.is_none() && current_binding.is_none() => {
                ("not_bound", None)
            }
            "ledger_unavailable" if purpose_binding.is_some() && current_binding.is_none() => {
                ("ledger_unavailable", None)
            }
            "goal_not_found" if purpose_binding.is_some() && current_binding.is_none() => {
                ("goal_not_found", Some(false))
            }
            "available" => match (purpose_binding.as_ref(), current_binding.as_ref()) {
                (Some(source), Some(current))
                    if source.goal_id_digest == current.goal_id_digest =>
                {
                    ("available", Some(source == current))
                }
                _ => return Err("projection_current_purpose_binding_rejected"),
            },
            _ => return Err("projection_current_purpose_binding_rejected"),
        };
    let plan_step_adoption = compare_plan_step_adoption(
        object
            .get("plan_step_adoption")
            .ok_or("projection_plan_step_adoption_rejected")?,
    )?;
    let policy_typescript_decision = string_value(object.get("typescript_decision"))
        .filter(|value| is_shadow_decision(value))
        .ok_or("projection_decision_rejected")?
        .to_owned();
    let typescript_policy_rule_id = string_value(object.get("typescript_policy_rule_id"))
        .filter(|value| is_shadow_policy_rule_id(value))
        .ok_or("projection_policy_rule_rejected")?
        .to_owned();
    let typescript_policy_rule_axis = match object.get("typescript_policy_rule_axis") {
        Some(Value::Null) => None,
        Some(Value::String(axis)) if valid_axis_identifier(axis) => Some(axis.clone()),
        _ => return Err("projection_policy_rule_axis_rejected"),
    };
    if requires_policy_rule_axis(&typescript_policy_rule_id)
        != typescript_policy_rule_axis.is_some()
    {
        return Err("projection_policy_rule_axis_rejected");
    }

    let axes = object
        .get("axes")
        .and_then(Value::as_array)
        .ok_or("projection_axes_rejected")?;
    if axes.is_empty() || axes.len() > MAX_J_PROJECTION_AXES {
        return Err("projection_axes_rejected");
    }
    let mut axis_scores: HashMap<String, (i64, bool)> = HashMap::new();
    let mut lifecycle_axis = None;
    let mut weighted_sum = 0_i128;
    let mut weight_total = 0_i128;
    for axis_value in axes {
        let axis_object = axis_value.as_object().ok_or("projection_axis_rejected")?;
        if axis_object.len() != 4 {
            return Err("projection_axis_rejected");
        }
        let axis = string_value(axis_object.get("axis")).ok_or("projection_axis_rejected")?;
        if !valid_axis_identifier(axis) {
            return Err("projection_axis_rejected");
        }
        let score = integer_value(axis_object.get("score_micros"))
            .filter(|value| (0..=J_PROJECTION_SCALE).contains(value))
            .ok_or("projection_score_rejected")?;
        let weight = integer_value(axis_object.get("weight_micros"))
            .filter(|value| (0..=1_000_000_000).contains(value))
            .ok_or("projection_weight_rejected")?;
        let lifecycle_ok = axis_object
            .get("lifecycle_ok")
            .and_then(Value::as_bool)
            .ok_or("projection_lifecycle_rejected")?;
        if !lifecycle_ok && lifecycle_axis.is_none() {
            lifecycle_axis = Some(axis.to_owned());
        }
        axis_scores.insert(axis.to_owned(), (score, lifecycle_ok));
        weighted_sum += i128::from(score) * i128::from(weight);
        weight_total += i128::from(weight);
    }

    let thresholds = object
        .get("thresholds")
        .and_then(Value::as_object)
        .ok_or("projection_thresholds_rejected")?;
    if thresholds.len() != 4 {
        return Err("projection_thresholds_rejected");
    }
    let aggregate_assert = projection_threshold(thresholds.get("aggregate_assert_micros"))
        .ok_or("projection_thresholds_rejected")?;
    let out_of_scope_below = projection_threshold(thresholds.get("out_of_scope_below_micros"))
        .ok_or("projection_thresholds_rejected")?;
    let per_axis_fail = parse_projection_thresholds(thresholds.get("per_axis_fail"))?;
    let per_axis_suspend_below =
        parse_projection_thresholds(thresholds.get("per_axis_suspend_below"))?;

    if self_health_failed_precondition_count.is_some()
        && (axes.len() != 1
            || axis_scores.get("self_health") != Some(&(0, false))
            || axes[0]
                .as_object()
                .and_then(|axis| integer_value(axis.get("weight_micros")))
                != Some(J_PROJECTION_SCALE)
            || aggregate_assert != J_PROJECTION_SCALE
            || out_of_scope_below != 0
            || !per_axis_fail.is_empty()
            || !per_axis_suspend_below.is_empty())
    {
        return Err("projection_self_health_gate_rejected");
    }

    let (runtime_kernel_j_decision, rule_id, rule_axis) = if let Some(axis) = lifecycle_axis {
        ("SUSPEND", "detector_lifecycle", Some(axis))
    } else if let Some(axis) = first_threshold_match(&per_axis_fail, &axis_scores, true) {
        ("FAIL", "per_axis_fail", Some(axis))
    } else if let Some(axis) = first_threshold_match(&per_axis_suspend_below, &axis_scores, false) {
        ("SUSPEND", "per_axis_suspend_below", Some(axis))
    } else {
        let aggregate_below_out_of_scope = if weight_total == 0 {
            0 < out_of_scope_below
        } else {
            weighted_sum < i128::from(out_of_scope_below) * weight_total
        };
        let aggregate_asserted = if weight_total == 0 {
            0 >= aggregate_assert
        } else {
            weighted_sum >= i128::from(aggregate_assert) * weight_total
        };
        if aggregate_below_out_of_scope {
            ("OUT_OF_SCOPE", "out_of_scope_below", None)
        } else if aggregate_asserted {
            ("ASSERT", "aggregate_assert", None)
        } else {
            ("SUSPEND", "default_suspend", None)
        }
    };

    let policy_decision_matches = policy_typescript_decision == runtime_kernel_j_decision;
    let policy_rule_matches =
        typescript_policy_rule_id == rule_id && typescript_policy_rule_axis == rule_axis;
    if let Some(memory_value) = object.get("memory_transition") {
        let memory = compare_memory_transition(memory_value)?;
        let lifecycle_matches = memory.matches
            && memory.residual_status_matches
            && memory.memory_revision_matches != Some(false);
        let matches = purpose_binding_matches.unwrap_or(true)
            && purpose_binding_current_matches.unwrap_or(true)
            && plan_step_adoption.matches.unwrap_or(true)
            && policy_decision_matches
            && policy_rule_matches
            && lifecycle_matches;
        let comparison_status = projection_comparison_status(
            matches,
            current_goal_purpose_binding_status,
            &plan_step_adoption,
        );
        return Ok(JProjectionComparison {
            comparison_kind: "memory_approval",
            comparison_status,
            typescript_decision: policy_typescript_decision,
            typescript_policy_rule_id,
            typescript_policy_rule_axis,
            runtime_kernel_j_decision,
            rule_id: "memory_approval_transition",
            rule_axis: None,
            purpose_binding_matches,
            current_goal_purpose_binding_status,
            purpose_binding_current_matches,
            plan_step_adoption,
            policy_decision_matches,
            policy_rule_matches,
            lifecycle_matches,
            memory_transition_kind: Some(memory.kind),
            memory_reference_review_matches: memory.reference_review_matches,
            memory_revision_matches: memory.memory_revision_matches,
            memory_transition_matches: Some(memory.matches),
            residual_status: Some(memory.residual_status),
            residual_status_matches: Some(memory.residual_status_matches),
        });
    }
    let Some(resume_value) = object.get("resume_transition") else {
        let matches = purpose_binding_matches.unwrap_or(true)
            && purpose_binding_current_matches.unwrap_or(true)
            && plan_step_adoption.matches.unwrap_or(true)
            && policy_decision_matches
            && policy_rule_matches;
        let comparison_status = projection_comparison_status(
            matches,
            current_goal_purpose_binding_status,
            &plan_step_adoption,
        );
        return Ok(JProjectionComparison {
            comparison_kind: "decision",
            comparison_status,
            typescript_decision: policy_typescript_decision,
            typescript_policy_rule_id,
            typescript_policy_rule_axis,
            runtime_kernel_j_decision,
            rule_id,
            rule_axis,
            purpose_binding_matches,
            current_goal_purpose_binding_status,
            purpose_binding_current_matches,
            plan_step_adoption,
            policy_decision_matches,
            policy_rule_matches,
            lifecycle_matches: true,
            memory_transition_kind: None,
            memory_reference_review_matches: None,
            memory_revision_matches: None,
            memory_transition_matches: None,
            residual_status: None,
            residual_status_matches: None,
        });
    };

    let resume = resume_value
        .as_object()
        .ok_or("projection_resume_transition_rejected")?;
    if resume.len() != 4 {
        return Err("projection_resume_transition_rejected");
    }
    let owner_verdict = string_value(resume.get("owner_verdict"))
        .filter(|value| matches!(*value, "approve" | "reject" | "block"))
        .ok_or("projection_resume_verdict_rejected")?;
    let resume_allowed = resume
        .get("resume_allowed")
        .and_then(Value::as_bool)
        .ok_or("projection_resume_allowed_rejected")?;
    let typescript_resume_decision = string_value(resume.get("typescript_result_decision"))
        .filter(|value| is_shadow_decision(value))
        .ok_or("projection_resume_decision_rejected")?
        .to_owned();
    let command_present = resume
        .get("command_present")
        .and_then(Value::as_bool)
        .ok_or("projection_resume_command_rejected")?;
    if has_self_health_gate
        && (resume_allowed || typescript_resume_decision != "SUSPEND" || command_present)
    {
        return Err("projection_self_health_gate_rejected");
    }
    let (runtime_kernel_j_decision, expected_command_present) = if !resume_allowed {
        ("SUSPEND", false)
    } else {
        match owner_verdict {
            "approve" => ("ASSERT", true),
            "reject" => ("FAIL", false),
            "block" => ("OUT_OF_SCOPE", false),
            _ => return Err("projection_resume_verdict_rejected"),
        }
    };
    let lifecycle_matches = typescript_resume_decision == runtime_kernel_j_decision
        && command_present == expected_command_present;
    let matches = purpose_binding_matches.unwrap_or(true)
        && purpose_binding_current_matches.unwrap_or(true)
        && plan_step_adoption.matches.unwrap_or(true)
        && policy_decision_matches
        && policy_rule_matches
        && lifecycle_matches;
    let comparison_status = projection_comparison_status(
        matches,
        current_goal_purpose_binding_status,
        &plan_step_adoption,
    );
    Ok(JProjectionComparison {
        comparison_kind: "resume",
        comparison_status,
        typescript_decision: typescript_resume_decision,
        typescript_policy_rule_id,
        typescript_policy_rule_axis,
        runtime_kernel_j_decision,
        rule_id: "human_resume_transition",
        rule_axis: None,
        purpose_binding_matches,
        current_goal_purpose_binding_status,
        purpose_binding_current_matches,
        plan_step_adoption,
        policy_decision_matches,
        policy_rule_matches,
        lifecycle_matches,
        memory_transition_kind: None,
        memory_reference_review_matches: None,
        memory_revision_matches: None,
        memory_transition_matches: None,
        residual_status: None,
        residual_status_matches: None,
    })
}

fn compare_plan_step_adoption(value: &Value) -> Result<JPlanStepAdoptionComparison, &'static str> {
    let object = value
        .as_object()
        .ok_or("projection_plan_step_adoption_rejected")?;
    let status =
        string_value(object.get("status")).ok_or("projection_plan_step_adoption_rejected")?;
    match status {
        "not_applicable" if object.len() == 1 => Ok(JPlanStepAdoptionComparison {
            matches: None,
            comparable: true,
            receipt: json!({ "status": "not_applicable", "matches": null }),
        }),
        "not_comparable" if object.len() == 2 => {
            let reason = string_value(object.get("reason"))
                .filter(|reason| {
                    matches!(
                        *reason,
                        "binding_identity_unavailable"
                            | "binding_unavailable"
                            | "binding_not_selected"
                            | "legacy_record_unavailable"
                            | "record_invalid"
                    )
                })
                .ok_or("projection_plan_step_adoption_rejected")?;
            Ok(JPlanStepAdoptionComparison {
                matches: None,
                comparable: false,
                receipt: json!({ "status": "not_comparable", "reason": reason, "matches": null }),
            })
        }
        "available" if object.len() == 3 => {
            let purpose = object
                .get("purpose_relation")
                .and_then(Value::as_object)
                .filter(|purpose| purpose.len() == 5)
                .ok_or("projection_plan_step_adoption_rejected")?;
            let purpose_status = string_value(purpose.get("status"))
                .filter(|status| matches!(*status, "not_required" | "owner_reviewed_supports"))
                .ok_or("projection_plan_step_adoption_rejected")?;
            let candidate_outcome = string_value(purpose.get("candidate_outcome"))
                .filter(|outcome| matches!(*outcome, "supports" | "conflicts" | "unknown"))
                .ok_or("projection_plan_step_adoption_rejected")?;
            let candidate_status = string_value(purpose.get("candidate_status"))
                .filter(|candidate| matches!(*candidate, "present" | "missing" | "invalid"))
                .ok_or("projection_plan_step_adoption_rejected")?;
            let purpose_evidence_status = string_value(purpose.get("evidence_status"))
                .filter(|evidence| {
                    matches!(
                        *evidence,
                        "exact_spans_present"
                            | "not_provided"
                            | "citation_mismatch"
                            | "purpose_unavailable"
                    )
                })
                .ok_or("projection_plan_step_adoption_rejected")?;
            let owner_review_outcome = match purpose.get("owner_review_outcome") {
                Some(Value::Null) => None,
                Some(Value::String(outcome)) if outcome == "supports" => Some(outcome.as_str()),
                _ => return Err("projection_plan_step_adoption_rejected"),
            };

            let criterion = object
                .get("criterion_relation")
                .and_then(Value::as_object)
                .filter(|criterion| criterion.len() == 9)
                .ok_or("projection_plan_step_adoption_rejected")?;
            let criterion_outcome = string_value(criterion.get("outcome"))
                .filter(|outcome| matches!(*outcome, "supports" | "conflicts" | "unknown"))
                .ok_or("projection_plan_step_adoption_rejected")?;
            let criterion_evidence_status = string_value(criterion.get("evidence_status"))
                .filter(|evidence| {
                    matches!(*evidence, "observed" | "inferred" | "assumed" | "unknown")
                })
                .ok_or("projection_plan_step_adoption_rejected")?;
            let criterion_risk_status = string_value(criterion.get("risk_status"))
                .filter(|risk| matches!(*risk, "verified" | "unverified"))
                .ok_or("projection_plan_step_adoption_rejected")?;
            let count = |key: &str| {
                integer_value(criterion.get(key)).filter(|count| (0..=64).contains(count))
            };
            let relation_count =
                count("relation_count").ok_or("projection_plan_step_adoption_rejected")?;
            let objective_count =
                count("objective_count").ok_or("projection_plan_step_adoption_rejected")?;
            let safety_count =
                count("safety_count").ok_or("projection_plan_step_adoption_rejected")?;
            let supports_count =
                count("supports_count").ok_or("projection_plan_step_adoption_rejected")?;
            let conflicts_count =
                count("conflicts_count").ok_or("projection_plan_step_adoption_rejected")?;
            let criterion_reason_code = string_value(criterion.get("reason_code"))
                .filter(|reason| {
                    matches!(
                        *reason,
                        "request_declares_criterion_support_risk_unverified"
                            | "request_declares_criterion_conflict"
                            | "no_matching_goal_criterion"
                            | "criteria_unavailable"
                            | "criteria_invalid"
                    )
                })
                .ok_or("projection_plan_step_adoption_rejected")?;

            let purpose_matches = match purpose_status {
                "not_required" => {
                    candidate_outcome == "unknown"
                        && candidate_status == "missing"
                        && purpose_evidence_status == "not_provided"
                        && owner_review_outcome.is_none()
                }
                "owner_reviewed_supports" => owner_review_outcome == Some("supports"),
                _ => false,
            };
            let counts_match = objective_count + safety_count == relation_count
                && supports_count + conflicts_count == relation_count;
            let criteria_matches = criterion_risk_status == "unverified"
                && counts_match
                && match criterion_outcome {
                    "unknown" => {
                        criterion_evidence_status == "unknown"
                            && relation_count == 0
                            && (criterion_reason_code == "criteria_unavailable"
                                || criterion_reason_code == "no_matching_goal_criterion")
                    }
                    "supports" => {
                        criterion_evidence_status == "assumed"
                            && supports_count > 0
                            && conflicts_count == 0
                            && criterion_reason_code
                                == "request_declares_criterion_support_risk_unverified"
                    }
                    // A selected step carrying a declared conflict violates the existing J adoption gate.
                    "conflicts" => false,
                    _ => false,
                };
            let matches = purpose_matches && criteria_matches;
            let comparison_status = if matches { "matched" } else { "mismatched" };
            let purpose_receipt = json!({
                "status": purpose_status,
                "candidate_outcome": candidate_outcome,
                "candidate_status": candidate_status,
                "evidence_status": purpose_evidence_status,
                "owner_review_outcome": owner_review_outcome,
            });
            let criterion_receipt = json!({
                "outcome": criterion_outcome,
                "evidence_status": criterion_evidence_status,
                "risk_status": criterion_risk_status,
                "relation_count": relation_count,
                "objective_count": objective_count,
                "safety_count": safety_count,
                "supports_count": supports_count,
                "conflicts_count": conflicts_count,
                "reason_code": criterion_reason_code,
            });
            Ok(JPlanStepAdoptionComparison {
                matches: Some(matches),
                comparable: true,
                receipt: json!({
                    "status": comparison_status,
                    "matches": matches,
                    "purpose_relation": purpose_receipt,
                    "criterion_relation": criterion_receipt,
                }),
            })
        }
        _ => Err("projection_plan_step_adoption_rejected"),
    }
}

fn compare_meaning_update_reference_review(value: &Value) -> Result<(bool, bool), &'static str> {
    const MAX_MEMORY_TRANSITION_COUNT: i64 = 512;
    let object = value
        .as_object()
        .ok_or("projection_memory_transition_rejected")?;
    if object.len() != 13 {
        return Err("projection_memory_transition_rejected");
    }
    let review_status = string_value(object.get("review_status"))
        .filter(|value| {
            matches!(
                *value,
                "no_current_projection"
                    | "current_m_unverified"
                    | "evidence_version_mismatch"
                    | "target_reference_unverified"
                    | "target_reference_mismatch"
                    | "prior_version_unverified"
                    | "scope_reference_mismatch"
                    | "scope_digest_mismatch"
                    | "counterevidence_absence_unverified"
                    | "references_verified_unadopted"
            )
        })
        .ok_or("projection_memory_transition_rejected")?;
    let count = |key: &str| {
        integer_value(object.get(key))
            .filter(|value| (0..=MAX_MEMORY_TRANSITION_COUNT).contains(value))
    };
    let supporting_count =
        count("supporting_reference_count").ok_or("projection_memory_transition_rejected")?;
    let supporting_verified =
        count("supporting_references_verified").ok_or("projection_memory_transition_rejected")?;
    let counterevidence_count =
        count("counterevidence_reference_count").ok_or("projection_memory_transition_rejected")?;
    let counterevidence_verified = count("counterevidence_references_verified")
        .ok_or("projection_memory_transition_rejected")?;
    let boolean = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_bool)
            .ok_or("projection_memory_transition_rejected")
    };
    let applicability_scope_matches = boolean("applicability_scope_matches_current")?;
    let counterevidence_scope_matches = boolean("counterevidence_scope_matches_current")?;
    let applicability_scope_digest_matches = boolean("applicability_scope_digest_matches_current")?;
    let counterevidence_scope_digest_matches =
        boolean("counterevidence_scope_digest_matches_current")?;
    let scope_digests_verified = boolean("scope_digests_verified")?;
    let target_reference_matches = boolean("target_reference_matches_current_projection")?;
    let counterevidence_claim_status = string_value(object.get("counterevidence_claim_status"))
        .filter(|value| {
            matches!(
                *value,
                "references_verified" | "references_unverified" | "none_found_unverified"
            )
        })
        .ok_or("projection_memory_transition_rejected")?;
    let candidate_content_digest_status =
        string_value(object.get("candidate_content_digest_status"))
            .filter(|value| matches!(*value, "verified" | "unavailable"))
            .ok_or("projection_memory_transition_rejected")?;

    let counts_match = supporting_verified <= supporting_count
        && counterevidence_verified <= counterevidence_count;
    let counterevidence_claim_matches = match counterevidence_claim_status {
        "references_verified" => counterevidence_verified == counterevidence_count,
        "references_unverified" => counterevidence_verified < counterevidence_count,
        "none_found_unverified" => counterevidence_count == 0 && counterevidence_verified == 0,
        _ => false,
    };
    let scope_projection_matches = scope_digests_verified
        == (applicability_scope_digest_matches && counterevidence_scope_digest_matches);
    let status_projection_matches = match review_status {
        "prior_version_unverified" => {
            supporting_count > 0
                && supporting_verified == supporting_count
                && counterevidence_count > 0
                && counterevidence_verified == counterevidence_count
                && counterevidence_claim_status == "references_verified"
                && applicability_scope_matches
                && counterevidence_scope_matches
                && applicability_scope_digest_matches
                && counterevidence_scope_digest_matches
                && scope_digests_verified
                && target_reference_matches
                && candidate_content_digest_status == "verified"
        }
        "counterevidence_absence_unverified" => {
            supporting_count > 0
                && supporting_verified == supporting_count
                && counterevidence_count == 0
                && counterevidence_verified == 0
                && counterevidence_claim_status == "none_found_unverified"
                && applicability_scope_matches
                && counterevidence_scope_matches
                && applicability_scope_digest_matches
                && counterevidence_scope_digest_matches
                && scope_digests_verified
                && (target_reference_matches || candidate_content_digest_status == "unavailable")
        }
        _ => true,
    };
    let matches = counts_match
        && counterevidence_claim_matches
        && scope_projection_matches
        && status_projection_matches;
    let eligible = matches
        && matches!(
            review_status,
            "prior_version_unverified" | "counterevidence_absence_unverified"
        );
    Ok((matches, eligible))
}

fn compare_memory_transition(value: &Value) -> Result<JMemoryTransitionComparison, &'static str> {
    const MAX_MEMORY_TRANSITION_COUNT: i64 = 512;
    let object = value
        .as_object()
        .ok_or("projection_memory_transition_rejected")?;
    let kind = string_value(object.get("kind")).ok_or("projection_memory_transition_rejected")?;
    match kind {
        "meaning_update_adoption" => {
            if object.len() != 12 {
                return Err("projection_memory_transition_rejected");
            }
            let owner_verdict = string_value(object.get("owner_verdict"))
                .filter(|value| matches!(*value, "approve" | "reject" | "block"))
                .ok_or("projection_memory_transition_rejected")?;
            let application_status = string_value(object.get("memory_application_status"))
                .filter(|value| matches!(*value, "applied" | "not_applied"))
                .ok_or("projection_memory_transition_rejected")?;
            let memory_revision_matches =
                compare_memory_revision_transition(object, application_status)?;
            let (reference_review_matches, reference_review_eligible) =
                match object.get("reference_review") {
                    Some(Value::Null)
                        if owner_verdict != "approve" || application_status == "not_applied" =>
                    {
                        (None, None)
                    }
                    Some(value) => {
                        let (matches, eligible) = compare_meaning_update_reference_review(value)?;
                        (Some(matches), Some(eligible))
                    }
                    _ => return Err("projection_memory_transition_rejected"),
                };
            let semantic_relation_status = string_value(object.get("semantic_relation_status"))
                .filter(|value| matches!(*value, "not_assessed" | "assessed"))
                .ok_or("projection_memory_transition_rejected")?;
            let follow_up_action_status = string_value(object.get("follow_up_action_status"))
                .filter(|value| matches!(*value, "unconfirmed" | "confirmed"))
                .ok_or("projection_memory_transition_rejected")?;
            let pending_count = match object.get("pending_reassessment_required_count") {
                Some(Value::Null) => None,
                Some(value) => Some(
                    integer_value(Some(value))
                        .filter(|value| (0..=MAX_MEMORY_TRANSITION_COUNT).contains(value))
                        .ok_or("projection_memory_transition_rejected")?,
                ),
                None => return Err("projection_memory_transition_rejected"),
            };
            let typescript_residual_status = string_value(object.get("typescript_residual_status"))
                .filter(|value| {
                    matches!(
                        *value,
                        "meaning_unverified"
                            | "meaning_unverified_with_reassessment_pending"
                            | "adoption_approved_not_applied"
                            | "adoption_rejected"
                            | "adoption_blocked"
                    )
                })
                .ok_or("projection_memory_transition_rejected")?;
            let used_for_authority = object
                .get("used_for_authority")
                .and_then(Value::as_bool)
                .ok_or("projection_memory_transition_rejected")?;
            let may_execute = object
                .get("may_execute")
                .and_then(Value::as_bool)
                .ok_or("projection_memory_transition_rejected")?;
            let application_matches = match (owner_verdict, application_status) {
                ("approve", "applied") => {
                    pending_count.is_some() && reference_review_eligible == Some(true)
                }
                ("approve", "not_applied") => {
                    pending_count.is_none() && reference_review_matches != Some(false)
                }
                ("reject" | "block", "not_applied") => {
                    pending_count.is_none() && reference_review_matches.is_none()
                }
                _ => false,
            };
            let transition_matches = application_matches
                && memory_revision_matches != Some(false)
                && semantic_relation_status == "not_assessed"
                && follow_up_action_status == "unconfirmed"
                && !used_for_authority
                && !may_execute;
            let expected_residual_status =
                if owner_verdict == "approve" && application_status == "not_applied" {
                    "adoption_approved_not_applied"
                } else if owner_verdict == "reject" {
                    "adoption_rejected"
                } else if owner_verdict == "block" {
                    "adoption_blocked"
                } else if pending_count == Some(0) {
                    "meaning_unverified"
                } else {
                    "meaning_unverified_with_reassessment_pending"
                };
            let residual_status_matches = typescript_residual_status == expected_residual_status;
            Ok(JMemoryTransitionComparison {
                kind: "meaning_update_adoption",
                matches: transition_matches,
                reference_review_matches,
                memory_revision_matches,
                residual_status: expected_residual_status,
                residual_status_matches,
            })
        }
        "memory_judgment_reassessment" => {
            if object.len() != 11 {
                return Err("projection_memory_transition_rejected");
            }
            let owner_verdict = string_value(object.get("owner_verdict"))
                .filter(|value| matches!(*value, "approve" | "reject" | "block"))
                .ok_or("projection_memory_transition_rejected")?;
            let application_status = string_value(object.get("memory_application_status"))
                .filter(|value| matches!(*value, "applied" | "not_applied"))
                .ok_or("projection_memory_transition_rejected")?;
            let memory_revision_matches =
                compare_memory_revision_transition(object, application_status)?;
            let requested_count = integer_value(object.get("requested_judgment_count"))
                .filter(|value| (1..=MAX_MEMORY_TRANSITION_COUNT).contains(value))
                .ok_or("projection_memory_transition_rejected")?;
            let reassessed_count = integer_value(object.get("reassessed_judgment_count"))
                .filter(|value| (0..=MAX_MEMORY_TRANSITION_COUNT).contains(value))
                .ok_or("projection_memory_transition_rejected")?;
            let remaining_count =
                integer_value(object.get("remaining_reassessment_required_count"))
                    .filter(|value| (0..=MAX_MEMORY_TRANSITION_COUNT).contains(value))
                    .ok_or("projection_memory_transition_rejected")?;
            let typescript_residual_status = string_value(object.get("typescript_residual_status"))
                .filter(|value| {
                    matches!(
                        *value,
                        "named_judgments_reassessed" | "named_judgments_pending"
                    )
                })
                .ok_or("projection_memory_transition_rejected")?;
            let used_for_authority = object
                .get("used_for_authority")
                .and_then(Value::as_bool)
                .ok_or("projection_memory_transition_rejected")?;
            let may_execute = object
                .get("may_execute")
                .and_then(Value::as_bool)
                .ok_or("projection_memory_transition_rejected")?;
            let counts_are_consistent = reassessed_count + remaining_count == requested_count;
            let not_applied = application_status == "not_applied"
                && reassessed_count == 0
                && remaining_count == requested_count;
            let application_matches = if owner_verdict == "approve" {
                (application_status == "applied" && counts_are_consistent) || not_applied
            } else {
                not_applied
            };
            let transition_matches = application_matches
                && memory_revision_matches != Some(false)
                && !used_for_authority
                && !may_execute;
            let expected_residual_status =
                if reassessed_count == requested_count && remaining_count == 0 {
                    "named_judgments_reassessed"
                } else {
                    "named_judgments_pending"
                };
            let residual_status_matches = typescript_residual_status == expected_residual_status;
            Ok(JMemoryTransitionComparison {
                kind: "memory_judgment_reassessment",
                matches: transition_matches,
                reference_review_matches: None,
                memory_revision_matches,
                residual_status: expected_residual_status,
                residual_status_matches,
            })
        }
        _ => Err("projection_memory_transition_rejected"),
    }
}

fn compare_memory_revision_transition(
    object: &Map<String, Value>,
    application_status: &str,
) -> Result<Option<bool>, &'static str> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    match application_status {
        "applied" => {
            let before = integer_value(object.get("memory_revision_before"))
                .filter(|value| (0..=MAX_SAFE_INTEGER).contains(value))
                .ok_or("projection_memory_transition_rejected")?;
            let after = integer_value(object.get("memory_revision_after"))
                .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
                .ok_or("projection_memory_transition_rejected")?;
            Ok(Some(before.checked_add(1) == Some(after)))
        }
        "not_applied"
            if object.get("memory_revision_before") == Some(&Value::Null)
                && object.get("memory_revision_after") == Some(&Value::Null) =>
        {
            Ok(None)
        }
        _ => Err("projection_memory_transition_rejected"),
    }
}

fn parse_projection_thresholds(value: Option<&Value>) -> Result<Vec<(String, i64)>, &'static str> {
    let values = value
        .and_then(Value::as_array)
        .ok_or("projection_thresholds_rejected")?;
    if values.len() > MAX_J_PROJECTION_AXES {
        return Err("projection_thresholds_rejected");
    }
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(values.len());
    for entry in values {
        let object = entry.as_object().ok_or("projection_thresholds_rejected")?;
        if object.len() != 2 {
            return Err("projection_thresholds_rejected");
        }
        let axis = string_value(object.get("axis")).ok_or("projection_thresholds_rejected")?;
        if !valid_axis_identifier(axis) || !seen.insert(axis.to_owned()) {
            return Err("projection_thresholds_rejected");
        }
        let threshold = projection_threshold(object.get("threshold_micros"))
            .ok_or("projection_thresholds_rejected")?;
        result.push((axis.to_owned(), threshold));
    }
    Ok(result)
}

fn projection_threshold(value: Option<&Value>) -> Option<i64> {
    integer_value(value)
        .filter(|value| (-J_PROJECTION_SCALE..=2 * J_PROJECTION_SCALE).contains(value))
}

fn first_threshold_match(
    thresholds: &[(String, i64)],
    scores: &HashMap<String, (i64, bool)>,
    inclusive: bool,
) -> Option<String> {
    thresholds.iter().find_map(|(axis, threshold)| {
        let (score, _) = scores.get(axis)?;
        let matched = if inclusive {
            score <= threshold
        } else {
            score < threshold
        };
        matched.then(|| axis.clone())
    })
}

fn valid_axis_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'.' | b'-'))
}

fn is_shadow_decision(value: &str) -> bool {
    matches!(value, "ASSERT" | "SUSPEND" | "OUT_OF_SCOPE" | "FAIL")
}

fn is_shadow_policy_rule_id(value: &str) -> bool {
    matches!(
        value,
        "detector_lifecycle"
            | "per_axis_fail"
            | "per_axis_suspend_below"
            | "out_of_scope_below"
            | "aggregate_assert"
            | "default_suspend"
    )
}

fn requires_policy_rule_axis(value: &str) -> bool {
    matches!(
        value,
        "detector_lifecycle" | "per_axis_fail" | "per_axis_suspend_below"
    )
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

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
    use super::{
        compare_memory_transition, current_utc_timestamp, days_from_civil, parse_utc_millis,
    };
    use serde_json::json;

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

    #[test]
    fn memory_transition_shadow_compares_the_m_receipt_revision() {
        let reference_review = json!({
            "review_status": "prior_version_unverified",
            "supporting_reference_count": 1,
            "supporting_references_verified": 1,
            "counterevidence_reference_count": 1,
            "counterevidence_references_verified": 1,
            "applicability_scope_matches_current": true,
            "counterevidence_scope_matches_current": true,
            "applicability_scope_digest_matches_current": true,
            "counterevidence_scope_digest_matches_current": true,
            "counterevidence_claim_status": "references_verified",
            "scope_digests_verified": true,
            "target_reference_matches_current_projection": true,
            "candidate_content_digest_status": "verified"
        });
        let projection = json!({
            "kind": "meaning_update_adoption",
            "owner_verdict": "approve",
            "memory_application_status": "applied",
            "memory_revision_before": 4,
            "memory_revision_after": 5,
            "reference_review": reference_review.clone(),
            "semantic_relation_status": "not_assessed",
            "follow_up_action_status": "unconfirmed",
            "pending_reassessment_required_count": 2,
            "typescript_residual_status": "meaning_unverified_with_reassessment_pending",
            "used_for_authority": false,
            "may_execute": false
        });
        let matched = compare_memory_transition(&projection).expect("valid M revision transition");
        assert_eq!(matched.memory_revision_matches, Some(true));
        assert_eq!(matched.reference_review_matches, Some(true));
        assert!(matched.matches);
        assert!(matched.residual_status_matches);

        let mut skipped_revision = projection.clone();
        skipped_revision["memory_revision_after"] = json!(6);
        let mismatched =
            compare_memory_transition(&skipped_revision).expect("well-formed revision gap");
        assert_eq!(mismatched.memory_revision_matches, Some(false));
        assert!(!mismatched.matches);
        assert!(mismatched.residual_status_matches);

        let mut inconsistent_review = projection;
        inconsistent_review["reference_review"]["supporting_references_verified"] = json!(0);
        let mismatched_review = compare_memory_transition(&inconsistent_review)
            .expect("well-formed but inconsistent reference review counts");
        assert_eq!(mismatched_review.reference_review_matches, Some(false));
        assert!(!mismatched_review.matches);
    }

    #[test]
    fn memory_transition_without_application_has_no_m_revision() {
        let projection = json!({
            "kind": "meaning_update_adoption",
            "owner_verdict": "reject",
            "memory_application_status": "not_applied",
            "memory_revision_before": null,
            "memory_revision_after": null,
            "reference_review": null,
            "semantic_relation_status": "not_assessed",
            "follow_up_action_status": "unconfirmed",
            "pending_reassessment_required_count": null,
            "typescript_residual_status": "adoption_rejected",
            "used_for_authority": false,
            "may_execute": false
        });
        let comparison =
            compare_memory_transition(&projection).expect("valid non-applied transition");
        assert_eq!(comparison.memory_revision_matches, None);
        assert!(comparison.matches);
    }
}
