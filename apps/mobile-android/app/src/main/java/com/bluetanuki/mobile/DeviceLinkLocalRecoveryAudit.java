package com.bluetanuki.mobile;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/** Non-authority local record for deleting a credential when Desktop revocation is unavailable. */
final class DeviceLinkLocalRecoveryAudit {
    static final int MAX_EVENTS = 32;
    private static final String PAYLOAD_HASH =
            "sha256:2f0b366fb62efa9e741f0127c676e648d81b263a471c35d0dd00814a174e5a92";
    private static final String EVENT_ID_PATTERN = "^[a-f0-9]{32}$";
    private static final String[] TIMESTAMP_PATTERNS = {
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    };

    private DeviceLinkLocalRecoveryAudit() {}

    static Event create() {
        return new Event(DeviceInvitation.newDeviceId(), currentTimestamp());
    }

    static Event event(String eventId, String timestamp) {
        Event event = new Event(eventId, timestamp);
        if (!isValid(event)) throw new IllegalArgumentException("local_recovery_event_invalid");
        return event;
    }

    static String currentTimestamp() {
        return timestampFormatter("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").format(new Date());
    }

    static List<Event> appendBounded(List<Event> existing, Event event) {
        if (existing == null || existing.size() > MAX_EVENTS || !isValid(event)) {
            throw new IllegalArgumentException("local_recovery_audit_invalid");
        }
        Set<String> ids = new HashSet<>();
        for (Event current : existing) {
            if (!isValid(current) || !ids.add(current.eventId)) {
                throw new IllegalArgumentException("local_recovery_audit_invalid");
            }
        }
        if (!ids.add(event.eventId)) {
            throw new IllegalArgumentException("local_recovery_event_reused");
        }
        List<Event> result = new ArrayList<>(existing);
        result.add(event);
        if (result.size() > MAX_EVENTS) result.remove(0);
        return Collections.unmodifiableList(result);
    }

    static List<Event> parse(String json) throws StrictJson.JsonException {
        Object raw = StrictJson.parse(json);
        if (!(raw instanceof List<?>)) throw new StrictJson.JsonException();
        List<?> values = (List<?>) raw;
        if (values.size() > MAX_EVENTS) throw new StrictJson.JsonException();
        List<Event> result = new ArrayList<>(values.size());
        Set<String> ids = new HashSet<>();
        for (Object value : values) {
            Map<String, Object> event = StrictJson.object(value);
            if (!StrictJson.hasExactKeys(event, "event_id", "timestamp", "actor", "action",
                    "target", "result", "payload_hash", "metadata")) {
                throw new StrictJson.JsonException();
            }
            Map<String, Object> metadata = StrictJson.object(event.get("metadata"));
            if (!StrictJson.hasExactKeys(metadata, "audit_scope", "evidence_source",
                    "desktop_revocation", "authority_effect", "operator_identity") ||
                    !"shell".equals(StrictJson.string(event, "actor")) ||
                    !"mobile_local_credential_delete".equals(StrictJson.string(event, "action")) ||
                    !"mobile_device_link_credential".equals(StrictJson.string(event, "target")) ||
                    !"success".equals(StrictJson.string(event, "result")) ||
                    !PAYLOAD_HASH.equals(StrictJson.string(event, "payload_hash")) ||
                    !"mobile_local_recovery".equals(StrictJson.string(metadata, "audit_scope")) ||
                    !"INTERNAL_STATE".equals(StrictJson.string(metadata, "evidence_source")) ||
                    !"unconfirmed".equals(StrictJson.string(metadata, "desktop_revocation")) ||
                    !"none".equals(StrictJson.string(metadata, "authority_effect")) ||
                    !"unverified".equals(StrictJson.string(metadata, "operator_identity"))) {
                throw new StrictJson.JsonException();
            }
            Event parsed = new Event(StrictJson.string(event, "event_id"),
                    StrictJson.string(event, "timestamp"));
            if (!isValid(parsed) || !ids.add(parsed.eventId)) throw new StrictJson.JsonException();
            result.add(parsed);
        }
        return Collections.unmodifiableList(result);
    }

    static String encode(List<Event> events) {
        if (events == null || events.size() > MAX_EVENTS) {
            throw new IllegalArgumentException("local_recovery_audit_invalid");
        }
        StringBuilder json = new StringBuilder("[");
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < events.size(); index++) {
            Event event = events.get(index);
            if (!isValid(event) || !ids.add(event.eventId)) {
                throw new IllegalArgumentException("local_recovery_audit_invalid");
            }
            if (index > 0) json.append(',');
            json.append("{\"event_id\":\"").append(event.eventId)
                    .append("\",\"timestamp\":\"").append(event.timestamp)
                    .append("\",\"actor\":\"shell\",\"action\":\"mobile_local_credential_delete\"")
                    .append(",\"target\":\"mobile_device_link_credential\",\"result\":\"success\"")
                    .append(",\"payload_hash\":\"").append(PAYLOAD_HASH).append("\"")
                    .append(",\"metadata\":{\"audit_scope\":\"mobile_local_recovery\"")
                    .append(",\"evidence_source\":\"INTERNAL_STATE\",\"desktop_revocation\":\"unconfirmed\"")
                    .append(",\"authority_effect\":\"none\",\"operator_identity\":\"unverified\"}}");
        }
        return json.append(']').toString();
    }

    static boolean contains(List<Event> events, String eventId) {
        if (events == null || eventId == null) return false;
        for (Event event : events) {
            if (event.eventId.equals(eventId)) return true;
        }
        return false;
    }

    static boolean isValid(Event event) {
        return event != null && event.eventId != null &&
                event.eventId.matches(EVENT_ID_PATTERN) && isCanonicalTimestamp(event.timestamp);
    }

    private static boolean isCanonicalTimestamp(String value) {
        if (value == null) return false;
        for (String pattern : TIMESTAMP_PATTERNS) {
            SimpleDateFormat formatter = timestampFormatter(pattern);
            ParsePosition position = new ParsePosition(0);
            Date parsed = formatter.parse(value, position);
            if (parsed != null && position.getIndex() == value.length() &&
                    formatter.format(parsed).equals(value)) return true;
        }
        return false;
    }

    private static SimpleDateFormat timestampFormatter(String pattern) {
        SimpleDateFormat formatter = new SimpleDateFormat(pattern, Locale.ROOT);
        formatter.setLenient(false);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter;
    }

    static final class Event {
        final String eventId;
        final String timestamp;

        Event(String eventId, String timestamp) {
            this.eventId = eventId;
            this.timestamp = timestamp;
        }
    }
}
