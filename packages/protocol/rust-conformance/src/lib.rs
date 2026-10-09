use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::HashSet;
use std::fmt::{self, Write as FmtWrite};

pub const BOUNDARY_EXCHANGE_SCHEMA_VERSION: &str = "blue-tanuki.boundary-exchange.v1";
pub const BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION: &str = "blue-tanuki.jcs-safe-integer.v1";
pub const BOUNDARY_EXCHANGE_MAX_BYTES: usize = 1_048_576;
pub const BOUNDARY_EXCHANGE_MAX_DEPTH: usize = 64;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoundaryExchangeFailure {
    InvalidUtf8,
    InvalidJson,
    DuplicateKey,
    InvalidUnicode,
    InvalidNumberProfile,
    SchemaValidationFailed,
    DangerousKey,
    PayloadTooLarge,
    PayloadTooDeep,
}

impl BoundaryExchangeFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidUtf8 => "invalid_utf8",
            Self::InvalidJson => "invalid_json",
            Self::DuplicateKey => "duplicate_key",
            Self::InvalidUnicode => "invalid_unicode",
            Self::InvalidNumberProfile => "invalid_number_profile",
            Self::SchemaValidationFailed => "schema_validation_failed",
            Self::DangerousKey => "dangerous_key",
            Self::PayloadTooLarge => "payload_too_large",
            Self::PayloadTooDeep => "payload_too_deep",
        }
    }
}

#[derive(Debug, PartialEq)]
enum JsonValue {
    Null,
    Bool(bool),
    Integer(i64),
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

impl<'de> Deserialize<'de> for JsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(JsonValueVisitor)
    }
}

struct JsonValueVisitor;

impl<'de> Visitor<'de> for JsonValueVisitor {
    type Value = JsonValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value with unique object keys and safe integer numbers")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(JsonValue::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(JsonValue::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(JsonValue::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
            return Err(E::custom("invalid_number_profile"));
        }
        Ok(JsonValue::Integer(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value > MAX_SAFE_INTEGER as u64 {
            return Err(E::custom("invalid_number_profile"));
        }
        Ok(JsonValue::Integer(value as i64))
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Err(E::custom("invalid_number_profile"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(JsonValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(JsonValue::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<JsonValue>()? {
            values.push(value);
        }
        Ok(JsonValue::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = HashSet::new();
        let mut entries = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, JsonValue>()? {
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom("duplicate_key"));
            }
            entries.push((key, value));
        }
        Ok(JsonValue::Object(entries))
    }
}

/// 制限交換profileを検査し、RFC 8785に従うcanonical UTF-8 bytesを出力する。
/// このconformance関数はissuer、permission、approval、execution状態を作らない。
pub fn canonicalize_boundary_exchange(raw: &[u8]) -> Result<Vec<u8>, BoundaryExchangeFailure> {
    if raw.len() > BOUNDARY_EXCHANGE_MAX_BYTES {
        return Err(BoundaryExchangeFailure::PayloadTooLarge);
    }
    let text = std::str::from_utf8(raw).map_err(|_| BoundaryExchangeFailure::InvalidUtf8)?;
    inspect_raw_json_profile(text)?;

    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = JsonValue::deserialize(&mut deserializer).map_err(map_json_error)?;
    deserializer
        .end()
        .map_err(|_| BoundaryExchangeFailure::InvalidJson)?;

    validate_contract(&value)?;
    let mut canonical = String::new();
    write_canonical(&value, &mut canonical);
    Ok(canonical.into_bytes())
}

fn map_json_error(error: serde_json::Error) -> BoundaryExchangeFailure {
    let message = error.to_string();
    if message.contains("duplicate_key") {
        BoundaryExchangeFailure::DuplicateKey
    } else if message.contains("invalid_number_profile") {
        BoundaryExchangeFailure::InvalidNumberProfile
    } else {
        BoundaryExchangeFailure::InvalidJson
    }
}

fn inspect_raw_json_profile(text: &str) -> Result<(), BoundaryExchangeFailure> {
    let bytes = text.as_bytes();
    let mut index = 0;
    let mut depth = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index = inspect_json_string(bytes, index)?;
            }
            b'{' | b'[' => {
                depth += 1;
                if depth > BOUNDARY_EXCHANGE_MAX_DEPTH {
                    return Err(BoundaryExchangeFailure::PayloadTooDeep);
                }
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = index;
                while index < bytes.len()
                    && (bytes[index].is_ascii_digit()
                        || matches!(bytes[index], b'e' | b'E' | b'.' | b'+' | b'-'))
                {
                    index += 1;
                }
                let token = &text[start..index];
                if !is_json_number_token(token) {
                    return Err(BoundaryExchangeFailure::InvalidJson);
                }
                if !is_safe_integer_token(token) {
                    return Err(BoundaryExchangeFailure::InvalidNumberProfile);
                }
            }
            _ => index += 1,
        }
    }

    Ok(())
}

