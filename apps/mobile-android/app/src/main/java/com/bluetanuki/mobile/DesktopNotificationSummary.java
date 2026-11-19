package com.bluetanuki.mobile;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

final class DesktopNotificationSummary {
    static final String OPERATION = "通知一覧";
    static final int MAX_NOTIFICATIONS = 16;
    private static final Pattern HASH = Pattern.compile("sha256:[a-f0-9]{64}");
    private static final Set<String> NAVIGATION = new HashSet<>(Arrays.asList("dashboard", "approval",
            "permission", "runtime", "audit", "recovery", "device", "agent", "settings", "evaluation"));

    enum Category {
        Runtime("実行系"), Task("仕事"), Permission("許可"), Approval("承認"), Audit("監査"),
        Recovery("復旧"), Device("端末"), MCP("MCP"), A2A("A2A"), Update("更新"), Evaluation("評価");

        final String label;
        Category(String label) { this.label = label; }
    }

    enum Severity {
        info("情報"), warning("注意"), error("エラー"), critical("重大");

        final String label;
        Severity(String label) { this.label = label; }
    }

    static final class Row {
        final Category category;
        final Severity severity;
        final boolean unread;

        Row(Category category, Severity severity, boolean unread) {
            this.category = category;
            this.severity = severity;
            this.unread = unread;
        }
    }

    final List<Row> rows;
    final int unreadCount;
    final int criticalCount;

    private DesktopNotificationSummary(List<Row> rows, int unreadCount, int criticalCount) {
        this.rows = Collections.unmodifiableList(rows);
        this.unreadCount = unreadCount;
        this.criticalCount = criticalCount;
    }

    static Map<String, Object> request() {
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("版", 1);
        content.put("未読のみ", false);
        content.put("上限", MAX_NOTIFICATIONS);
        return content;
    }

    static DesktopNotificationSummary parse(DeviceLinkTransport.Exchange exchange)
            throws PairingResponseParser.PairingRejectedException, PairingResponseParser.PairingUnknownException,
            StrictJson.JsonException {
        Map<String, Object> body = PairingResponseParser.acceptedResponse(exchange.response, exchange.nonce,
                OPERATION, Collections.singleton("INTERNAL_STATE")).body;
        if (!StrictJson.hasExactKeys(body, "版", "通知一覧", "件数", "未読件数", "重大件数", "証拠種別", "表示範囲", "権限生成", "操作") ||
                StrictJson.integer(body, "版") != 1 || !"INTERNAL_STATE".equals(body.get("証拠種別")) ||
                !"summary".equals(body.get("表示範囲")) || !"なし".equals(body.get("権限生成")) ||
                !"navigation_only".equals(body.get("操作")) || !(body.get("通知一覧") instanceof List<?>)) {
            throw new StrictJson.JsonException();
        }
        List<?> entries = (List<?>) body.get("通知一覧");
        if (entries.size() > MAX_NOTIFICATIONS || StrictJson.integer(body, "件数") != entries.size()) {
            throw new StrictJson.JsonException();
        }

        List<Row> rows = new ArrayList<>(entries.size());
        Set<String> seen = new HashSet<>();
        int unreadCount = 0;
        int criticalCount = 0;
        for (Object entry : entries) {
            Map<String, Object> value = StrictJson.object(entry);
            long createdOrder = StrictJson.integer(value, "作成順");
            if (!StrictJson.hasExactKeys(value, "版", "通知ID", "source", "severity", "タイトル", "概要", "作成順",
                    "関連監査ID", "関連監査hash", "遷移先", "状態", "通知hash", "表示範囲", "権限生成") ||
                    StrictJson.integer(value, "版") != 1 || createdOrder < 1 ||
                    !"summary".equals(value.get("表示範囲")) || !"なし".equals(value.get("権限生成")) ||
                    !NAVIGATION.contains(value.get("遷移先")) || !boundedText(value, "タイトル", 128) ||
                    !boundedText(value, "概要", 512) || !boundedText(value, "関連監査ID", 128) ||
                    !HASH.matcher(StrictJson.string(value, "関連監査hash")).matches() ||
                    !HASH.matcher(StrictJson.string(value, "通知hash")).matches()) {
                throw new StrictJson.JsonException();
            }
            String id = StrictJson.string(value, "通知ID");
            if (!id.equals("notification-broker-audit-" + createdOrder) || !seen.add(id)) throw new StrictJson.JsonException();
            final Category category;
            final Severity severity;
            try {
                category = Category.valueOf(StrictJson.string(value, "source"));
                severity = Severity.valueOf(StrictJson.string(value, "severity"));
            } catch (IllegalArgumentException ignored) {
                throw new StrictJson.JsonException();
            }
            String state = StrictJson.string(value, "状態");
            if (!"unread".equals(state) && !"read".equals(state)) throw new StrictJson.JsonException();
            boolean unread = "unread".equals(state);
            if (unread) unreadCount++;
            if (severity == Severity.critical) criticalCount++;
            rows.add(new Row(category, severity, unread));
        }
        if (StrictJson.integer(body, "未読件数") != unreadCount || StrictJson.integer(body, "重大件数") != criticalCount) {
            throw new StrictJson.JsonException();
        }
        return new DesktopNotificationSummary(rows, unreadCount, criticalCount);
    }

    String displayText() {
        StringBuilder display = new StringBuilder("件数 ").append(rows.size())
                .append("／未読 ").append(unreadCount).append("／重大 ").append(criticalCount);
        for (Row row : rows) {
            display.append('\n').append(row.category.label).append("・").append(row.severity.label)
                    .append("・").append(row.unread ? "未読" : "既読");
        }
        return display.toString();
    }

    private static boolean boundedText(Map<String, Object> value, String key, int maximum) throws StrictJson.JsonException {
        String text = StrictJson.string(value, key);
        return !text.isEmpty() && text.codePointCount(0, text.length()) <= maximum;
    }
}
