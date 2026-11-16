import { requiredCapabilitiesForSurface } from "@blue-tanuki/protocol";

export const DAILY_OPERATOR_REQUIRED_PERMISSIONS = requiredCapabilitiesForSurface("daily");
// Settings writes remain core HDS L3 operations; neither capability label is a plugin manifest permission.
export const DEVELOPER_OPERATOR_REQUIRED_PERMISSIONS = Object.freeze(
  requiredCapabilitiesForSurface("developer").filter((permission) =>
    permission !== "settings:write" && permission !== "tool:settings.write"),
);
export const WRITING_OPERATOR_REQUIRED_PERMISSIONS = requiredCapabilitiesForSurface("writing");