fn inspect_json_string(bytes: &[u8], start: usize) -> Result<usize, BoundaryExchangeFailure> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return Ok(index + 1),
            b'\\' => {
                let escape = *bytes
                    .get(index + 1)
                    .ok_or(BoundaryExchangeFailure::InvalidJson)?;
                if escape != b'u' {
                    index += 2;
                    continue;
                }
                let code_unit = read_hex_code_unit(bytes, index + 2)?;
                if (0xd800..=0xdbff).contains(&code_unit) {
                    if bytes.get(index + 6) != Some(&b'\\') || bytes.get(index + 7) != Some(&b'u') {
                        return Err(BoundaryExchangeFailure::InvalidUnicode);
                    }
                    let trailing = read_hex_code_unit(bytes, index + 8)?;
                    if !(0xdc00..=0xdfff).contains(&trailing) {
                        return Err(BoundaryExchangeFailure::InvalidUnicode);
                    }
                    index += 12;
                } else if (0xdc00..=0xdfff).contains(&code_unit) {
                    return Err(BoundaryExchangeFailure::InvalidUnicode);
                } else {
                    index += 6;
                }
            }
            _ => index += 1,
        }
    }
    Ok(bytes.len())
}

fn read_hex_code_unit(bytes: &[u8], start: usize) -> Result<u16, BoundaryExchangeFailure> {
    let token = bytes
        .get(start..start + 4)
        .ok_or(BoundaryExchangeFailure::InvalidJson)?;
    let mut value = 0_u16;
    for byte in token {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(BoundaryExchangeFailure::InvalidJson),
        };
        value = (value << 4) | u16::from(digit);
    }
    Ok(value)
}

fn is_json_number_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut index = 0;
    if bytes.get(index) == Some(&b'-') {
        index += 1;
    }
    match bytes.get(index) {
        Some(b'0') => index += 1,
        Some(b'1'..=b'9') => {
            index += 1;
            while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}

fn is_safe_integer_token(token: &str) -> bool {
    if token == "-0"
        || token.starts_with('+')
        || token.chars().any(|value| matches!(value, '.' | 'e' | 'E'))
    {
        return false;
    }
    let digits = token.strip_prefix('-').unwrap_or(token);
    if digits.len() > 16 {
        return false;
    }
    token
        .parse::<i64>()
        .is_ok_and(|value| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value))
}

fn validate_contract(value: &JsonValue) -> Result<(), BoundaryExchangeFailure> {
    let entries = match value {
        JsonValue::Object(entries) => entries,
        _ => return Err(BoundaryExchangeFailure::SchemaValidationFailed),
    };
    if entries.len() != 4 {
        return Err(BoundaryExchangeFailure::SchemaValidationFailed);
    }
    let mut schema_version = None;
    let mut canonicalization_version = None;
    let mut issued_at_utc = None;
    let mut content = None;
    for (key, value) in entries {
        match key.as_str() {
            "schema_version" => schema_version = value.as_str(),
            "canonicalization_version" => canonicalization_version = value.as_str(),
            "issued_at_utc" => issued_at_utc = value.as_str(),
            "content" => content = Some(value),
            _ => return Err(BoundaryExchangeFailure::SchemaValidationFailed),
        }
    }
    if schema_version != Some(BOUNDARY_EXCHANGE_SCHEMA_VERSION)
        || canonicalization_version != Some(BOUNDARY_EXCHANGE_CANONICALIZATION_VERSION)
        || !issued_at_utc.is_some_and(is_utc_millisecond_timestamp)
    {
        return Err(BoundaryExchangeFailure::SchemaValidationFailed);
    }
    let content = content.ok_or(BoundaryExchangeFailure::SchemaValidationFailed)?;
    if !matches!(content, JsonValue::Object(_)) {
        return Err(BoundaryExchangeFailure::SchemaValidationFailed);
    }
    if contains_dangerous_key(content) {
        return Err(BoundaryExchangeFailure::DangerousKey);
    }
    Ok(())
}

impl JsonValue {
    fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }
}

fn is_utc_millisecond_timestamp(value: &str) -> bool {
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
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit() {
            return false;
        }
    }

    let year = decimal(&bytes[0..4]);
    let month = decimal(&bytes[5..7]);
    let day = decimal(&bytes[8..10]);
    let hour = decimal(&bytes[11..13]);
    let minute = decimal(&bytes[14..16]);
    let second = decimal(&bytes[17..19]);
    let millisecond = decimal(&bytes[20..23]);
    if year < 1 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
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
    day >= 1 && day <= days[(month - 1) as usize] && millisecond <= 999
}

fn decimal(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0, |value, digit| value * 10 + u32::from(*digit - b'0'))
}

fn contains_dangerous_key(value: &JsonValue) -> bool {
    match value {
        JsonValue::Array(values) => values.iter().any(contains_dangerous_key),
        JsonValue::Object(entries) => entries.iter().any(|(key, value)| {
            matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                || contains_dangerous_key(value)
        }),
        _ => false,
    }
}

