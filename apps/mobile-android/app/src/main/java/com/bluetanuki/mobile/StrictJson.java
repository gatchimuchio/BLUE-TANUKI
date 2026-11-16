package com.bluetanuki.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class StrictJson {
    private static final int MAX_DEPTH = 48;
    private static final int MAX_NODES = 100_000;

    private StrictJson() {}

    static Object parse(String source) throws JsonException {
        if (source == null || source.length() > 4 * 1024 * 1024) {
            throw new JsonException();
        }
        Parser parser = new Parser(source);
        Object value = parser.value(0);
        parser.whitespace();
        if (parser.offset != source.length()) {
            throw new JsonException();
        }
        return value;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) throws JsonException {
        if (!(value instanceof Map<?, ?>)) {
            throw new JsonException();
        }
        return (Map<String, Object>) value;
    }

    static boolean hasExactKeys(Map<String, Object> value, String... keys) {
        if (value.size() != keys.length) {
            return false;
        }
        for (String key : keys) {
            if (!value.containsKey(key)) {
                return false;
            }
        }
        return true;
    }

    static String encode(Object value) throws JsonException {
        StringBuilder output = new StringBuilder();
        writeValue(output, value, 0, new int[] { 0 });
        return output.toString();
    }

    private static void writeValue(StringBuilder output, Object value, int depth, int[] nodes)
            throws JsonException {
        if (depth > MAX_DEPTH || ++nodes[0] > MAX_NODES) throw new JsonException();
        if (value == null) {
            output.append("null");
        } else if (value instanceof String) {
            writeString(output, (String) value);
        } else if (value instanceof Boolean) {
            output.append(value);
        } else if (value instanceof Byte || value instanceof Short || value instanceof Integer ||
                value instanceof Long) {
            output.append(value);
        } else if (value instanceof List<?>) {
            List<?> values = (List<?>) value;
            output.append('[');
            for (int index = 0; index < values.size(); index++) {
                if (index > 0) output.append(',');
                writeValue(output, values.get(index), depth + 1, nodes);
            }
            output.append(']');
        } else if (value instanceof Map<?, ?>) {
            Map<?, ?> values = (Map<?, ?>) value;
            output.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : values.entrySet()) {
                if (!(entry.getKey() instanceof String)) throw new JsonException();
                if (!first) output.append(',');
                first = false;
                writeString(output, (String) entry.getKey());
                output.append(':');
                writeValue(output, entry.getValue(), depth + 1, nodes);
            }
            output.append('}');
        } else {
            throw new JsonException();
        }
        if (output.length() > 4 * 1024 * 1024) throw new JsonException();
    }

    private static void writeString(StringBuilder output, String value) throws JsonException {
        output.append('"');
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            switch (current) {
                case '"': output.append("\\\""); break;
                case '\\': output.append("\\\\"); break;
                case '\b': output.append("\\b"); break;
                case '\f': output.append("\\f"); break;
                case '\n': output.append("\\n"); break;
                case '\r': output.append("\\r"); break;
                case '\t': output.append("\\t"); break;
                default:
                    if (current < 0x20) {
                        output.append(String.format("\\u%04x", (int) current));
                    } else if (Character.isHighSurrogate(current)) {
                        if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                            throw new JsonException();
                        }
                        output.append(current).append(value.charAt(++index));
                    } else if (Character.isLowSurrogate(current)) {
                        throw new JsonException();
                    } else {
                        output.append(current);
                    }
            }
        }
        output.append('"');
    }

    static String string(Map<String, Object> value, String key) throws JsonException {
        Object found = value.get(key);
        if (!(found instanceof String)) {
            throw new JsonException();
        }
        return (String) found;
    }

    static long integer(Map<String, Object> value, String key) throws JsonException {
        Object found = value.get(key);
        if (!(found instanceof NumberToken)) {
            throw new JsonException();
        }
        try {
            String raw = ((NumberToken) found).raw;
            if (!raw.matches("-?(0|[1-9][0-9]*)")) {
                throw new JsonException();
            }
            return Long.parseLong(raw);
        } catch (NumberFormatException exception) {
            throw new JsonException();
        }
    }

    private static final class NumberToken {
        final String raw;

        NumberToken(String raw) {
            this.raw = raw;
        }
    }

    static final class JsonException extends Exception {
        JsonException() {
            super("json_invalid");
        }
    }

    private static final class Parser {
        private final String source;
        private int offset;
        private int nodes;

        Parser(String source) {
            this.source = source;
        }

        Object value(int depth) throws JsonException {
            if (depth > MAX_DEPTH || ++nodes > MAX_NODES) {
                throw new JsonException();
            }
            whitespace();
            if (offset >= source.length()) {
                throw new JsonException();
            }
            char current = source.charAt(offset);
            if (current == '{') {
                return objectValue(depth + 1);
            }
            if (current == '[') {
                return arrayValue(depth + 1);
            }
            if (current == '"') {
                return stringValue();
            }
            if (current == 't') {
                literal("true");
                return Boolean.TRUE;
            }
            if (current == 'f') {
                literal("false");
                return Boolean.FALSE;
            }
            if (current == 'n') {
                literal("null");
                return null;
            }
            return numberValue();
        }

        private Map<String, Object> objectValue(int depth) throws JsonException {
            offset++;
            whitespace();
            Map<String, Object> result = new LinkedHashMap<>();
            if (take('}')) {
                return result;
            }
            while (true) {
                whitespace();
                if (offset >= source.length() || source.charAt(offset) != '"') {
                    throw new JsonException();
                }
                String key = stringValue();
                if (result.containsKey(key)) {
                    throw new JsonException();
                }
                whitespace();
                require(':');
                result.put(key, value(depth));
                whitespace();
                if (take('}')) {
                    return result;
                }
                require(',');
            }
        }

        private List<Object> arrayValue(int depth) throws JsonException {
            offset++;
            whitespace();
            List<Object> result = new ArrayList<>();
            if (take(']')) {
                return result;
            }
            while (true) {
                if (result.size() >= MAX_NODES) {
                    throw new JsonException();
                }
                result.add(value(depth));
                whitespace();
                if (take(']')) {
                    return result;
                }
                require(',');
            }
        }

        private String stringValue() throws JsonException {
            require('"');
            StringBuilder result = new StringBuilder();
            while (offset < source.length()) {
                char current = source.charAt(offset++);
                if (current == '"') {
                    return result.toString();
                }
                if (current < 0x20) {
                    throw new JsonException();
                }
                if (current != '\\') {
                    result.append(current);
                } else {
                    if (offset >= source.length()) {
                        throw new JsonException();
                    }
                    char escaped = source.charAt(offset++);
                    switch (escaped) {
                        case '"': result.append('"'); break;
                        case '\\': result.append('\\'); break;
                        case '/': result.append('/'); break;
                        case 'b': result.append('\b'); break;
                        case 'f': result.append('\f'); break;
                        case 'n': result.append('\n'); break;
                        case 'r': result.append('\r'); break;
                        case 't': result.append('\t'); break;
                        case 'u': result.append(unicodeEscape()); break;
                        default: throw new JsonException();
                    }
                }
                if (result.length() > 1_048_576) {
                    throw new JsonException();
                }
            }
            throw new JsonException();
        }

        private char unicodeEscape() throws JsonException {
            if (offset + 4 > source.length()) {
                throw new JsonException();
            }
            int value = 0;
            for (int index = 0; index < 4; index++) {
                int digit = Character.digit(source.charAt(offset++), 16);
                if (digit < 0) {
                    throw new JsonException();
                }
                value = (value << 4) | digit;
            }
            return (char) value;
        }

        private NumberToken numberValue() throws JsonException {
            int start = offset;
            if (take('-') && offset >= source.length()) {
                throw new JsonException();
            }
            if (take('0')) {
                if (offset < source.length() && Character.isDigit(source.charAt(offset))) {
                    throw new JsonException();
                }
            } else {
                digits(true);
            }
            if (take('.')) {
                digits(true);
            }
            if (take('e') || take('E')) {
                if (!take('+')) {
                    take('-');
                }
                digits(true);
            }
            return new NumberToken(source.substring(start, offset));
        }

        private void digits(boolean required) throws JsonException {
            int start = offset;
            while (offset < source.length() && source.charAt(offset) >= '0' && source.charAt(offset) <= '9') {
                offset++;
            }
            if (required && start == offset) {
                throw new JsonException();
            }
        }

        private void literal(String literal) throws JsonException {
            if (!source.startsWith(literal, offset)) {
                throw new JsonException();
            }
            offset += literal.length();
        }

        private void whitespace() {
            while (offset < source.length()) {
                char current = source.charAt(offset);
                if (current == ' ' || current == '\t' || current == '\r' || current == '\n') {
                    offset++;
                } else {
                    return;
                }
            }
        }

        private boolean take(char expected) {
            if (offset < source.length() && source.charAt(offset) == expected) {
                offset++;
                return true;
            }
            return false;
        }

        private void require(char expected) throws JsonException {
            if (!take(expected)) {
                throw new JsonException();
            }
        }
    }
}
