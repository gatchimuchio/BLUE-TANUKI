package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

public final class DesktopNotificationSummaryTest {
    private static final String NONCE = "1".repeat(32);

    @Test
    public void requestsTheReadOnlyDesktopSummaryAndProjectsOnlyFixedFields() throws Exception {
        assertEquals(Map.of("版", 1, "未読のみ", false, "上限", 16), DesktopNotificationSummary.request());
        DesktopNotificationSummary result = parse(envelope(body(List.of(row(1, "Task", "critical", "unread"),
                row(2, "Permission", "info", "read")), 1, 1)));
        assertEquals(2, result.rows.size());
        assertEquals(1, result.unreadCount);
        assertEquals(1, result.criticalCount);
        assertEquals(DesktopNotificationSummary.Category.Task, result.rows.get(0).category);
        assertEquals(DesktopNotificationSummary.Severity.critical, result.rows.get(0).severity);
        assertTrue(result.rows.get(0).unread);
        assertEquals("許可", result.rows.get(1).category.label);
        assertFalse(result.rows.get(1).unread);
        assertEquals("件数 2／未読 1／重大 1\n仕事・重大・未読\n許可・情報・既読", result.displayText());

        DesktopNotificationSummary empty = parse(envelope(body(List.of(), 0, 0)));
        assertEquals(0, empty.rows.size());
    }

    @Test
    public void refusesUnboundOrNonObservationResponses() throws Exception {
        Map<String, Object> response = envelope(body(List.of(), 0, 0));
        response.put("request_id", "2".repeat(32));
        assertThrows(PairingResponseParser.PairingUnknownException.class, () -> parse(response));
        response.put("request_id", NONCE);
        response.put("operation", "通知既読");
        assertThrows(PairingResponseParser.PairingUnknownException.class, () -> parse(response));
        response.put("operation", DesktopNotificationSummary.OPERATION);
        response.put("evidence_source", "LIVE_RUNTIME");
        assertThrows(PairingResponseParser.PairingUnknownException.class, () -> parse(response));
    }

    @Test
    public void rejectsCountMismatchesDuplicateRowsAndUnexpectedAuthority() {
        Map<String, Object> row = row(1, "Recovery", "warning", "unread");
        assertThrows(StrictJson.JsonException.class, () -> parse(envelope(body(List.of(row), 0, 0))));
        assertThrows(StrictJson.JsonException.class, () -> parse(envelope(body(List.of(row), 1, 1))));
        assertThrows(StrictJson.JsonException.class, () -> parse(envelope(body(List.of(row, row), 2, 0))));
        assertThrows(StrictJson.JsonException.class,
                () -> parse(envelope(body(Collections.nCopies(17, row), 17, 0))));

        Map<String, Object> mismatchedOrder = new LinkedHashMap<>(row);
        mismatchedOrder.put("作成順", 2);
        assertThrows(StrictJson.JsonException.class, () -> parse(envelope(body(List.of(mismatchedOrder), 1, 0))));

        Map<String, Object> responseBody = body(List.of(row), 1, 0);
        responseBody.put("権限生成", "許可");
        assertThrows(StrictJson.JsonException.class, () -> parse(envelope(responseBody)));
        row.put("approval_token", "synthetic-hidden-metadata");
        assertThrows(StrictJson.JsonException.class, () -> parse(envelope(body(List.of(row), 1, 0))));
    }

    private static DesktopNotificationSummary parse(Map<String, Object> response) throws Exception {
        return DesktopNotificationSummary.parse(new DeviceLinkTransport.Exchange(NONCE, StrictJson.encode(response)));
    }

    private static Map<String, Object> envelope(Map<String, Object> body) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("request_id", NONCE);
        response.put("operation", DesktopNotificationSummary.OPERATION);
        response.put("status", "accepted");
        response.put("evidence_source", "INTERNAL_STATE");
        response.put("audit_event_id", "broker-audit-37");
        response.put("error", null);
        response.put("health", null);
        response.put("body", body);
        response.put("shutdown_requested", false);
        return response;
    }

    private static Map<String, Object> body(List<Map<String, Object>> rows, int unread, int critical) {
        return new LinkedHashMap<>(Map.of("版", 1, "通知一覧", rows, "件数", rows.size(), "未読件数", unread,
                "重大件数", critical, "証拠種別", "INTERNAL_STATE", "表示範囲", "summary", "権限生成", "なし",
                "操作", "navigation_only"));
    }

    private static Map<String, Object> row(int index, String category, String severity, String state) {
        String hash = "sha256:" + "a".repeat(64);
        return new LinkedHashMap<>(Map.ofEntries(Map.entry("版", 1),
                Map.entry("通知ID", "notification-broker-audit-" + index), Map.entry("source", category),
                Map.entry("severity", severity), Map.entry("タイトル", "表示に含めない合成タイトル"),
                Map.entry("概要", "表示に含めない合成本文"), Map.entry("作成順", index),
                Map.entry("関連監査ID", "broker-audit-" + index), Map.entry("関連監査hash", hash),
                Map.entry("遷移先", "permission"), Map.entry("状態", state), Map.entry("通知hash", hash),
                Map.entry("表示範囲", "summary"), Map.entry("権限生成", "なし")));
    }
}
