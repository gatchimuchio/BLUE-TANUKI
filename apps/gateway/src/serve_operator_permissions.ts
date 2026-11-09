import { requiredCapabilitiesForSurface } from "@blue-tanuki/protocol";

export const DAILY_OPERATOR_REQUIRED_PERMISSIONS = requiredCapabilitiesForSurface("daily");
// settings:write remains an HDS operation capability for L3 review; it is not a plugin manifest permission.
export const DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS = Object.freeze(
  requiredCapabilitiesForSurface("developer").filter((permission) => permission !== "settings:write"),
);
export const WRITING_OPERATOR_REQUIRED_PERMISSIONS = requiredCapabilitiesForSurface("writing");
