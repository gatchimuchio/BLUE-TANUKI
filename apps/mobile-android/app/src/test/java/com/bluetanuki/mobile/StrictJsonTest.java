package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import java.util.Map;
import java.util.LinkedHashMap;
import org.junit.Test;

public final class StrictJsonTest {
    @Test
    public void rejectsDuplicateKeysAtEveryDepth() {
        assertThrows(StrictJson.JsonException.class,
                () -> StrictJson.parse("{\"request_id\":\"one\",\"request_id\":\"two\"}"));
        assertThrows(StrictJson.JsonException.class,
                () -> StrictJson.parse("{\"body\":{\"status\":\"accepted\",\"status\":\"rejected\"}}"));
    }

    @Test
    public void rejectsTrailingDataAndNonJsonNumbers() {
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.parse("{}{}"));
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.parse("{\"n\":01}"));
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.parse("{\"n\":NaN}"));
    }

    @Test
    public void integerFieldsRejectFractionAndExponentForms() throws Exception {
        Map<String, Object> fractional = StrictJson.object(StrictJson.parse("{\"v\":1.0}"));
        Map<String, Object> exponential = StrictJson.object(StrictJson.parse("{\"v\":1e0}"));
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.integer(fractional, "v"));
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.integer(exponential, "v"));
        assertEquals(37L, StrictJson.integer(
                StrictJson.object(StrictJson.parse("{\"v\":37}")), "v"));
    }

    @Test
    public void encoderRoundTripsEscapesAndSupplementaryUnicode() throws Exception {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("本文", "引用\"符\\と改行\nと絵文字😀");
        value.put("有効", true);
        value.put("null", null);
        String encoded = StrictJson.encode(value);
        Map<String, Object> decoded = StrictJson.object(StrictJson.parse(encoded));
        assertEquals(value.get("本文"), StrictJson.string(decoded, "本文"));
        assertEquals(Boolean.TRUE, decoded.get("有効"));
        assertTrue(decoded.containsKey("null"));
        assertEquals(null, decoded.get("null"));
    }

    @Test
    public void encoderRejectsUnpairedSurrogatesAndUnsupportedNumbers() {
        String unpaired = new String(new char[] { 0xD800 });
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.encode(unpaired));
        assertThrows(StrictJson.JsonException.class, () -> StrictJson.encode(1.5d));
    }
}
