export const PRODUCT_SCOPE_SCHEMA_VERSION = 1 as const;

export const PRODUCT_SCOPE_CORE_RELEASE_PATHS = [
  "packages/hds-brain",
  "packages/protocol",
  "packages/blue-tanuki",
  "packages/channel-base",
  "packages/channel-webchat",
  "packages/channel-telegram",
  "packages/operator-daily",
  "packages/operator-developer",
  "packages/operator-writing",
  "apps/gateway",
] as const;

export const PRODUCT_SCOPE_PREVIEW_PATHS = [
  "packages/channel-slack",
  "packages/channel-discord",
  "packages/channel-teams",
  "packages/channel-line",
  "install/installer",
  "install/windows/install.ps1",
  "install/windows/uninstall.ps1",
] as const;

export const PRODUCT_SCOPE_RELEASE_INSTALLER_PATHS = [
  "INSTALL_WINDOWS.cmd",
  "INSTALL_WINDOWS.ps1",
  "INSTALL.sh",
  "INSTALL_LINUX.desktop",
  "INSTALL_LINUX.sh",
  "INSTALL_MACOS.command",
  "INSTALL_MACOS.sh",
  "install/linux/install.sh",
  "install/linux/uninstall.sh",
  "install/macos/install.sh",
  "install/macos/uninstall.sh",
  "install/resident/README.md",
  "install/resident/blue-tanuki-resident.ps1",
  "install/resident/blue-tanuki-resident.sh",
  "install/unix/product/BlueTanukiSetup.sh",
  "install/unix/product/BlueTanukiLauncher.sh",
  "install/unix/product/BlueTanukiUninstall.sh",
  "install/windows/product/BlueTanukiSetup.cmd",
  "install/windows/product/BlueTanukiSetup.ps1",
  "install/windows/product/BlueTanukiLauncher.ps1",
  "install/windows/product/BlueTanukiUninstall.ps1",
] as const;

export const PRODUCT_SCOPE_STATUS = {
  operators: "core_layer_a_first_party",
  windows_product_installer: "core_release_installer_artifact",
  windows_source_installer: "preview_not_release_claim",
  guided_installer_helper: "preview_not_release_claim",
  preview_channels: "preview_not_core_release",
} as const;

export type ProductScopeCoreReleasePath =
  (typeof PRODUCT_SCOPE_CORE_RELEASE_PATHS)[number];

export type ProductScopePreviewPath =
  (typeof PRODUCT_SCOPE_PREVIEW_PATHS)[number];

export type ProductScopeReleaseInstallerPath =
  (typeof PRODUCT_SCOPE_RELEASE_INSTALLER_PATHS)[number];