fn write_canonical(value: &JsonValue, output: &mut String) {
    match value {
        JsonValue::Null => output.push_str("null"),
        JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        JsonValue::Integer(value) => {
            write!(output, "{value}").expect("writing to String cannot fail")
        }
        JsonValue::String(value) => write_string(value, output),
        JsonValue::Array(values) => {
            output.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(item, output);
            }
            output.push(']');
        }
        JsonValue::Object(entries) => {
            let mut sorted = entries.iter().collect::<Vec<_>>();
            sorted.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            output.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_string(key, output);
                output.push(':');
                write_canonical(item, output);
            }
            output.push('}');
        }
    }
}

fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\t' => output.push_str("\\t"),
            '\n' => output.push_str("\\n"),
            '\u{000c}' => output.push_str("\\f"),
            '\r' => output.push_str("\\r"),
            value if (value as u32) <= 0x1f => {
                write!(output, "\\u{:04x}", value as u32).expect("writing to String cannot fail");
            }
            value => output.push(value),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_boundary_exchange, BoundaryExchangeFailure};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct VectorFile {
        format_version: String,
        positive: Vec<PositiveVector>,
        negative: Vec<NegativeVector>,
    }

    #[derive(Deserialize)]
    struct PositiveVector {
        id: String,
        input: String,
        canonical: String,
    }

    #[derive(Deserialize)]
    struct NegativeVector {
        id: String,
        input: Option<String>,
        input_utf8_hex: Option<String>,
        generated: Option<GeneratedInput>,
        reason: String,
    }

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum GeneratedInput {
        OversizedContent { repeat: usize },
        NestedArrays { count: usize },
    }

    fn vectors() -> VectorFile {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test/fixtures/c01_02_境界交換vector.json"
        )))
        .expect("shared C01.02 vector corpus is valid JSON")
    }

    #[test]
    fn c01_02_positive() {
        let vectors = vectors();
        assert_eq!(
            vectors.format_version,
            "blue-tanuki.boundary-exchange-vectors.v1"
        );
        assert!(!vectors.positive.is_empty());
        for vector in vectors.positive {
            let canonical = canonicalize_boundary_exchange(vector.input.as_bytes())
                .unwrap_or_else(|error| panic!("{} rejected: {}", vector.id, error.as_str()));
            assert_eq!(
                String::from_utf8(canonical).unwrap(),
                vector.canonical,
                "{}",
                vector.id
            );
        }
    }

    #[test]
    fn c01_02_negative() {
        let vectors = vectors();
        assert!(!vectors.negative.is_empty());
        for vector in vectors.negative {
            let input = materialize_input(&vector);
            let result = canonicalize_boundary_exchange(&input);
            let actual = result.expect_err(&vector.id).as_str();
            assert_eq!(actual, vector.reason, "{}", vector.id);
        }
    }

    fn materialize_input(vector: &NegativeVector) -> Vec<u8> {
        if let Some(input) = &vector.input {
            return input.as_bytes().to_vec();
        }
        if let Some(hex) = &vector.input_utf8_hex {
            return decode_hex(hex);
        }
        match vector
            .generated
            .as_ref()
            .expect("negative vector has input source")
        {
            GeneratedInput::OversizedContent { repeat } => {
                let prefix = r#"{"schema_version":"blue-tanuki.boundary-exchange.v1","canonicalization_version":"blue-tanuki.jcs-safe-integer.v1","issued_at_utc":"2026-10-09T00:00:00.000Z","content":{"padding":""#;
                let mut input = String::with_capacity(prefix.len() + repeat + 3);
                input.push_str(prefix);
                input.extend(std::iter::repeat_n('x', *repeat));
                input.push_str("\"}}");
                input.into_bytes()
            }
            GeneratedInput::NestedArrays { count } => {
                let mut input = String::from(
                    "{\"schema_version\":\"blue-tanuki.boundary-exchange.v1\",\"canonicalization_version\":\"blue-tanuki.jcs-safe-integer.v1\",\"issued_at_utc\":\"2026-10-09T00:00:00.000Z\",\"content\":{\"value\":",
                );
                input.extend(std::iter::repeat_n('[', *count));
                input.push('0');
                input.extend(std::iter::repeat_n(']', *count));
                input.push_str("}}");
                input.into_bytes()
            }
        }
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        let bytes = value.as_bytes();
        assert_eq!(bytes.len() % 2, 0, "hex vector length must be even");
        bytes
            .chunks_exact(2)
            .map(|pair| {
                let high = hex_nibble(pair[0]).expect("hex vector contains valid digits");
                let low = hex_nibble(pair[1]).expect("hex vector contains valid digits");
                (high << 4) | low
            })
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

    #[test]
    fn non_conformance_outputs_do_not_carry_input_values() {
        let result = canonicalize_boundary_exchange(
            br#"{"schema_version":"blue-tanuki.boundary-exchange.v1","canonicalization_version":"blue-tanuki.jcs-safe-integer.v1","issued_at_utc":"2026-10-09T00:00:00.000Z","content":{"x":1},"authority":"SECRET_VECTOR_SENTINEL"}"#,
        );
        assert_eq!(
            result.unwrap_err(),
            BoundaryExchangeFailure::SchemaValidationFailed
        );
    }
}
