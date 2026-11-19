package com.bluetanuki.mobile;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class MobileTaskContract {
    private static final String REQUEST_ID_PATTERN = "^[a-f0-9]{32}$";
    private static final String HASH_PATTERN = "^sha256:[a-f0-9]{64}$";
    static final int MAX_INSTRUCTION_UNICODE_SCALARS = 32_768;

    private MobileTaskContract() {}

    static Map<String, Object> sessionStartPayload(String runtimeID, String workspaceID)
            throws StrictJson.JsonException {
        if (!validRegisteredIdentifier(runtimeID) || !validRegisteredIdentifier(workspaceID)) {
            throw new StrictJson.JsonException();
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("実行系ID", runtimeID);
        payload.put("作業領域ID", workspaceID);
        return payload;
    }

    static List<String> runtimes(Map<String, Object> body) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "実行系") || !(body.get("実行系") instanceof List<?>)) {
            throw new StrictJson.JsonException();
        }
        List<?> values = (List<?>) body.get("実行系");
        if (values.size() > 128) throw new StrictJson.JsonException();
        List<String> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Object value : values) {
            if (!(value instanceof String)) throw new StrictJson.JsonException();
            String id = (String) value;
            if (!validRegisteredIdentifier(id) || !seen.add(id)) throw new StrictJson.JsonException();
            result.add(id);
        }
        return result;
    }

    static List<Workspace> workspaces(Map<String, Object> body) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "作業領域") || !(body.get("作業領域") instanceof List<?>)) {
            throw new StrictJson.JsonException();
        }
        List<?> rows = (List<?>) body.get("作業領域");
        if (rows.size() > 16) throw new StrictJson.JsonException();
        List<Workspace> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Object raw : rows) {
            Map<String, Object> row = StrictJson.object(raw);
            if (!StrictJson.hasExactKeys(row, "作業領域ID", "実行系ID")) throw new StrictJson.JsonException();
            String workspaceID = StrictJson.string(row, "作業領域ID");
            String runtimeID = StrictJson.string(row, "実行系ID");
            if (!validRegisteredIdentifier(workspaceID) || !validRegisteredIdentifier(runtimeID) ||
                    !seen.add(workspaceID)) throw new StrictJson.JsonException();
            result.add(new Workspace(workspaceID, runtimeID));
        }
        return result;
    }

    static String sessionID(Map<String, Object> body, String runtimeID) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "実行系ID", "状態", "対話セッションID") ||
                !runtimeID.equals(StrictJson.string(body, "実行系ID")) ||
                !"利用中".equals(StrictJson.string(body, "状態"))) throw new StrictJson.JsonException();
        String sessionID = StrictJson.string(body, "対話セッションID");
        if (!validRequestID(sessionID)) throw new StrictJson.JsonException();
        return sessionID;
    }

    static Map<String, Object> requestPayload(String runtimeID, String sessionID, String workspaceID,
                                              String instruction, String mcpCapabilityHash)
            throws StrictJson.JsonException {
        validateInstruction(instruction);
        if (!validAgentTaskIdentifier(runtimeID) || !validAgentTaskIdentifier(workspaceID) ||
                !validRequestID(sessionID) ||
                (mcpCapabilityHash != null && !mcpCapabilityHash.matches(HASH_PATTERN))) {
            throw new StrictJson.JsonException();
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("agent_runtime_id", runtimeID);
        payload.put("session_id", sessionID);
        payload.put("workspace_id", workspaceID);
        payload.put("instruction", instruction);
        if (mcpCapabilityHash != null) payload.put("mcp_capability_snapshot_hash", mcpCapabilityHash);
        return payload;
    }

    static void validateInstruction(String instruction) throws StrictJson.JsonException {
        if (instruction == null || instruction.trim().isEmpty() ||
                instructionUnicodeScalarCount(instruction) > MAX_INSTRUCTION_UNICODE_SCALARS) {
            throw new StrictJson.JsonException();
        }
    }

    static int instructionUnicodeScalarCount(String instruction) {
        return instruction.codePointCount(0, instruction.length());
    }

    static Draft submission(Map<String, Object> body, String runtimeID, String sessionID,
                            String workspaceID) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "版", "申請ID", "状態", "実行系ID", "対話セッションID",
                "作業領域ID", "指示hash", "期限") ||
                StrictJson.integer(body, "版") != 1 ||
                !"Owner確認待ち".equals(StrictJson.string(body, "状態")) ||
                !runtimeID.equals(StrictJson.string(body, "実行系ID")) ||
                !sessionID.equals(StrictJson.string(body, "対話セッションID")) ||
                !workspaceID.equals(StrictJson.string(body, "作業領域ID"))) {
            throw new StrictJson.JsonException();
        }
        String id = StrictJson.string(body, "申請ID");
        String hash = StrictJson.string(body, "指示hash");
        long expiresAt = StrictJson.integer(body, "期限");
        if (!validRequestID(id) || !hash.matches(HASH_PATTERN) || expiresAt <= 900) {
            throw new StrictJson.JsonException();
        }
        return new Draft(id, runtimeID, sessionID, workspaceID, hash, expiresAt - 900,
                expiresAt, null);
    }

    static List<Draft> ownRequests(Map<String, Object> body) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "申請") || !(body.get("申請") instanceof List<?>)) {
            throw new StrictJson.JsonException();
        }
        List<?> rows = (List<?>) body.get("申請");
        if (rows.size() > 16) throw new StrictJson.JsonException();
        List<Draft> result = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Object raw : rows) {
            Draft draft = parseOwnRequest(StrictJson.object(raw));
            if (!ids.add(draft.id)) throw new StrictJson.JsonException();
            result.add(draft);
        }
        return result;
    }

    static TaskStatus status(Map<String, Object> body, Draft draft) throws StrictJson.JsonException {
        if (!draft.id.equals(StrictJson.string(body, "申請ID"))) throw new StrictJson.JsonException();
        String state = StrictJson.string(body, "状態");
        if ("Owner確認待ち".equals(state)) {
            if (!StrictJson.hasExactKeys(body, "申請ID", "状態")) throw new StrictJson.JsonException();
            return TaskStatus.ownerReviewPending();
        }
        if ("開始候補".equals(state)) {
            if (!StrictJson.hasExactKeys(body, "申請ID", "状態")) throw new StrictJson.JsonException();
            return TaskStatus.startCandidate();
        }
        if ("Task状態".equals(state)) {
            if (!StrictJson.hasExactKeys(body, "申請ID", "状態", "Task")) throw new StrictJson.JsonException();
            TaskRecord record = taskRecord(StrictJson.object(body.get("Task")));
            if (!matches(record, draft)) throw new StrictJson.JsonException();
            return TaskStatus.task(record);
        }
        throw new StrictJson.JsonException();
    }

    static TaskRecord started(Map<String, Object> body, Draft draft) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "申請ID", "状態", "Task") ||
                !draft.id.equals(StrictJson.string(body, "申請ID")) ||
                !"Task開始済み".equals(StrictJson.string(body, "状態"))) throw new StrictJson.JsonException();
        TaskRecord record = taskRecord(StrictJson.object(body.get("Task")));
        if (!matches(record, draft)) throw new StrictJson.JsonException();
        return record;
    }

    static TaskRecord cancellationRequested(Map<String, Object> body, Draft draft)
            throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "申請ID", "状態", "Task") ||
                !draft.id.equals(StrictJson.string(body, "申請ID")) ||
                !"Task取消要求済み".equals(StrictJson.string(body, "状態"))) throw new StrictJson.JsonException();
        TaskRecord record = taskRecord(StrictJson.object(body.get("Task")));
        if (!matches(record, draft)) throw new StrictJson.JsonException();
        return record;
    }

    static McpSnapshot mcpSnapshot(Map<String, Object> body) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "版", "Agent能力hash", "Agent能力件数", "Agent能力状態", "公開範囲") ||
                StrictJson.integer(body, "版") != 1 ||
                !"metadata_only".equals(StrictJson.string(body, "公開範囲"))) throw new StrictJson.JsonException();
        long count = StrictJson.integer(body, "Agent能力件数");
        String state = StrictJson.string(body, "Agent能力状態");
        Object rawHash = body.get("Agent能力hash");
        String hash = rawHash == null ? null : StrictJson.string(body, "Agent能力hash");
        if (count < 0 || count > 128 ||
                ("available".equals(state) && (hash == null || !hash.matches(HASH_PATTERN))) ||
                ("unsupported".equals(state) && (hash != null || count != 0)) ||
                (!"available".equals(state) && !"unsupported".equals(state))) {
            throw new StrictJson.JsonException();
        }
        return new McpSnapshot(hash, (int) count, state);
    }

    static boolean validRequestID(String value) {
        return value != null && value.matches(REQUEST_ID_PATTERN);
    }

    static boolean validRegisteredIdentifier(String value) {
        if (value == null || value.length() < 1 || value.length() > 128 || !isAsciiAlphaNumeric(value.charAt(0))) return false;
        for (int index = 1; index < value.length(); index++) {
            char current = value.charAt(index);
            if (!isAsciiAlphaNumeric(current) && current != '_' && current != '.' && current != '-') return false;
        }
        return true;
    }

    private static Draft parseOwnRequest(Map<String, Object> row) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(row, "申請ID", "実行系ID", "対話セッションID", "作業領域ID",
                "指示hash", "作成時刻", "期限", "task_id")) throw new StrictJson.JsonException();
        String id = StrictJson.string(row, "申請ID");
        String runtimeID = StrictJson.string(row, "実行系ID");
        String sessionID = StrictJson.string(row, "対話セッションID");
        String workspaceID = StrictJson.string(row, "作業領域ID");
        String hash = StrictJson.string(row, "指示hash");
        long createdAt = StrictJson.integer(row, "作成時刻");
        long expiresAt = StrictJson.integer(row, "期限");
        Object rawTaskID = row.get("task_id");
        String taskID = rawTaskID == null ? null : StrictJson.string(row, "task_id");
        if (!validRequestID(id) || !validRegisteredIdentifier(runtimeID) || !validRequestID(sessionID) ||
                !validRegisteredIdentifier(workspaceID) || !hash.matches(HASH_PATTERN) || createdAt <= 0 ||
                expiresAt <= createdAt || (taskID != null && !validRequestID(taskID))) {
            throw new StrictJson.JsonException();
        }
        return new Draft(id, runtimeID, sessionID, workspaceID, hash, createdAt, expiresAt, taskID);
    }

    private static TaskRecord taskRecord(Map<String, Object> body) throws StrictJson.JsonException {
        if (!StrictJson.hasExactKeys(body, "task_id", "実行系ID", "対話セッションID", "作業領域ID",
                "指示hash", "状態", "結果hash", "結果本文あり")) throw new StrictJson.JsonException();
        String taskID = StrictJson.string(body, "task_id");
        String runtimeID = StrictJson.string(body, "実行系ID");
        String sessionID = StrictJson.string(body, "対話セッションID");
        String workspaceID = StrictJson.string(body, "作業領域ID");
        String instructionHash = StrictJson.string(body, "指示hash");
        String state = StrictJson.string(body, "状態");
        Object rawResultHash = body.get("結果hash");
        String resultHash = rawResultHash == null ? null : StrictJson.string(body, "結果hash");
        Object resultContent = body.get("結果本文あり");
        if (!(resultContent instanceof Boolean) || !validRequestID(taskID) ||
                !validRegisteredIdentifier(runtimeID) || !validRequestID(sessionID) ||
                !validRegisteredIdentifier(workspaceID) || !instructionHash.matches(HASH_PATTERN) ||
                !isKnownTaskState(state) ||
                (resultHash != null && !resultHash.matches(HASH_PATTERN))) throw new StrictJson.JsonException();
        return new TaskRecord(taskID, runtimeID, sessionID, workspaceID, instructionHash, state,
                resultHash, (Boolean) resultContent);
    }

    static boolean matches(TaskRecord record, Draft draft) {
        return record.runtimeID.equals(draft.runtimeID) && record.sessionID.equals(draft.sessionID) &&
                record.workspaceID.equals(draft.workspaceID) && record.instructionHash.equals(draft.instructionHash) &&
                (draft.taskID == null || draft.taskID.equals(record.taskID));
    }

    private static boolean validAgentTaskIdentifier(String value) {
        if (validRegisteredIdentifier(value)) return true;
        if (value == null || value.length() < 1 || value.length() > 128 || !isAsciiAlphaNumeric(value.charAt(0))) return false;
        for (int index = 1; index < value.length(); index++) {
            char current = value.charAt(index);
            if (!isAsciiAlphaNumeric(current) && current != '_' && current != '.' && current != ':' && current != '-') return false;
        }
        return true;
    }

    private static boolean isKnownTaskState(String state) {
        return "pending".equals(state) || "running".equals(state) || "blocked".equals(state) ||
                "completed".equals(state) || "failed".equals(state) || "cancelled".equals(state) ||
                "quarantined".equals(state);
    }

    private static boolean isAsciiAlphaNumeric(char value) {
        return (value >= '0' && value <= '9') || (value >= 'A' && value <= 'Z') ||
                (value >= 'a' && value <= 'z');
    }

    static final class Workspace {
        final String id;
        final String runtimeID;

        Workspace(String id, String runtimeID) { this.id = id; this.runtimeID = runtimeID; }

        @Override public String toString() { return id + " — " + runtimeID; }
    }

    static final class Draft {
        final String id;
        final String runtimeID;
        final String sessionID;
        final String workspaceID;
        final String instructionHash;
        final long createdAt;
        final long expiresAt;
        final String taskID;

        Draft(String id, String runtimeID, String sessionID, String workspaceID, String instructionHash,
              long createdAt, long expiresAt, String taskID) {
            this.id = id; this.runtimeID = runtimeID; this.sessionID = sessionID;
            this.workspaceID = workspaceID; this.instructionHash = instructionHash;
            this.createdAt = createdAt; this.expiresAt = expiresAt; this.taskID = taskID;
        }
    }

    static final class TaskRecord {
        final String taskID;
        final String runtimeID;
        final String sessionID;
        final String workspaceID;
        final String instructionHash;
        final String state;
        final String resultHash;
        final boolean resultContentAvailable;

        TaskRecord(String taskID, String runtimeID, String sessionID, String workspaceID,
                   String instructionHash, String state, String resultHash, boolean resultContentAvailable) {
            this.taskID = taskID; this.runtimeID = runtimeID; this.sessionID = sessionID;
            this.workspaceID = workspaceID; this.instructionHash = instructionHash;
            this.state = state; this.resultHash = resultHash; this.resultContentAvailable = resultContentAvailable;
        }
    }

    static final class TaskStatus {
        static final String OWNER_REVIEW_PENDING = "owner_review_pending";
        static final String START_CANDIDATE = "start_candidate";
        static final String TASK = "task";
        final String kind;
        final TaskRecord task;

        private TaskStatus(String kind, TaskRecord task) { this.kind = kind; this.task = task; }
        static TaskStatus ownerReviewPending() { return new TaskStatus(OWNER_REVIEW_PENDING, null); }
        static TaskStatus startCandidate() { return new TaskStatus(START_CANDIDATE, null); }
        static TaskStatus task(TaskRecord record) { return new TaskStatus(TASK, record); }
    }

    static final class McpSnapshot {
        final String hash;
        final int toolCount;
        final String state;

        McpSnapshot(String hash, int toolCount, String state) {
            this.hash = hash; this.toolCount = toolCount; this.state = state;
        }

        boolean usable() { return "available".equals(state) && hash != null && toolCount > 0; }
    }
}
