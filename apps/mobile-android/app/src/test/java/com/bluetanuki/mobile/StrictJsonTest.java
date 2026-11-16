package com.bluetanuki.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Map;
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
}
