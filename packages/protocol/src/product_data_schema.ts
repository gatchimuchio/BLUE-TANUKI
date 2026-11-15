/**
 * Product-wide persisted data compatibility contract.
 *
 * Bump this version whenever any BLUE-TANUKI product-managed persisted
 * representation changes. Installers permit retained-data reuse only when the
 * installed marker and candidate package declare the same version. No automatic
 * migration is supported by this contract.
 */
export const PRODUCT_DATA_SCHEMA_VERSION = 1 as const;
